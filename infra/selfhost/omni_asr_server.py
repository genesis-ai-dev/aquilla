# Aquilla Omnilingual ASR — self-hosted server with the same HTTP contract as
# the Modal web app in infra/modal/omni_asr.py:
#   POST /transcribe {model: "ctc"|"zs", audio: base64, lang?, examples?}
#   GET  /status?model=ctc|zs        POST /warm {model}
# Every route checks the X-Omni-Secret header. Models load once at startup and
# stay in memory, so there is no cold start. The auth-worker calls this server
# first (OMNI_ASR_PRIMARY_URL) and falls back to Modal on a network error or 5xx.
#
# Decoding, alignment and the example fetch are imported from the Modal file,
# so both backends return the same words and timings. That import needs the
# `modal` package installed, but no Modal account: nothing at module level
# calls Modal.
#
# Env:
#   OMNI_SHARED_SECRET   required; the same value as the auth-worker's.
#   OMNI_CTC_MODEL       omniASR_CTC_1B (default) or omniASR_CTC_300M. With
#                        300M the aligner IS the model: one forward pass gives
#                        both the text and the word timings.
#   OMNI_CTC_DEVICE      cuda:0 (default when CUDA exists) or cpu.
#   OMNI_ZS_DEVICE       cuda:1 (default when 2+ GPUs exist) or off. When ZS is
#                        off, ZS routes answer 503 and the worker uses Modal.
#   OMNI_CTC_QUANTIZE    int8 — dynamic int8 Linear layers; CPU only.
#   OMNI_EXAMPLE_HOSTS   optional allow-list for ZS example URLs (as on Modal).
#
# Run: uvicorn omni_asr_server:app --host 127.0.0.1 --port 8088
# Deploy guide: infra/selfhost/README.md

import base64
import hmac
import os
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path

import torch
from fastapi import FastAPI, Header, HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "modal"))
from omni_asr import (  # noqa: E402
    EST_GPU_SEC_PER_AUDIO_SEC, MAX_AUDIO_SEC, MAX_CONTEXT_SEC, MAX_EXAMPLES, SAMPLE_RATE,
    _Aligner, _decode_wav, _fetch_example,
)

ALIGNER_CARD = "omniASR_CTC_300M"
# Billing prices CPU work under this name (db/shared/omni-asr-cost.ts).
CPU_LABEL = "self-hosted-cpu"


def device_label(device: torch.device) -> str:
    """The `gpu` value the worker bills on: the real CUDA device name."""
    return torch.cuda.get_device_name(device) if device.type == "cuda" else CPU_LABEL


def quantize_int8(model: torch.nn.Module) -> torch.nn.Module:
    """Dynamic int8 quantization of every Linear layer. fairseq2's Linear is
    not a torch.nn.Linear, so quantize_dynamic would skip it; swap each one
    for an nn.Linear with the same weights first (both compute F.linear)."""
    from fairseq2.nn import Linear as F2Linear

    for parent in list(model.modules()):
        for name, child in list(parent.named_children()):
            if isinstance(child, F2Linear):
                lin = torch.nn.Linear(child.input_dim, child.output_dim, bias=child.bias is not None)
                lin.weight = child.weight
                if child.bias is not None:
                    lin.bias = child.bias
                setattr(parent, name, lin)
    return torch.ao.quantization.quantize_dynamic(model, {torch.nn.Linear}, dtype=torch.qint8)


def _greedy_text(aligner: _Aligner, emis: torch.Tensor) -> str:
    """CTC greedy decode of log-probs [T, V], as upstream's
    _apply_model_wav2vec2asr does: collapse repeats; the decoder drops blanks."""
    ids = emis.argmax(dim=-1)
    keep = torch.ones_like(ids, dtype=torch.bool)
    keep[1:] = ids[1:] != ids[:-1]
    return aligner.pipe.token_decoder(ids[keep]).strip()


class CTC:
    def __init__(self, card: str, device: torch.device, quantize: str | None) -> None:
        from omnilingual_asr.models.inference.pipeline import ASRInferencePipeline

        # bf16 on GPU as on Modal; CPU kernels want fp32 (and int8 needs it).
        dtype = torch.bfloat16 if device.type == "cuda" else torch.float32
        self.aligner = _Aligner(device=device, dtype=dtype)
        # 300M: the aligner's model transcribes too, so load it only once.
        self.pipe = None if card == ALIGNER_CARD else ASRInferencePipeline(
            model_card=card, device=device, dtype=dtype)
        if quantize == "int8":
            if device.type != "cpu":
                raise ValueError("OMNI_CTC_QUANTIZE=int8 is CPU-only")
            self.aligner.pipe.model = quantize_int8(self.aligner.pipe.model)
            if self.pipe is not None:
                self.pipe.model = quantize_int8(self.pipe.model)
        self.device = device
        self.lock = threading.Lock()

    def transcribe(self, wav: torch.Tensor, lang: str | None) -> tuple[str, list[dict], bool]:
        if self.pipe is None:
            emis = self.aligner.emissions(wav)
            text = _greedy_text(self.aligner, emis)
            return (text, *self.aligner.align(wav, text, emis))
        text = self.pipe.transcribe([{"waveform": wav, "sample_rate": SAMPLE_RATE}],
                                    lang=[lang], batch_size=1)[0]
        return (text, *self.aligner.align(wav, text))


class ZS:
    def __init__(self, device: torch.device, aligner: _Aligner) -> None:
        from omnilingual_asr.models.inference.pipeline import ASRInferencePipeline

        self.pipe = ASRInferencePipeline(model_card="omniASR_LLM_7B_ZS", device=device)
        # Alignment is cheap; share the CTC side's aligner rather than load a
        # second copy next to the 7B model.
        self.aligner = aligner
        self.device = device
        self.lock = threading.Lock()

    def transcribe(self, wav: torch.Tensor, examples: list[tuple[bytes, str]]) -> tuple[str, list[dict], bool]:
        from omnilingual_asr.models.inference.pipeline import ContextExample

        ctx = [ContextExample({"waveform": _decode_wav(data)[: MAX_CONTEXT_SEC * SAMPLE_RATE],
                               "sample_rate": SAMPLE_RATE}, text)
               for data, text in examples[:MAX_EXAMPLES]]
        text = self.pipe.transcribe_with_context(
            [{"waveform": wav, "sample_rate": SAMPLE_RATE}], context_examples=[ctx], batch_size=1,
        )[0].strip()
        return (text, *self.aligner.align(wav, text))


def _default_devices() -> tuple[str, str]:
    n = torch.cuda.device_count()
    return ("cuda:0" if n else "cpu"), ("cuda:1" if n >= 2 else "off")


models: dict[str, CTC | ZS] = {}


def load_models() -> None:
    ctc_default, zs_default = _default_devices()
    ctc_dev = torch.device(os.environ.get("OMNI_CTC_DEVICE", ctc_default))
    zs_dev = os.environ.get("OMNI_ZS_DEVICE", zs_default)
    t0 = time.time()
    models["ctc"] = CTC(os.environ.get("OMNI_CTC_MODEL", "omniASR_CTC_1B"), ctc_dev,
                        os.environ.get("OMNI_CTC_QUANTIZE") or None)
    print(f"[ctc] loaded in {time.time() - t0:.1f}s on {device_label(ctc_dev)}", flush=True)
    if zs_dev != "off":
        t0 = time.time()
        models["zs"] = ZS(torch.device(zs_dev), models["ctc"].aligner)
        print(f"[zs] loaded in {time.time() - t0:.1f}s on {device_label(torch.device(zs_dev))}", flush=True)


@asynccontextmanager
async def lifespan(_: FastAPI):
    if not os.environ.get("OMNI_SHARED_SECRET"):
        raise RuntimeError("OMNI_SHARED_SECRET is not set")
    # Load before accepting requests: until then the port is closed, and the
    # worker's short connect timeout sends traffic to Modal.
    load_models()
    yield


app = FastAPI(lifespan=lifespan)


def check(secret: str | None) -> None:
    if not hmac.compare_digest((secret or "").encode(), os.environ["OMNI_SHARED_SECRET"].encode()):
        raise HTTPException(status_code=401, detail="bad shared secret")


def model_or_503(model: str | None) -> CTC | ZS:
    if model not in ("ctc", "zs"):
        raise HTTPException(status_code=400, detail="model must be ctc or zs")
    if model not in models:
        # 5xx on purpose: the worker falls back to Modal, which has ZS.
        raise HTTPException(status_code=503, detail=f"{model} is not served here")
    return models[model]


def status_body(model: str) -> dict:
    return {"state": "ready", "estGpuSecPerAudioSec": float(
        os.environ.get(f"OMNI_EST_{model.upper()}", EST_GPU_SEC_PER_AUDIO_SEC[model]))}


@app.get("/healthz")
def healthz() -> dict:
    return {"ok": True, "models": sorted(models)}


@app.get("/status")
def status(model: str = "zs", x_omni_secret: str | None = Header(default=None)):
    check(x_omni_secret)
    model_or_503(model)
    return status_body(model)


@app.post("/warm")
def warm(payload: dict, x_omni_secret: str | None = Header(default=None)):
    check(x_omni_secret)
    model = payload.get("model", "zs")
    model_or_503(model)
    return status_body(model)


@app.post("/transcribe")
def transcribe(payload: dict, x_omni_secret: str | None = Header(default=None)):
    check(x_omni_secret)
    model = payload.get("model")
    runner = model_or_503(model)
    try:
        audio = base64.b64decode(payload.get("audio") or "", validate=True)
    except ValueError:
        raise HTTPException(status_code=400, detail="audio must be base64") from None
    if not audio:
        raise HTTPException(status_code=400, detail="missing audio")
    blobs: list[tuple[bytes, str]] = []
    if model == "zs":
        examples = (payload.get("examples") or [])[:MAX_EXAMPLES]
        if not examples:
            raise HTTPException(status_code=400, detail="zero-shot needs at least one example")
        for e in examples:
            if (not isinstance(e.get("url"), str) or not e["url"].startswith("https://")
                    or not isinstance(e.get("text"), str) or not e["text"].strip()):
                raise HTTPException(status_code=400, detail="each example needs an https url and text")
        with ThreadPoolExecutor(max_workers=MAX_EXAMPLES) as pool:
            fetched = list(pool.map(lambda e: _fetch_example(e["url"]), examples))
        blobs = [(b, e["text"]) for b, e in zip(fetched, examples)]
    try:
        wav = _decode_wav(audio)
    except subprocess.CalledProcessError:
        raise HTTPException(status_code=400, detail="could not decode audio") from None
    if wav.shape[0] / SAMPLE_RATE >= MAX_AUDIO_SEC:
        raise HTTPException(status_code=400, detail="audio must be shorter than 40 s")
    # One request per model at a time: the GPU is the queue. gpuSeconds starts
    # once the lock is held, so time spent waiting is not billed.
    with runner.lock:
        t0 = time.time()
        if runner.device.type == "cuda":
            torch.cuda.reset_peak_memory_stats(runner.device)
        with torch.inference_mode():
            if isinstance(runner, ZS):
                text, words, approx = runner.transcribe(wav, blobs)
            else:
                text, words, approx = runner.transcribe(wav, payload.get("lang") or None)
        out = {"text": text, "words": words, "timingsApproximate": approx,
               "gpuSeconds": round(time.time() - t0, 3), "gpu": device_label(runner.device)}
        if runner.device.type == "cuda":
            out["peakMemGiB"] = round(torch.cuda.max_memory_allocated(runner.device) / 2**30, 2)
    return out

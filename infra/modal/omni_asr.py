# Aquilla Omnilingual ASR — Modal service (facebookresearch/omnilingual-asr, Apache 2.0).
#
# Two GPU classes behind one app:
#   OmniCTC — omniASR_CTC_1B, used automatically for languages Whisper doesn't know.
#   OmniZS  — omniASR_LLM_7B_ZS, opt-in zero-shot: learns the language from 1–10
#             (audio, transcript) pairs taken from the same project.
# Both also load omniASR_CTC_300M as a forced aligner: the pipeline returns
# plain text, and Aquilla needs word timings.
#
# Spec: docs/superpowers/specs/2026-10-16-omnilingual-asr.md
#
# Deploy (Ryder):  modal deploy infra/modal/omni_asr.py
#   Secret: modal secret create aquilla-omni-asr OMNI_SHARED_SECRET=<same value as
#   the auth-worker's OMNI_SHARED_SECRET>. Optional env: OMNI_EXAMPLE_HOSTS
#   (comma-separated allow-list for example URLs), OMNI_EST_CTC / OMNI_EST_ZS.
# Smoke (no deploy needed):
#   modal run infra/modal/omni_asr.py::smoke --audio a.wav --model both --examples ex.json

import os
import time

import modal

app = modal.App("aquilla-omnilingual-asr")

# Weights live on a Volume: the ZS checkpoint is 30 GB, too big to bake into an
# image layer. fairseq2 downloads model cards' checkpoints into its cache dir.
weights = modal.Volume.from_name("aquilla-omni-asr-weights", create_if_missing=True)
WEIGHTS_DIR = "/mnt/omni-weights"

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg", "libsndfile1")
    # fairseq2n 0.6 pins torch==2.8.0; torchaudio must match it or it loads a
    # CUDA 13 build ("libcudart.so.13: cannot open shared object file").
    # pyarrow 22+ needs numpy 2, and fairseq2n holds numpy at 1.x.
    .pip_install("omnilingual-asr==0.2.0", "torch==2.8.0", "torchaudio==2.8.0", "pyarrow==21.0.0",
                 "httpx==0.27.2", "fastapi[standard]==0.115.14")
    # Only fairseq2's cache goes on the Volume. XDG_CACHE_HOME must not point
    # there: the Modal runtime writes to it before volumes mount, which then
    # fails with "cannot mount volume on non-empty path".
    .env({"FAIRSEQ2_CACHE_DIR": f"{WEIGHTS_DIR}/fairseq2"})
)

SAMPLE_RATE = 16000
MAX_AUDIO_SEC = 40          # upstream MAX_ALLOWED_AUDIO_SEC
MAX_CONTEXT_SEC = 30        # ZS was trained on context clips up to 30 s
FRAME_SEC = 0.02            # wav2vec2 stride: 320 samples @ 16 kHz


def _decode_wav(data: bytes) -> "object":
    """bytes (any ffmpeg-readable format) → mono float32 16 kHz torch tensor."""
    import subprocess

    import numpy as np
    import torch

    pcm = subprocess.run(
        ["ffmpeg", "-nostdin", "-loglevel", "error", "-i", "pipe:0",
         "-f", "f32le", "-ac", "1", "-ar", str(SAMPLE_RATE), "pipe:1"],
        input=data, capture_output=True, check=True,
    ).stdout
    return torch.from_numpy(np.frombuffer(pcm, dtype=np.float32).copy())


class _Aligner:
    """CTC forced alignment with omniASR_CTC_300M. The omniASR tokenizer is a
    char tokenizer, so the hypothesis text encodes to per-character targets
    the CTC emissions can be aligned against."""

    def __init__(self) -> None:
        from omnilingual_asr.models.inference.pipeline import ASRInferencePipeline

        self.pipe = ASRInferencePipeline(model_card="omniASR_CTC_300M")
        vocab = self.pipe.tokenizer.vocab_info
        # CTC blank: fairseq2 char tokenizers reserve index 0 (pad/blank).
        self.blank = 0
        self.vocab = vocab

    def describe(self) -> dict:
        v = self.vocab
        return {k: getattr(v, k, None) for k in ("size", "pad_idx", "bos_idx", "eos_idx", "unk_idx")}

    def emissions(self, wav: "object") -> "object":
        import torch

        with torch.inference_mode():
            return self._emissions(wav)

    def _emissions(self, wav: "object") -> "object":
        import torch
        from fairseq2.nn import BatchLayout

        model = self.pipe.model
        x = wav.to(self.pipe.device, self.pipe.dtype)
        # Upstream normalizes waveforms (layer-norm style) before the encoder.
        x = (x - x.mean()) / (x.std() + 1e-7)
        seqs = x.unsqueeze(0)
        layout = BatchLayout(seqs.shape, seq_lens=[seqs.shape[1]], device=seqs.device)
        logits, _ = model(seqs, layout)
        return torch.log_softmax(logits.float(), dim=-1)[0]

    def align(self, wav: "object", text: str) -> tuple[list[dict], bool]:
        """Return ([{text,start,end}], approximate)."""
        words = text.split()
        duration = wav.shape[0] / SAMPLE_RATE
        if not words:
            return [], False
        try:
            emis = self.emissions(wav).cpu().numpy()
            ids: list[int] = []
            spans: list[tuple[int, int]] = []  # token index range per word
            for w in words:
                t = [int(i) for i in self.pipe.token_encoder(w).tolist()
                     if int(i) not in (self.vocab.bos_idx, self.vocab.eos_idx, self.blank)]
                spans.append((len(ids), len(ids) + len(t)))
                ids.extend(t)
            if not ids:
                raise ValueError("unalignable")
            tok_frames: list[list[int]] = [[] for _ in ids]
            for f, k in enumerate(_ctc_viterbi(emis, ids, self.blank)):
                if k >= 0:
                    tok_frames[k].append(f)
            out = []
            for w, (a, b) in zip(words, spans):
                frames = [f for fr in tok_frames[a:b] for f in fr]
                if not frames:
                    raise ValueError("empty word span")
                out.append({"text": w, "start": round(frames[0] * FRAME_SEC, 3),
                            "end": round((frames[-1] + 1) * FRAME_SEC, 3)})
            return out, False
        except Exception as e:  # noqa: BLE001 — fall back to proportional timings
            print(f"[align] fallback: {e}", flush=True)
            total = sum(len(w) for w in words)
            t, out = 0.0, []
            for w in words:
                d = duration * len(w) / total
                out.append({"text": w, "start": round(t, 3), "end": round(t + d, 3)})
                t += d
            return out, True


def _ctc_viterbi(log_probs: "object", targets: list[int], blank: int) -> list[int]:
    """Best CTC path of `targets` through `log_probs` [T, V] (numpy).

    Returns, per frame, the index into `targets` the frame is assigned to, or
    -1 for a blank frame. Standard CTC trellis over the blank-interleaved
    sequence (length 2L+1); O(T·L). Self-contained so we don't depend on
    torchaudio.functional.forced_align, which newer torchaudio drops."""
    import numpy as np

    T = log_probs.shape[0]
    ext = [blank]
    for t in targets:
        ext += [t, blank]
    S = len(ext)
    if T < len(targets):
        raise ValueError("audio too short for transcript")
    neg = -1e30
    dp = np.full((T, S), neg, dtype=np.float64)
    bp = np.zeros((T, S), dtype=np.int8)  # 0 stay, 1 from s-1, 2 from s-2
    emit = log_probs[:, ext]  # [T, S]
    dp[0, 0] = emit[0, 0]
    dp[0, 1] = emit[0, 1]
    # s-2 skip allowed only into a non-blank that differs from the one two back
    skip_ok = np.array([s >= 2 and ext[s] != blank and ext[s] != ext[s - 2] for s in range(S)])
    for t in range(1, T):
        prev = dp[t - 1]
        stay = prev
        one = np.concatenate(([neg], prev[:-1]))
        two = np.where(skip_ok, np.concatenate(([neg, neg], prev[:-2])), neg)
        best = np.stack([stay, one, two])
        choice = best.argmax(axis=0)
        dp[t] = best[choice, np.arange(S)] + emit[t]
        bp[t] = choice
    s = S - 1 if dp[T - 1, S - 1] >= dp[T - 1, S - 2] else S - 2
    path = [0] * T
    for t in range(T - 1, -1, -1):
        path[t] = s
        s -= int(bp[t, s])
    return [(p - 1) // 2 if p % 2 == 1 else -1 for p in path]


# Container state for /status. A heartbeat older than the scaledown window
# (plus slack) means the container is gone even if @modal.exit never ran.
state = modal.Dict.from_name("aquilla-omni-asr-state", create_if_missing=True)
ZS_SCALEDOWN_SEC = 600
STALE_AFTER_SEC = ZS_SCALEDOWN_SEC + 60


def _set_state(model: str, value: str) -> None:
    state[model] = {"state": value, "ts": time.time()}


def _get_state(model: str) -> str:
    entry = state.get(model)
    if not entry or time.time() - entry["ts"] > STALE_AFTER_SEC:
        return "cold"
    return entry["state"]


def _gpu_name() -> str:
    import torch

    return torch.cuda.get_device_name(0) if torch.cuda.is_available() else "cpu"


@app.cls(image=image, gpu="L4", volumes={WEIGHTS_DIR: weights}, timeout=600,
         scaledown_window=300, max_containers=4)
class OmniCTC:
    @modal.enter()
    def load(self) -> None:
        from omnilingual_asr.models.inference.pipeline import ASRInferencePipeline

        t0 = time.time()
        self.pipe = ASRInferencePipeline(model_card="omniASR_CTC_1B")
        self.aligner = _Aligner()
        weights.commit()
        self.load_sec = time.time() - t0
        print(f"[ctc] loaded in {self.load_sec:.1f}s on {_gpu_name()}", flush=True)

    @modal.method()
    def transcribe(self, audio: bytes, lang: str | None = None) -> dict:
        import torch

        t0 = time.time()
        wav = _decode_wav(audio)
        if wav.shape[0] / SAMPLE_RATE >= MAX_AUDIO_SEC:
            raise ValueError("audio must be shorter than 40 s")
        torch.cuda.reset_peak_memory_stats()
        text = self.pipe.transcribe([{"waveform": wav, "sample_rate": SAMPLE_RATE}],
                                    lang=[lang], batch_size=1)[0]
        words, approx = self.aligner.align(wav, text)
        return {"text": text, "words": words, "timingsApproximate": approx,
                "gpuSeconds": round(time.time() - t0, 3), "gpu": _gpu_name(),
                "peakMemGiB": round(torch.cuda.max_memory_allocated() / 2**30, 2),
                "loadSec": round(self.load_sec, 1)}


@app.cls(image=image, gpu="L40S", volumes={WEIGHTS_DIR: weights}, timeout=900,
         scaledown_window=ZS_SCALEDOWN_SEC, max_containers=2)
class OmniZS:
    @modal.enter()
    def load(self) -> None:
        from omnilingual_asr.models.inference.pipeline import ASRInferencePipeline

        _set_state("zs", "starting")
        t0 = time.time()
        self.pipe = ASRInferencePipeline(model_card="omniASR_LLM_7B_ZS")
        self.aligner = _Aligner()
        weights.commit()
        self.load_sec = time.time() - t0
        _set_state("zs", "ready")
        print(f"[zs] loaded in {self.load_sec:.1f}s on {_gpu_name()}", flush=True)

    @modal.exit()
    def unload(self) -> None:
        _set_state("zs", "cold")

    @modal.method()
    def ping(self) -> None:
        """No-op used by /warm: calling it starts a container."""
        _set_state("zs", "ready")

    @modal.method()
    def transcribe(self, audio: bytes, examples: list[tuple[bytes, str]]) -> dict:
        import torch
        from omnilingual_asr.models.inference.pipeline import ContextExample

        _set_state("zs", "ready")
        t0 = time.time()
        wav = _decode_wav(audio)
        if wav.shape[0] / SAMPLE_RATE >= MAX_AUDIO_SEC:
            raise ValueError("audio must be shorter than 40 s")
        if not examples:
            raise ValueError("zero-shot needs at least one example")
        ctx = []
        for data, text in examples[:10]:
            cw = _decode_wav(data)[: MAX_CONTEXT_SEC * SAMPLE_RATE]
            ctx.append(ContextExample({"waveform": cw, "sample_rate": SAMPLE_RATE}, text))
        torch.cuda.reset_peak_memory_stats()
        text = self.pipe.transcribe_with_context(
            [{"waveform": wav, "sample_rate": SAMPLE_RATE}], context_examples=[ctx], batch_size=1,
        )[0].strip()
        words, approx = self.aligner.align(wav, text)
        return {"text": text, "words": words, "timingsApproximate": approx,
                "gpuSeconds": round(time.time() - t0, 3), "gpu": _gpu_name(),
                "peakMemGiB": round(torch.cuda.max_memory_allocated() / 2**30, 2),
                "loadSec": round(self.load_sec, 1)}


# ── Web API ──────────────────────────────────────────────────────────────────
# One CPU ASGI app, so the auth-worker uses a single base URL:
#   POST /transcribe   POST /warm   GET /status?model=zs
# Example audio is fetched here, on CPU, so GPU time (which is billed) is not
# spent waiting on R2.

APP_SECRET = modal.Secret.from_name("aquilla-omni-asr")  # OMNI_SHARED_SECRET
web_image = modal.Image.debian_slim(python_version="3.11").pip_install(
    "httpx==0.27.2", "fastapi[standard]==0.115.14",
)

# GPU-seconds per audio-second, measured in the spike; the client uses it for
# the batch credit estimate. Override with env if a re-benchmark moves it.
EST_GPU_SEC_PER_AUDIO_SEC = {"ctc": 0.1, "zs": 0.5}
MAX_EXAMPLES = 10
MAX_EXAMPLE_BYTES = 8 * 1024 * 1024


def _validate_host_public(hostname: str) -> set[str]:
    """Resolve and require every address to be public (SSRF guard, as in
    diarization.py). Returns the addresses so the fetch can pin one."""
    import ipaddress
    import socket

    from fastapi import HTTPException

    if hostname == "localhost" or hostname.endswith((".local", ".internal")):
        raise HTTPException(status_code=400, detail="example host not allowed")
    try:
        resolved = {info[4][0] for info in socket.getaddrinfo(hostname, None)}
    except socket.gaierror:
        raise HTTPException(status_code=400, detail="example host does not resolve") from None
    for addr in resolved:
        if not ipaddress.ip_address(addr).is_global:
            raise HTTPException(status_code=400, detail="example host is not public")
    return resolved


def _fetch_example(url: str) -> bytes:
    """GET a presigned example URL. https only; optional host allow-list
    (OMNI_EXAMPLE_HOSTS, comma-separated); no redirects; DNS pinned to the
    validated address so a rebinding answer can't reach an internal host."""
    import ipaddress
    from urllib.parse import urlparse

    import httpx
    from fastapi import HTTPException

    parsed = urlparse(url)
    if parsed.scheme != "https" or not parsed.hostname:
        raise HTTPException(status_code=400, detail="example url must be https")
    host = parsed.hostname.lower()
    allowed = [h.strip().lower() for h in os.environ.get("OMNI_EXAMPLE_HOSTS", "").split(",") if h.strip()]
    if allowed and not any(host == h or host.endswith("." + h) for h in allowed):
        raise HTTPException(status_code=400, detail="example host not allowed")
    resolved = _validate_host_public(host)
    ip = next((a for a in resolved if ipaddress.ip_address(a).version == 4), next(iter(resolved)))
    port = parsed.port or 443
    netloc = f"[{ip}]:{port}" if ":" in ip else f"{ip}:{port}"
    with httpx.Client(timeout=30, follow_redirects=False) as c:
        resp = c.get(parsed._replace(netloc=netloc).geturl(),
                     headers={"Host": parsed.netloc}, extensions={"sni_hostname": host})
    if resp.status_code != 200:
        raise HTTPException(status_code=400, detail=f"example fetch failed ({resp.status_code})")
    if len(resp.content) > MAX_EXAMPLE_BYTES:
        raise HTTPException(status_code=400, detail="example audio too large")
    return resp.content


@app.function(image=web_image, secrets=[APP_SECRET], timeout=900)
@modal.concurrent(max_inputs=50)
@modal.asgi_app()
def api():
    import base64
    import hmac
    from concurrent.futures import ThreadPoolExecutor

    from fastapi import FastAPI, Header, HTTPException

    web = FastAPI()

    def check(secret: str | None) -> None:
        if not hmac.compare_digest((secret or "").encode(), os.environ["OMNI_SHARED_SECRET"].encode()):
            raise HTTPException(status_code=401, detail="bad shared secret")

    def status_body(model: str) -> dict:
        s = "ready" if model == "ctc" else _get_state("zs")
        return {"state": s, "estGpuSecPerAudioSec": float(
            os.environ.get(f"OMNI_EST_{model.upper()}", EST_GPU_SEC_PER_AUDIO_SEC[model]))}

    @web.get("/status")
    def status(model: str = "zs", x_omni_secret: str | None = Header(default=None)):
        check(x_omni_secret)
        if model not in ("ctc", "zs"):
            raise HTTPException(status_code=400, detail="model must be ctc or zs")
        return status_body(model)

    @web.post("/warm")
    def warm(payload: dict, x_omni_secret: str | None = Header(default=None)):
        check(x_omni_secret)
        if payload.get("model", "zs") == "zs" and _get_state("zs") == "cold":
            _set_state("zs", "starting")
            OmniZS().ping.spawn()
        return status_body("zs")

    @web.post("/transcribe")
    def transcribe(payload: dict, x_omni_secret: str | None = Header(default=None)):
        check(x_omni_secret)
        model = payload.get("model")
        try:
            audio = base64.b64decode(payload.get("audio") or "", validate=True)
        except ValueError:
            raise HTTPException(status_code=400, detail="audio must be base64") from None
        if not audio:
            raise HTTPException(status_code=400, detail="missing audio")
        if model == "ctc":
            return OmniCTC().transcribe.remote(audio, payload.get("lang") or None)
        if model != "zs":
            raise HTTPException(status_code=400, detail="model must be ctc or zs")
        examples = payload.get("examples") or []
        if not examples:
            raise HTTPException(status_code=400, detail="zero-shot needs at least one example")
        examples = examples[:MAX_EXAMPLES]
        for e in examples:
            if (not isinstance(e.get("url"), str) or not e["url"].startswith("https://")
                    or not isinstance(e.get("text"), str) or not e["text"].strip()):
                raise HTTPException(status_code=400, detail="each example needs an https url and text")
        if _get_state("zs") != "ready":
            # Don't hold the worker's request through a multi-minute cold start.
            if _get_state("zs") == "cold":
                _set_state("zs", "starting")
                OmniZS().ping.spawn()
            return {"warming": True}
        with ThreadPoolExecutor(max_workers=MAX_EXAMPLES) as pool:
            blobs = list(pool.map(lambda e: _fetch_example(e["url"]), examples))
        return OmniZS().transcribe.remote(audio, [(b, e["text"]) for b, e in zip(blobs, examples)])

    return web


@app.local_entrypoint()
def smoke(audio: str, examples: str = "", model: str = "both", lang: str = "") -> None:
    """Spike harness. --examples is a JSON file: [{"path": ..., "text": ...}]."""
    import json

    data = open(audio, "rb").read()
    if model in ("ctc", "both"):
        t0 = time.time()
        r = OmniCTC().transcribe.remote(data, lang or None)
        r["wallSec"] = round(time.time() - t0, 1)
        print("CTC", json.dumps(r, ensure_ascii=False, indent=1))
    if model in ("zs", "both") and examples:
        pairs = [(open(e["path"], "rb").read(), e["text"]) for e in json.load(open(examples))]
        t0 = time.time()
        r = OmniZS().transcribe.remote(data, pairs)
        r["wallSec"] = round(time.time() - t0, 1)
        print("ZS", json.dumps(r, ensure_ascii=False, indent=1))

"""
Seed-VC zero-shot voice conversion, deployed on Modal as an authenticated HTTP
endpoint. This is the GPU box behind the workspace "voice clone" feature: it takes
a *source* wav (the speech to keep — usually Gemini/MMS TTS output) plus a
*reference* wav (the voice to sound like) and returns the source re-voiced into
the reference timbre. Language-agnostic: the multilingual pronunciation comes from
whatever produced the source audio; Seed-VC only swaps the timbre.

Design notes (why this isn't the upstream `inference.py` CLI):
  - The model is loaded ONCE in @modal.enter() and reused across requests. Upstream
    fuses load + convert in a single `main(args)` call, which would reload all
    checkpoints onto the GPU on every request and defeat the warm container. We
    call the repo's `load_models()` once, then reproduce the body of `main()` as a
    per-call method, reusing the repo's own `crossfade` / `device` / `fp16` so we
    don't re-derive the diffusion/vocoder math.
  - The endpoint requires a shared-secret header (X-Auth-Token). Only the codex-web
    sync worker holds the token; the browser never talks to Modal directly.
  - Weights download once into a persistent Volume, then every cold start reuses
    them. Container stays warm for SCALEDOWN seconds, then scales to zero.
  - Pinned to the non-F0 (speech) model. F0/singing conversion needs a different
    checkpoint and would be a separate class — out of scope for re-voicing TTS.

Deploy:
    pip install modal                                  # local deploy only needs modal
    modal setup                                        # one-time auth
    modal secret create seed-vc-auth SEED_VC_TOKEN=<a-long-random-string>
    modal deploy infra/modal/seed_vc.py                # prints the https endpoint URL

Test from your machine (note the /convert route on the printed base URL):
    curl -X POST "<endpoint-base-url>/convert" \
        -H "X-Auth-Token: <the-same-token>" \
        -F "source=@tts_output.wav" \
        -F "reference=@target_voice.wav" \
        -F "diffusion_steps=10" \
        --output converted.wav

Or exercise the model path directly, no web layer / no auth:
    modal run infra/modal/seed_vc.py --source tts_output.wav --reference target.wav
"""

import hmac
import os

import modal

# --- Config knobs ------------------------------------------------------------
REPO = "https://github.com/Plachtaa/seed-vc.git"
# Pinned commit — cloning the floating default branch would let an upstream
# compromise or bad push land in the next image rebuild with GPU-container
# privileges. Bump deliberately when picking up upstream changes.
REPO_COMMIT = "51383efd921027683c89e5348211d93ff12ac2a8"
GPU = "L40S"          # fine alternatives: "A10G", "A100-40GB". T4 may OOM in fp16.
SCALEDOWN = 300       # seconds to keep a warm container after the last request
CACHE_DIR = "/cache"  # HF + torch download cache, persisted across runs via the Volume
SEED_VC_DIR = "/seed-vc"

# --- Image: clone repo, install deps, point every download cache at the Volume ---
image = (
    modal.Image.debian_slim(python_version="3.10")
    .apt_install("git", "ffmpeg")
    .run_commands(
        f"git clone {REPO} {SEED_VC_DIR} && cd {SEED_VC_DIR} && git checkout {REPO_COMMIT}",
        f"cd {SEED_VC_DIR} && pip install -r requirements.txt",
    )
    .pip_install("fastapi[standard]", "python-multipart")  # for the asgi endpoint
    .env(
        {
            "HF_HOME": f"{CACHE_DIR}/hf",
            "HF_HUB_CACHE": f"{CACHE_DIR}/hf",
            "TORCH_HOME": f"{CACHE_DIR}/torch",
        }
    )
)

app = modal.App("seed-vc")
cache_vol = modal.Volume.from_name("seed-vc-cache", create_if_missing=True)
auth_secret = modal.Secret.from_name("seed-vc-auth")  # must contain SEED_VC_TOKEN


@app.cls(
    gpu=GPU,
    image=image,
    volumes={CACHE_DIR: cache_vol},
    scaledown_window=SCALEDOWN,
    timeout=600,
)
class SeedVC:
    @modal.enter()
    def setup(self):
        """Load the speech (non-F0) model once. First container on a fresh Volume
        downloads checkpoints from HuggingFace (a one-time cost), then commits them
        back so later cold starts read from the Volume."""
        import sys
        import types

        os.makedirs(f"{CACHE_DIR}/hf", exist_ok=True)
        os.makedirs(f"{CACHE_DIR}/torch", exist_ok=True)

        # The repo uses relative imports (`from modules...`) and relative config
        # paths, so it must be importable and the cwd must be the repo root.
        sys.path.insert(0, SEED_VC_DIR)
        os.chdir(SEED_VC_DIR)

        import inference as svc  # upstream module; we reuse its helpers + loader

        # Mirror argparse defaults for the non-F0 speech model.
        args = types.SimpleNamespace(
            f0_condition=False,
            checkpoint=None,
            config=None,
            fp16=True,
        )
        self.svc = svc
        # load_models() also sets the module global `svc.fp16` used during inference.
        self.models = svc.load_models(args)

        # Persist freshly downloaded weights so future cold starts skip the download.
        cache_vol.commit()

    def _run(self, source_path, reference_path, diffusion_steps, length_adjust, inference_cfg_rate):
        """Faithful reproduction of upstream `main(args)` for the non-F0 model,
        minus the load step (done once in setup) and the F0 branch (model is pinned
        to f0_condition=False). Returns (wav_tensor, sample_rate)."""
        import librosa
        import numpy as np
        import torch
        import torchaudio

        svc = self.svc
        device = svc.device
        model, semantic_fn, f0_fn, vocoder_fn, campplus_model, mel_fn, mel_fn_args = self.models

        with torch.no_grad():
            sr = mel_fn_args["sampling_rate"]
            source_audio = librosa.load(source_path, sr=sr)[0]
            ref_audio = librosa.load(reference_path, sr=sr)[0]

            # Non-F0 speech-model constants (upstream: sr=22050, hop=256 when no F0).
            sr = 22050
            hop_length = 256
            max_context_window = sr // hop_length * 30
            overlap_frame_len = 16
            overlap_wave_len = overlap_frame_len * hop_length

            source_audio = torch.tensor(source_audio).unsqueeze(0).float().to(device)
            ref_audio = torch.tensor(ref_audio[: sr * 25]).unsqueeze(0).float().to(device)

            # Semantic tokens for the source. Whisper handles <=30s in one pass;
            # longer source is chunked with a 5s overlap and stitched.
            converted_waves_16k = torchaudio.functional.resample(source_audio, sr, 16000)
            if converted_waves_16k.size(-1) <= 16000 * 30:
                S_alt = semantic_fn(converted_waves_16k)
            else:
                overlapping_time = 5
                S_alt_list = []
                buffer = None
                traversed_time = 0
                while traversed_time < converted_waves_16k.size(-1):
                    if buffer is None:
                        chunk = converted_waves_16k[:, traversed_time : traversed_time + 16000 * 30]
                    else:
                        chunk = torch.cat(
                            [buffer, converted_waves_16k[:, traversed_time : traversed_time + 16000 * (30 - overlapping_time)]],
                            dim=-1,
                        )
                    S_alt = semantic_fn(chunk)
                    if traversed_time == 0:
                        S_alt_list.append(S_alt)
                    else:
                        S_alt_list.append(S_alt[:, 50 * overlapping_time :])
                    buffer = chunk[:, -16000 * overlapping_time :]
                    traversed_time += 30 * 16000 if traversed_time == 0 else chunk.size(-1) - 16000 * overlapping_time
                S_alt = torch.cat(S_alt_list, dim=1)

            ori_waves_16k = torchaudio.functional.resample(ref_audio, sr, 16000)
            S_ori = semantic_fn(ori_waves_16k)

            mel = mel_fn(source_audio.to(device).float())
            mel2 = mel_fn(ref_audio.to(device).float())

            target_lengths = torch.LongTensor([int(mel.size(2) * length_adjust)]).to(mel.device)
            target2_lengths = torch.LongTensor([mel2.size(2)]).to(mel2.device)

            feat2 = torchaudio.compliance.kaldi.fbank(
                ori_waves_16k, num_mel_bins=80, dither=0, sample_frequency=16000
            )
            feat2 = feat2 - feat2.mean(dim=0, keepdim=True)
            style2 = campplus_model(feat2.unsqueeze(0))

            # F0 is disabled for the speech model.
            shifted_f0_alt = None
            F0_ori = None

            cond, _, _, _, _ = model.length_regulator(
                S_alt, ylens=target_lengths, n_quantizers=3, f0=shifted_f0_alt
            )
            prompt_condition, _, _, _, _ = model.length_regulator(
                S_ori, ylens=target2_lengths, n_quantizers=3, f0=F0_ori
            )

            # Generate chunk-by-chunk with crossfade at the overlaps.
            max_source_window = max_context_window - mel2.size(2)
            processed_frames = 0
            generated_wave_chunks = []
            previous_chunk = None
            while processed_frames < cond.size(1):
                chunk_cond = cond[:, processed_frames : processed_frames + max_source_window]
                is_last_chunk = processed_frames + max_source_window >= cond.size(1)
                cat_condition = torch.cat([prompt_condition, chunk_cond], dim=1)
                with torch.autocast(
                    device_type=device.type,
                    dtype=torch.float16 if svc.fp16 else torch.float32,
                ):
                    vc_target = model.cfm.inference(
                        cat_condition,
                        torch.LongTensor([cat_condition.size(1)]).to(mel2.device),
                        mel2,
                        style2,
                        None,
                        diffusion_steps,
                        inference_cfg_rate=inference_cfg_rate,
                    )
                    vc_target = vc_target[:, :, mel2.size(-1) :]
                vc_wave = vocoder_fn(vc_target.float()).squeeze()[None, :]
                if processed_frames == 0:
                    if is_last_chunk:
                        generated_wave_chunks.append(vc_wave[0].cpu().numpy())
                        break
                    generated_wave_chunks.append(vc_wave[0, :-overlap_wave_len].cpu().numpy())
                    previous_chunk = vc_wave[0, -overlap_wave_len:]
                    processed_frames += vc_target.size(2) - overlap_frame_len
                elif is_last_chunk:
                    output_wave = svc.crossfade(
                        previous_chunk.cpu().numpy(), vc_wave[0].cpu().numpy(), overlap_wave_len
                    )
                    generated_wave_chunks.append(output_wave)
                    processed_frames += vc_target.size(2) - overlap_frame_len
                    break
                else:
                    output_wave = svc.crossfade(
                        previous_chunk.cpu().numpy(),
                        vc_wave[0, :-overlap_wave_len].cpu().numpy(),
                        overlap_wave_len,
                    )
                    generated_wave_chunks.append(output_wave)
                    previous_chunk = vc_wave[0, -overlap_wave_len:]
                    processed_frames += vc_target.size(2) - overlap_frame_len

            vc_wave = torch.tensor(np.concatenate(generated_wave_chunks))[None, :].float()
            return vc_wave, sr

    @modal.method()
    def convert(
        self,
        source_bytes: bytes,
        reference_bytes: bytes,
        diffusion_steps: int = 10,     # 4-10 fastest, 25 default, 30-50 best quality
        length_adjust: float = 1.0,    # keep at 1.0 so duration is preserved
        inference_cfg_rate: float = 0.7,
    ) -> bytes:
        import tempfile

        import torchaudio

        work = tempfile.mkdtemp()
        src = os.path.join(work, "source.wav")
        ref = os.path.join(work, "reference.wav")
        out = os.path.join(work, "converted.wav")
        with open(src, "wb") as f:
            f.write(source_bytes)
        with open(ref, "wb") as f:
            f.write(reference_bytes)

        vc_wave, sr = self._run(src, ref, diffusion_steps, length_adjust, inference_cfg_rate)
        torchaudio.save(out, vc_wave.cpu(), sr)
        with open(out, "rb") as f:
            return f.read()


# --- Web endpoint: ASGI app built in-container so local deploy needs no fastapi ---
@app.function(image=image, secrets=[auth_secret])
@modal.asgi_app()
def web():
    from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
    from fastapi.responses import Response

    web_app = FastAPI(title="seed-vc")

    @web_app.get("/health")
    async def health():
        return {"ok": True}

    @web_app.post("/convert")
    async def convert(
        source: UploadFile = File(...),
        reference: UploadFile = File(...),
        diffusion_steps: int = Form(10),
        length_adjust: float = Form(1.0),
        inference_cfg_rate: float = Form(0.7),
        x_auth_token: str = Header(default=""),
    ):
        expected = os.environ.get("SEED_VC_TOKEN", "")
        if not expected or not hmac.compare_digest(x_auth_token, expected):
            raise HTTPException(status_code=401, detail="unauthorized")
        wav = SeedVC().convert.remote(
            await source.read(),
            await reference.read(),
            diffusion_steps=diffusion_steps,
            length_adjust=length_adjust,
            inference_cfg_rate=inference_cfg_rate,
        )
        return Response(content=wav, media_type="audio/wav")

    return web_app


# --- Local test entrypoint: `modal run infra/modal/seed_vc.py --source s.wav --reference r.wav`
@app.local_entrypoint()
def main(source: str, reference: str, output: str = "converted.wav", steps: int = 10):
    with open(source, "rb") as f:
        source_bytes = f.read()
    with open(reference, "rb") as f:
        reference_bytes = f.read()
    wav = SeedVC().convert.remote(source_bytes, reference_bytes, diffusion_steps=steps)
    with open(output, "wb") as f:
        f.write(wav)
    print(f"Wrote {output} ({len(wav)} bytes)")

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
    checkpoints onto the GPU on every request and defeat the warm container. The
    load-once engine lives in `seed_vc_core.py`, shared with the local server.
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

Local development on Apple silicon (no Modal account, same /convert contract):
    pnpm seed-vc:local                                 # see seed_vc_local.py
"""

import hmac
import os
from pathlib import Path

import modal

# --- Config knobs ------------------------------------------------------------
REPO = "https://github.com/Plachtaa/seed-vc.git"
# Pinned commit — cloning the floating default branch would let an upstream
# compromise or bad push land in the next image rebuild with GPU-container
# privileges. Bump deliberately when picking up upstream changes.
# scripts/seed-vc-local.sh reads this line, so keep it a plain string literal.
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
    # /root is on the container's sys.path, so `import seed_vc_core` resolves.
    .add_local_file(Path(__file__).parent / "seed_vc_core.py", "/root/seed_vc_core.py")
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
        os.makedirs(f"{CACHE_DIR}/hf", exist_ok=True)
        os.makedirs(f"{CACHE_DIR}/torch", exist_ok=True)

        from seed_vc_core import SeedVCEngine

        self.engine = SeedVCEngine(SEED_VC_DIR, fp16=True)

        # Persist freshly downloaded weights so future cold starts skip the download.
        cache_vol.commit()

    @modal.method()
    def convert(
        self,
        source_bytes: bytes,
        reference_bytes: bytes,
        diffusion_steps: int = 10,     # 4-10 fastest, 25 default, 30-50 best quality
        length_adjust: float = 1.0,    # keep at 1.0 so duration is preserved
        inference_cfg_rate: float = 0.7,
    ) -> bytes:
        return self.engine.convert(
            source_bytes,
            reference_bytes,
            diffusion_steps=diffusion_steps,
            length_adjust=length_adjust,
            inference_cfg_rate=inference_cfg_rate,
        )


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

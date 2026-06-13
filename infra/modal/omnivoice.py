"""
OmniVoice zero-shot text-to-speech / voice-design model, deployed on Modal as
an authenticated HTTP endpoint. Supports 600+ languages; uses a diffusion-LM
architecture with Whisper for reference ASR under the hood (zero-shot voice
cloning — pass a reference clip and the model adopts that timbre).

Three synthesis modes (all via the same /synthesize route):
  1. Voice cloning — send `voice_ref` (3–10 s reference wav) + optional
     `voice_ref_text` transcription (auto-transcribed by Whisper if omitted).
  2. Voice design — send an `instruct` text describing the desired voice
     characteristics (gender, age, pitch, style, accent, dialect).
  3. Auto voice — omit both `voice_ref` and `instruct`; the model picks.

This endpoint is the GPU back-end for the workspace "Generate audio" feature
(use-case 1) and also produces the base TTS that feeds the Seed-VC re-voice
step (use-case 3). Auth: only the sync-worker holds `OMNIVOICE_TOKEN`; the
browser never talks to Modal directly.

Design mirrors `infra/modal/seed_vc.py` exactly:
  - Model loaded ONCE in @modal.enter(); weights cached on a persistent Volume.
  - Shared-secret header (X-Auth-Token) enforced on every /synthesize call.
  - asgi_app() FastAPI for HTTP; local_entrypoint for local smoke-testing.
  - GPU L40S, 5-minute warm-window, 10-min request timeout.

Deploy:
    pip install modal                                 # local deploy needs only modal
    modal setup                                       # one-time auth
    modal secret create omnivoice-auth \\
        OMNIVOICE_TOKEN=<a-long-random-string> \\
        HF_TOKEN=<your-hf-token>
    modal deploy infra/modal/omnivoice.py             # prints the https endpoint URL

Test from your machine (note the /synthesize route on the printed base URL):
    curl -X POST "<endpoint-base-url>/synthesize" \\
        -H "X-Auth-Token: <the-same-token>" \\
        -F "text=Hello, this is a test." \\
        -F "language=en" \\
        -F "voice_ref=@reference_voice.wav" \\
        --output synthesized.wav

Or exercise the model path directly (no web layer / no auth):
    modal run infra/modal/omnivoice.py --text "Hello world" --output out.wav
"""

import io
import os

import modal

# --- Config knobs ------------------------------------------------------------
REPO = "https://github.com/k2-fsa/OmniVoice.git"
MODEL_ID = "k2-fsa/OmniVoice"        # HuggingFace repo id for OmniVoice.from_pretrained()
GPU = "L40S"                          # fine alternatives: "A10G", "A100-40GB"
SCALEDOWN = 300                       # seconds to keep a warm container after the last request
CACHE_DIR = "/cache"                  # HF + torch download cache, persisted via Volume
SAMPLE_RATE = 24000                   # OmniVoice always outputs 24 kHz (hardcoded upstream)

# --- Image: install OmniVoice + deps, point every download cache at the Volume ---
image = (
    modal.Image.debian_slim(python_version="3.10")
    .apt_install("git", "ffmpeg", "libsndfile1")
    .pip_install(
        # OmniVoice from source (latest; pinned release tag available once stable)
        # SWARM-TODO: pin to a stable release tag once k2-fsa publishes one
        "git+https://github.com/k2-fsa/OmniVoice.git",
        # soundfile for encoding numpy → WAV bytes in-memory
        "soundfile",
        # FastAPI for the asgi endpoint
        "fastapi[standard]",
        "python-multipart",
    )
    .env(
        {
            "HF_HOME": f"{CACHE_DIR}/hf",
            "HF_HUB_CACHE": f"{CACHE_DIR}/hf",
            "TORCH_HOME": f"{CACHE_DIR}/torch",
        }
    )
)

app = modal.App("omnivoice")
cache_vol = modal.Volume.from_name("omnivoice-cache", create_if_missing=True)
auth_secret = modal.Secret.from_name("omnivoice-auth")  # must contain OMNIVOICE_TOKEN + HF_TOKEN


@app.cls(
    gpu=GPU,
    image=image,
    volumes={CACHE_DIR: cache_vol},
    secrets=[auth_secret],
    scaledown_window=SCALEDOWN,
    timeout=600,
)
class OmniVoiceTTS:
    @modal.enter()
    def setup(self):
        """Load the OmniVoice model once. The first container on a fresh Volume
        downloads checkpoints from HuggingFace (a one-time cost ≈ several GB),
        then commits them back so later cold starts read from the Volume."""
        import torch
        from omnivoice import OmniVoice

        os.makedirs(f"{CACHE_DIR}/hf", exist_ok=True)
        os.makedirs(f"{CACHE_DIR}/torch", exist_ok=True)

        # L40S is a CUDA GPU; fall back gracefully if somehow run on CPU.
        # SWARM-TODO: confirm device_map string accepted by from_pretrained on Modal;
        # upstream docs show "cuda:0" for GPU — adjust if Modal exposes a different
        # device ordinal or if the from_pretrained signature changes.
        device_map = "cuda:0" if torch.cuda.is_available() else "cpu"

        self.model = OmniVoice.from_pretrained(
            MODEL_ID,
            device_map=device_map,
            dtype=torch.float16,
        )

        # Persist freshly downloaded weights so future cold starts skip the download.
        cache_vol.commit()

    @modal.method()
    def synthesize(
        self,
        text: str,
        voice_ref_bytes: bytes | None = None,
        voice_ref_text: str | None = None,
        instruct: str | None = None,
        language: str = "en",
        num_step: int = 32,
        speed: float = 1.0,
    ) -> tuple[bytes, float]:
        """Run OmniVoice TTS and return (wav_bytes, duration_seconds).

        Synthesis mode is determined by the combination of inputs:
          - voice_ref_bytes provided  → voice cloning (voice_ref_text optional)
          - instruct provided (no ref) → voice design
          - neither                    → auto voice

        The `language` parameter is passed as a hint when OmniVoice supports
        explicit language selection (currently a no-op if OmniVoice auto-detects
        from text/reference).
        # SWARM-TODO: verify whether OmniVoice.generate() accepts a `language`
        # kwarg; the README does not document one. If the model auto-detects from
        # the reference/text, this arg should be dropped from the generate() call.

        Returns:
            (wav_bytes, duration_seconds): WAV-encoded PCM at 24 kHz and the
            duration as num_samples / SAMPLE_RATE.
        """
        import tempfile

        import numpy as np
        import soundfile as sf

        ref_audio_path: str | None = None
        tmp_ref = None

        try:
            # Write voice_ref_bytes to a temp file so generate() gets a file path.
            if voice_ref_bytes is not None:
                tmp_ref = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
                tmp_ref.write(voice_ref_bytes)
                tmp_ref.flush()
                tmp_ref.close()
                ref_audio_path = tmp_ref.name

            # Build generate() kwargs. omit None values so defaults apply.
            generate_kwargs: dict = {
                "text": text,
                "num_step": num_step,
                "speed": speed,
            }
            if ref_audio_path is not None:
                generate_kwargs["ref_audio"] = ref_audio_path
                if voice_ref_text is not None:
                    generate_kwargs["ref_text"] = voice_ref_text
                # If ref_text is omitted OmniVoice uses Whisper ASR internally.
            if instruct is not None and ref_audio_path is None:
                generate_kwargs["instruct"] = instruct

            # generate() returns a list of np.ndarray with shape (T,) at 24 kHz.
            audio_list = self.model.generate(**generate_kwargs)
            audio_np: np.ndarray = audio_list[0]  # take the first (and only) result

            # Encode numpy PCM → in-memory WAV bytes.
            buf = io.BytesIO()
            sf.write(buf, audio_np, SAMPLE_RATE, format="WAV", subtype="PCM_16")
            wav_bytes = buf.getvalue()

            duration_seconds: float = len(audio_np) / SAMPLE_RATE
            return wav_bytes, duration_seconds

        finally:
            # Clean up the temp reference file.
            if tmp_ref is not None and os.path.exists(tmp_ref.name):
                os.unlink(tmp_ref.name)


# --- Web endpoint: ASGI app built in-container so local deploy needs no fastapi ---
@app.function(image=image, secrets=[auth_secret])
@modal.asgi_app()
def web():
    from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
    from fastapi.responses import Response

    web_app = FastAPI(title="omnivoice")

    @web_app.get("/health")
    async def health():
        return {"ok": True}

    @web_app.post("/synthesize")
    async def synthesize(
        text: str = Form(...),
        language: str = Form("en"),
        voice_ref: UploadFile | None = File(default=None),
        voice_ref_text: str | None = Form(default=None),
        instruct: str | None = Form(default=None),
        num_step: int = Form(32),
        speed: float = Form(1.0),
        x_auth_token: str = Header(default=""),
    ):
        expected = os.environ.get("OMNIVOICE_TOKEN", "")
        if not expected or x_auth_token != expected:
            raise HTTPException(status_code=401, detail="unauthorized")

        voice_ref_bytes: bytes | None = None
        if voice_ref is not None:
            voice_ref_bytes = await voice_ref.read()

        wav_bytes, duration_seconds = OmniVoiceTTS().synthesize.remote(
            text=text,
            voice_ref_bytes=voice_ref_bytes,
            voice_ref_text=voice_ref_text,
            instruct=instruct,
            language=language,
            num_step=num_step,
            speed=speed,
        )

        return Response(
            content=wav_bytes,
            media_type="audio/wav",
            headers={"X-Audio-Duration-Seconds": str(duration_seconds)},
        )

    return web_app


# --- Local test entrypoint: `modal run infra/modal/omnivoice.py --text "Hello world"`
@app.local_entrypoint()
def main(text: str, output: str = "out.wav", steps: int = 32):
    wav_bytes, duration = OmniVoiceTTS().synthesize.remote(
        text=text,
        num_step=steps,
    )
    with open(output, "wb") as f:
        f.write(wav_bytes)
    print(f"Wrote {output} ({len(wav_bytes)} bytes, {duration:.2f}s)")

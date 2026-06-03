# Aquilla speaker diarization — Modal service (pyannote/speaker-diarization-3.1).
#
# Serverless GPU diarization. The sync-worker POSTs a job to `start`; we spawn
# the GPU work, which fetches the audio (an R2 presigned URL), runs pyannote,
# and POSTs the speaker turns back to the worker's callback URL. Async by design
# so a CF Worker never holds a multi-minute connection.
#
# Deploy:
#   modal deploy services/diarization/app.py
# Prerequisites (one-time):
#   1. Accept conditions on https://huggingface.co/pyannote/speaker-diarization-3.1
#      and create an HF token.
#   2. modal secret create huggingface HF_TOKEN=hf_xxx
#   3. modal secret create aquilla-diarization DIARIZATION_SHARED_SECRET=<random>
#      (the same secret the sync-worker uses to authenticate both directions)
#
# API note: written against Modal 1.0 (fastapi_endpoint, @app.cls). If the
# installed modal version differs, the decorator names may need a tweak.

import os

import modal

MODEL = "pyannote/speaker-diarization-3.1"
app = modal.App("aquilla-diarization")

HF_SECRET = modal.Secret.from_name("huggingface")          # provides HF_TOKEN
APP_SECRET = modal.Secret.from_name("aquilla-diarization")  # DIARIZATION_SHARED_SECRET


def _bake_model() -> None:
    """Run at image-build so the weights cache into the image layer (fast cold
    starts). Requires HF_TOKEN; the model is gated but MIT-licensed."""
    from pyannote.audio import Pipeline

    Pipeline.from_pretrained(MODEL, use_auth_token=os.environ["HF_TOKEN"])


image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg")
    .pip_install(
        "torch",
        "torchaudio",
        "pyannote.audio==3.1.1",
        "httpx",
    )
    .run_function(_bake_model, secrets=[HF_SECRET])
)


@app.cls(
    image=image,
    gpu="T4",
    secrets=[HF_SECRET, APP_SECRET],
    timeout=1800,            # 30 min ceiling for a long episode
    scaledown_window=120,    # keep a warm container ~2 min between jobs
)
class Diarizer:
    @modal.enter()
    def load(self) -> None:
        import torch
        from pyannote.audio import Pipeline

        self.pipeline = Pipeline.from_pretrained(MODEL, use_auth_token=os.environ["HF_TOKEN"])
        if torch.cuda.is_available():
            self.pipeline.to(torch.device("cuda"))

    @modal.method()
    def diarize_and_callback(
        self,
        job_id: str,
        audio_url: str,
        callback_url: str,
        num_speakers: int | None = None,
    ) -> None:
        """Fetch audio, diarize, POST turns to the worker callback. Always
        reports back — success OR failure — so the job never hangs (fail loud)."""
        import tempfile

        import httpx

        secret = os.environ["DIARIZATION_SHARED_SECRET"]
        try:
            with httpx.Client(timeout=300, follow_redirects=True) as c:
                resp = c.get(audio_url)
                resp.raise_for_status()
            with tempfile.NamedTemporaryFile(suffix=".audio", delete=False) as f:
                f.write(resp.content)
                audio_path = f.name

            kwargs = {}
            if num_speakers and num_speakers > 0:
                kwargs["num_speakers"] = num_speakers
            diarization = self.pipeline(audio_path, **kwargs)

            turns = []
            for turn, _, speaker in diarization.itertracks(yield_label=True):
                # pyannote labels look like "SPEAKER_00" → integer cluster index.
                idx = int(speaker.rsplit("_", 1)[-1]) if "_" in speaker else 0
                turns.append(
                    {
                        "startMs": round(turn.start * 1000),
                        "endMs": round(turn.end * 1000),
                        "speaker": idx,
                    }
                )
            _post(callback_url, {"jobId": job_id, "status": "succeeded", "turns": turns}, secret)
        except Exception as e:  # noqa: BLE001 — report any failure to the worker
            _post(callback_url, {"jobId": job_id, "status": "failed", "error": str(e)}, secret)
            raise


def _post(url: str, payload: dict, secret: str) -> None:
    import httpx

    with httpx.Client(timeout=60) as c:
        c.post(url, json=payload, headers={"X-Diarization-Secret": secret})


@app.function(image=image, secrets=[APP_SECRET])
@modal.fastapi_endpoint(method="POST")
def start(payload: dict):
    """Worker → Modal entrypoint. Authenticates the shared secret (in the body —
    server-to-server over HTTPS), then spawns the GPU job and returns
    immediately (the result arrives via the callback). fastapi is imported
    inside the body so this file stays importable wherever `modal deploy` runs."""
    from fastapi import HTTPException

    if payload.get("secret") != os.environ["DIARIZATION_SHARED_SECRET"]:
        raise HTTPException(status_code=401, detail="bad shared secret")

    for k in ("jobId", "audioUrl", "callbackUrl"):
        if not payload.get(k):
            raise HTTPException(status_code=400, detail=f"missing {k}")

    Diarizer().diarize_and_callback.spawn(
        payload["jobId"],
        payload["audioUrl"],
        payload["callbackUrl"],
        payload.get("numSpeakers"),
    )
    return {"accepted": True, "jobId": payload["jobId"]}

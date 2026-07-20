# Aquilla speaker diarization — Modal service (pyannote/speaker-diarization-3.1).
#
# Serverless GPU diarization. The sync-worker POSTs a job to `start`; we spawn
# the GPU work, which fetches the audio (an R2 presigned URL), runs pyannote,
# and POSTs the speaker turns back to the worker's callback URL. Async by design
# so a CF Worker never holds a multi-minute connection.
#
# Deploy:
#   modal deploy infra/modal/diarization.py
# Prerequisites (one-time):
#   1. Accept conditions on https://huggingface.co/pyannote/speaker-diarization-3.1
#      and create an HF token.
#   2. modal secret create aquilla-hf HF_TOKEN=hf_xxx        (model-access token)
#   3. modal secret create aquilla-diarization DIARIZATION_SHARED_SECRET=<random>
#      (the same secret the sync-worker uses to authenticate both directions)
# Deployed endpoint (genesis-ai-dev workspace):
#   https://genesis-ai-dev--aquilla-diarization-start.modal.run
#
# API note: written against Modal 1.0 (fastapi_endpoint, @app.cls). If the
# installed modal version differs, the decorator names may need a tweak.

import hmac
import ipaddress
import os
import socket
from urllib.parse import urlparse

import modal

MODEL = "pyannote/speaker-diarization-3.1"
app = modal.App("aquilla-diarization")

HF_SECRET = modal.Secret.from_name("aquilla-hf")            # provides HF_TOKEN (model-access)
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
        # Pinned, mutually-compatible stack. pyannote.audio 3.1.1 imports
        # torchaudio.set_audio_backend(), removed in torchaudio>=2.1 — so use a
        # newer pyannote (3.3.x dropped that call) with a stable torch pair, and
        # numpy<2 (torch 2.2 + pyannote 3.x predate numpy 2). Loads the
        # speaker-diarization-3.1 model fine.
        "torch==2.2.2",
        "torchaudio==2.2.2",
        "numpy<2",
        # pyannote 3.3.2 forwards use_auth_token= to hf_hub_download; pin a
        # contemporaneous huggingface_hub that still accepts it (removed in 1.x).
        "huggingface_hub==0.23.4",
        "pyannote.audio==3.3.2",
        "httpx",
        "fastapi[standard]",  # required in-image for @modal.fastapi_endpoint
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

    def _run(self, audio_bytes: bytes, num_speakers: int | None = None) -> list[dict]:
        """Core: bytes → pyannote → turns [{startMs,endMs,speaker}]. Plain
        helper (not a @method) so both the callback path and the smoke test
        reuse it without a remote round-trip."""
        import tempfile

        with tempfile.NamedTemporaryFile(suffix=".audio", delete=False) as f:
            f.write(audio_bytes)
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
                {"startMs": round(turn.start * 1000), "endMs": round(turn.end * 1000), "speaker": idx}
            )
        return turns

    @modal.method()
    def diarize(self, audio_bytes: bytes, num_speakers: int | None = None) -> list[dict]:
        """Synchronous: diarize raw bytes, return turns. Used by the smoke test."""
        return self._run(audio_bytes, num_speakers)

    @modal.method()
    def diarize_and_callback(
        self,
        job_id: str,
        audio_url: str,
        callback_url: str,
        num_speakers: int | None = None,
    ) -> None:
        """Fetch audio from a URL, diarize, POST turns to the worker callback.
        Always reports back — success OR failure — so the job never hangs."""
        import httpx

        secret = os.environ["DIARIZATION_SHARED_SECRET"]
        try:
            with httpx.Client(timeout=300, follow_redirects=True) as c:
                resp = c.get(audio_url)
                resp.raise_for_status()
            turns = self._run(resp.content, num_speakers)
            _post(callback_url, {"jobId": job_id, "status": "succeeded", "turns": turns}, secret)
        except Exception as e:  # noqa: BLE001 — report any failure to the worker
            _post(callback_url, {"jobId": job_id, "status": "failed", "error": str(e)}, secret)
            raise


def _post(url: str, payload: dict, secret: str) -> None:
    import httpx

    with httpx.Client(timeout=60) as c:
        c.post(url, json=payload, headers={"X-Diarization-Secret": secret})


def _assert_public_https_url(url: str, label: str) -> None:
    """Reject anything but a public https:// URL. `start` is only guarded by
    the shared secret (no network isolation — see admin.py's constant-time
    note), so if that secret ever leaks, `audioUrl`/`callbackUrl` would
    otherwise let a caller make this GPU container fetch/POST to arbitrary
    internal addresses (cloud metadata service, Modal-internal hosts, etc.).
    This is a pre-fetch check only — it doesn't re-validate after redirects."""
    from fastapi import HTTPException

    parsed = urlparse(url)
    if parsed.scheme != "https" or not parsed.hostname:
        raise HTTPException(status_code=400, detail=f"{label} must be an https URL")

    hostname = parsed.hostname.lower()
    if hostname == "localhost" or hostname.endswith(".local") or hostname.endswith(".internal"):
        raise HTTPException(status_code=400, detail=f"{label} host not allowed")

    try:
        resolved = {info[4][0] for info in socket.getaddrinfo(hostname, None)}
    except socket.gaierror:
        raise HTTPException(status_code=400, detail=f"{label} host does not resolve") from None

    for addr in resolved:
        ip = ipaddress.ip_address(addr)
        if not ip.is_global:
            raise HTTPException(status_code=400, detail=f"{label} resolves to a non-public address")


@app.function(image=image, secrets=[APP_SECRET])
@modal.fastapi_endpoint(method="POST")
def start(payload: dict):
    """Worker → Modal entrypoint. Authenticates the shared secret (in the body —
    server-to-server over HTTPS), then spawns the GPU job and returns
    immediately (the result arrives via the callback). fastapi is imported
    inside the body so this file stays importable wherever `modal deploy` runs."""
    from fastapi import HTTPException

    if not hmac.compare_digest(str(payload.get("secret") or ""), os.environ["DIARIZATION_SHARED_SECRET"]):
        raise HTTPException(status_code=401, detail="bad shared secret")

    for k in ("jobId", "audioUrl", "callbackUrl"):
        if not payload.get(k):
            raise HTTPException(status_code=400, detail=f"missing {k}")

    _assert_public_https_url(payload["audioUrl"], "audioUrl")
    _assert_public_https_url(payload["callbackUrl"], "callbackUrl")

    Diarizer().diarize_and_callback.spawn(
        payload["jobId"],
        payload["audioUrl"],
        payload["callbackUrl"],
        payload.get("numSpeakers"),
    )
    return {"accepted": True, "jobId": payload["jobId"]}


@app.local_entrypoint()
def smoke(audio: str, num_speakers: int = 0):
    """Local smoke test: diarize a local audio file on Modal GPU and print turns.
    Usage: modal run services/diarization/app.py --audio /path/to/clip.wav
    (optionally --num-speakers 2). Verifies deploy + model quality without the
    worker/callback."""
    with open(audio, "rb") as f:
        data = f.read()
    turns = Diarizer().diarize.remote(data, num_speakers or None)
    speakers = sorted({t["speaker"] for t in turns})
    print(f"\n=== {len(turns)} turns / {len(speakers)} speakers {speakers} ===")
    for t in turns:
        print(f"  {t['startMs']/1000:6.2f}s – {t['endMs']/1000:6.2f}s   speaker {t['speaker']}")

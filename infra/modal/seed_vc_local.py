"""
Seed-VC on your own machine, speaking the same HTTP contract as the Modal
deployment in `seed_vc.py` — `GET /health`, `POST /convert` (multipart `source`,
`reference`, optional `diffusion_steps` / `length_adjust` / `inference_cfg_rate`,
`X-Auth-Token` header) returning `audio/wav` — so the sync-worker cannot tell
the two apart. Built for Apple silicon (MPS); falls back to CPU elsewhere.

Run it through the wrapper, which clones upstream at the pinned commit and
builds the venv:
    pnpm seed-vc:local

Then point the local sync-worker at it in `sync-worker/.dev.vars`:
    SEED_VC_URL="http://127.0.0.1:8791/convert"
    SEED_VC_TOKEN="<same value as this server's SEED_VC_TOKEN>"

Environment:
    SEED_VC_DIR     upstream checkout (the wrapper sets it)
    SEED_VC_TOKEN   shared secret; required
    SEED_VC_HOST    bind address, default 127.0.0.1
    SEED_VC_PORT    default 8791
    SEED_VC_FP16    "1" to run half precision; default off (MPS fp16 is unreliable)
"""

import hmac
import os
import sys
import threading
import time
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import Response

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from seed_vc_core import SeedVCEngine  # noqa: E402

SEED_VC_DIR = os.environ.get("SEED_VC_DIR", "")
TOKEN = os.environ.get("SEED_VC_TOKEN", "")
HOST = os.environ.get("SEED_VC_HOST", "127.0.0.1")
PORT = int(os.environ.get("SEED_VC_PORT", "8791"))
FP16 = os.environ.get("SEED_VC_FP16", "") == "1"

# One GPU, one model: concurrent conversions would contend for the same device
# memory, so requests queue behind this lock instead.
_lock = threading.Lock()
_engine: SeedVCEngine | None = None


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global _engine
    started = time.monotonic()
    print(f"[seed-vc] loading model from {SEED_VC_DIR} (first run downloads weights)…", flush=True)
    _engine = await run_in_threadpool(SeedVCEngine, SEED_VC_DIR, FP16)
    print(
        f"[seed-vc] ready on {_engine.device} in {time.monotonic() - started:.1f}s — "
        f"http://{HOST}:{PORT}/convert",
        flush=True,
    )
    yield


app = FastAPI(title="seed-vc-local", lifespan=lifespan)


@app.get("/health")
async def health():
    return {"ok": _engine is not None, "device": _engine.device if _engine else None}


@app.post("/convert")
async def convert(
    source: UploadFile = File(...),
    reference: UploadFile = File(...),
    diffusion_steps: int = Form(10),
    length_adjust: float = Form(1.0),
    inference_cfg_rate: float = Form(0.7),
    x_auth_token: str = Header(default=""),
):
    if not hmac.compare_digest(x_auth_token, TOKEN):
        raise HTTPException(status_code=401, detail="unauthorized")
    if _engine is None:
        raise HTTPException(status_code=503, detail="model still loading")
    source_bytes = await source.read()
    reference_bytes = await reference.read()

    def run() -> bytes:
        with _lock:
            started = time.monotonic()
            wav = _engine.convert(
                source_bytes,
                reference_bytes,
                diffusion_steps=diffusion_steps,
                length_adjust=length_adjust,
                inference_cfg_rate=inference_cfg_rate,
            )
            print(f"[seed-vc] converted in {time.monotonic() - started:.1f}s", flush=True)
            return wav

    wav = await run_in_threadpool(run)
    return Response(content=wav, media_type="audio/wav")


if __name__ == "__main__":
    if not SEED_VC_DIR or not os.path.isdir(SEED_VC_DIR):
        sys.exit("SEED_VC_DIR must point at an upstream seed-vc checkout (use `pnpm seed-vc:local`).")
    if not TOKEN:
        sys.exit("SEED_VC_TOKEN is required — use the same value as sync-worker/.dev.vars.")
    uvicorn.run(app, host=HOST, port=PORT, log_level="warning")

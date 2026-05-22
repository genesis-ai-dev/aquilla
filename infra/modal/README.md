# Modal GPU services

GPU-backed inference that doesn't fit in a Cloudflare Worker. These deploy
independently of the `apps/*` Workers — they're standalone Modal apps. The
browser never calls them directly; the codex-web sync worker
(`apps/sync`, `POST /api/v1/voice/convert`) proxies, holding the endpoint URL and
shared secret as worker vars.

## `seed_vc.py` — voice cloning (timbre transfer)

Seed-VC zero-shot voice conversion. Input: a **source** wav (speech to keep —
typically Gemini/MMS TTS output) + a **reference** wav (voice to sound like).
Output: the source re-voiced into the reference timbre. Language-agnostic, so the
multilingual TTS path supplies pronunciation and Seed-VC only swaps the voice.

Pinned to the non-F0 speech model and warmed once per container, so requests after
the first reuse the loaded model. Auth via an `X-Auth-Token` header checked against
the `SEED_VC_TOKEN` secret.

### Deploy

```bash
pip install modal
modal setup
modal secret create seed-vc-auth SEED_VC_TOKEN=<a-long-random-string>
modal deploy infra/modal/seed_vc.py
```

The deploy prints the endpoint base URL. The conversion route is `POST /convert`
on that base; there's also `GET /health`.

### Smoke test

```bash
# Through the web layer (requires the token):
curl -X POST "<endpoint-base-url>/convert" \
    -H "X-Auth-Token: <SEED_VC_TOKEN>" \
    -F "source=@tts_output.wav" \
    -F "reference=@target_voice.wav" \
    -F "diffusion_steps=10" \
    --output converted.wav

# Or the model path directly, no web/auth:
modal run infra/modal/seed_vc.py --source tts_output.wav --reference target_voice.wav
```

### Wiring into the worker

Set on the sync worker (prod + staging):

```
SEED_VC_URL    = <endpoint-base-url>/convert
SEED_VC_TOKEN  = <same value as the Modal secret>
```

### Notes / knobs

- `diffusion_steps`: 4–10 fastest, 25 default, 30–50 best quality.
- `length_adjust`: leave at `1.0` so duration is preserved — the batch synth path
  reuses Whisper word-timings computed on the pre-conversion take to split the
  converted audio back per cell, which only works if duration is unchanged.
- First request on a fresh Volume downloads checkpoints (one-time); they persist in
  the `seed-vc-cache` Volume for later cold starts.
- F0 / singing conversion needs a different checkpoint and would be a separate
  class — this box is speech re-voicing only.

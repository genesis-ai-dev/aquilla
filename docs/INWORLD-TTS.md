# Inworld TTS 2 Flash (AQU-1189)

Aquilla's default cloud TTS / zero-shot clone engine is **Inworld TTS 2 Flash**
(`inworld-tts-2-flash`). OmniVoice weights are CC-BY-NC and must not run for
paying orgs. The Modal OmniVoice app (`infra/modal/omnivoice_app.py`) is
**non-commercial / unpaid-research only** and is not called by sync-worker.

## Where to put the API key

The browser never holds this secret. Only **sync-worker** calls Inworld.

1. Create a **read-write** API key in the [Inworld Portal](https://platform.inworld.ai/)
   (`inworld workspace add-key`, or Portal → API Keys). Instant Voice Cloning
   needs write access on `voices`.
2. Copy the key **as-is** (do not prefix `Basic ` — the worker adds that).

### Local `pnpm dev`

Put it in `sync-worker/.dev.vars` (gitignored). Copy from `.dev.vars.example`:

```
INWORLD_API_KEY="<paste portal key>"
# Optional overrides:
# INWORLD_API_BASE="https://api.inworld.ai"
# INWORLD_TTS_MODEL="inworld-tts-2-flash"
# INWORLD_DEFAULT_VOICE="Dennis"
```

Restart `pnpm dev` after editing `.dev.vars`. Wrangler loads that file into the
local sync-worker; a missing key returns `503 TTS not configured`.

### Deployed environments

Cloudflare Worker **secret** on the sync-worker (not a git-committed `[vars]`):

```bash
cd sync-worker
# development (dev.aquilla.app)
npx wrangler secret put INWORLD_API_KEY --env development

# production (aquilla.app)
npx wrangler secret put INWORLD_API_KEY --env production
```

`config/cloudflare-deployments.json` lists `INWORLD_API_KEY` as a required
**production** secret. Put the same secret on `--env development` before
hosted TTS will work on `dev.aquilla.app`. Optional model/endpoint overrides
may be set as Worker vars (`INWORLD_API_BASE`, `INWORLD_TTS_MODEL`,
`INWORLD_DEFAULT_VOICE`); they default to the values above. The put commands
are also documented in `sync-worker/wrangler.toml`.

Do **not** put the key in `VITE_*`, the SPA, or auth-worker.

## API used by sync-worker

| Purpose | Method | Path |
| --- | --- | --- |
| Synthesize | `POST` | `https://api.inworld.ai/tts/v1/voice` |
| Instant clone | `POST` | `https://api.inworld.ai/voices/v1/voices:clone` |

Auth header: `Authorization: Basic $INWORLD_API_KEY`.

Legacy project voices with `provider: "omnivoice"` are remapped to Inworld at
runtime (same hosted path, same clone-from-reference flow).

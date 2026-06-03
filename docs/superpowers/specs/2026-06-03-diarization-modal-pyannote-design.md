# Diarization via Modal-hosted pyannote 3.1 — Design

**Date:** 2026-06-03
**Status:** Approved direction (supersedes the in-browser wasm approach for B3).
**Builds on:** Timeline Part B (`2026-06-03-timeline-part-b-design.md`), Scope A.

## Why this supersedes the wasm approach

The in-browser sherpa-onnx wasm path hit three walls: it requires cross-origin
isolation (app-wide invasive), the only prebuilt model is Chinese (can't
separate English speakers), and a custom build needs an emsdk toolchain + long
compiles. Running the real **`pyannote/speaker-diarization-3.1`** pipeline on
**Modal** (serverless GPU) avoids all three and gives the gold-standard model.

- `pyannote/speaker-diarization-3.1` is **MIT-licensed → commercial OK**, but
  **gated on Hugging Face** (accept conditions once + use a free HF token).
- Modal scales to zero; a full episode diarizes for cents. ($5k credits ≈
  effectively unlimited here.)

## Architecture

```
audio/video import → clip in R2 (Scope A 5b)
        │
[user clicks "Diarize" on the media file]      ← explicit, opt-in, per file
        │  app → sync-worker  (auth + R2 presign + job row)
        ▼
sync-worker ──POST {jobId, r2_presigned_url, callbackUrl}──▶ Modal endpoint
        │                                   (shared-secret auth)
        │                                        pyannote 3.1 on GPU:
        │                                        fetch audio → diarize
        ◀──── POST {jobId, turns[]} ──────────── Modal callback when done
        │  store turns on job row; mark succeeded
        ▼
client polls GET /diarization/:jobId → turns
        │  turnsToSegments() [B3b] → emit source.cell.create per turn
        ▼  (medium='media', timing, speaker) + cast member per speaker
   media segments + cast — persisted in the D1 event log (durable result)
```

### Decisions (locked)
- **Worker-proxied**, never browser→Modal directly (keeps the Modal secret
  server-side, no CORS, audio stays in our trust boundary).
- **Explicit "Diarize" action** per media file (not auto-on-import) — GPU spent
  only when the user wants speaker splitting.
- **Async via callback webhook.** CF Workers can't hold a multi-minute
  connection, so: the Modal endpoint `.spawn()`s the job and returns
  immediately; when done, Modal **POSTs the turns back** to a worker callback
  URL (with `jobId` + shared secret). Worker stores them; client polls the
  worker. (Modal-side polling is the fallback if callbacks prove awkward.)
- **Result lives in the D1 event log.** The durable output is the media-segment
  cells + cast, created via the normal `source.cell.create` events (so it syncs
  + survives reload like everything else). A `diarization_jobs` table holds only
  the operational async state (status, modal call id, raw turns until applied).

## Components

### 1. Modal service — `services/diarization/app.py`
- `Image`: `pyannote.audio` + torch; **bake the model at image-build** using HF
  token from a **Modal Secret** (`huggingface`), so cold starts don't redownload.
- Class with `@modal.enter()` → load `Pipeline.from_pretrained(...)`, move to
  CUDA (GPU `T4`/`A10G`).
- Endpoint (FastAPI, `@modal.fastapi_endpoint` or `@app.function` + spawn):
  input `{ jobId, audioUrl, callbackUrl, numSpeakers? }`; spawns work; the
  worker fn downloads `audioUrl`, runs the pipeline, POSTs
  `{ jobId, turns:[{start,end,speaker}] }` to `callbackUrl` with the shared
  secret header. Auth on inbound via a shared-secret header.

### 2. sync-worker endpoints
- `POST /diarization/:projectId/:fileId/start` — authz (project member),
  presign the clip's R2 object, create a `diarization_jobs` row (status
  `queued`), call Modal endpoint with `{jobId, audioUrl, callbackUrl}`, return
  `{ jobId }`.
- `POST /diarization/callback` — shared-secret auth (NOT user auth); validates
  `jobId`, stores `turns_json`, sets status `succeeded` (or `failed` + error).
- `GET /diarization/:jobId` — returns `{ status, turns? , error? }` for client
  polling.

### 3. D1 — migration `0027_diarization_jobs.sql`
`diarization_jobs(id TEXT PK, project_id, file_id, status TEXT,
modal_call_id TEXT, turns_json TEXT, error TEXT, created_at, updated_at)`.
(0025 = segment metadata [merged]; 0026 = files_filled_count [in progress];
0027 = this.)

### 4. Client
- A **"Diarize" action** on a media file (Media layer / file menu). Calls start,
  then polls `GET /diarization/:jobId`. On `succeeded`: run `turnsToSegments`
  (B3b), then for each distinct speaker create/assign a cast member
  (`speakerLabel` → "Speaker 1..N", user-renameable), and emit one
  `source.cell.create` (medium='media', timing, the shared clip attached with
  the turn's trim window) per turn. Replaces the file's existing media segments
  (or appends — TBD: confirm replace-vs-merge).
- Progress UI: "Diarizing… (running on GPU)" with the poll; failure surfaces
  the error (fail loud).

## Keep / drop from prior Part B work
- **Keep:** `turnsToSegments`, `speakerLabel` (`src/lib/timeline/diarization.ts`)
  — the turns→segments+cast mapping is reused verbatim. Tests stay.
- **Drop:** `src/lib/timeline/diarization-loader.ts` (wasm loader),
  `resampleToMono16k` (server handles audio), the gitignored
  `public/sherpa-diarization/` bundle (55 MB). The COI question is moot.
- **R2 `aquilla-ai-models` bucket:** no longer needed for diarization. Keep it
  (harmless, useful general bucket) or delete — low priority.
- **RMS silence-split (B1/B2):** stays as the instant, offline, zero-GPU default
  for media import. Diarization is the opt-in "quality + speaker labels" upgrade.

## Prerequisites (user actions — agent can't do these)
1. Accept conditions on https://huggingface.co/pyannote/speaker-diarization-3.1
   (and the segmentation-3.0 + embedding deps it pulls) + create an HF token.
2. `modal token new` (or grant the agent Modal access) so the service can be
   `modal deploy`-ed. Add the HF token as a Modal Secret named `huggingface`.

## Privacy
Audio leaves the browser to Modal — but it already lives in R2 (cloud), and
Modal pulls from R2, so this is the same trust boundary already in place. Note
for the Paratext cohort; not a new exposure.

## Cost
T4 ~$0.60/GPU-hr; an episode diarizes in a few GPU-minutes → pennies. Scale to
zero between jobs. $5k credits is effectively unlimited for this workload.

## Open / deferred
- Replace-vs-merge when re-diarizing a file that already has media segments.
- Cold-start latency (loading torch + pipeline) — accept for async jobs; add a
  keep-warm only if it bites.
- `numSpeakers` hint: let the user optionally say "2 speakers" to improve
  clustering (pyannote accepts `num_speakers` / `min/max`).
- Mapping diarization speakers across files/episodes (same actor = same cast)
  — later; first pass is per-file Speaker 1..N.

## Implementation plan
- **M1 ✅ DONE + VERIFIED** — `services/diarization/app.py` deployed to Modal
  (`https://ryderwishart--aquilla-diarization-start.modal.run`). Smoke-tested on
  Modal GPU: pyannote's real 30s demo sample → **3 speakers / 12 turns with
  overlap** (correct). Secrets: `aquilla-hf` (HF_TOKEN) + `aquilla-diarization`
  (shared secret). Dep stack pinned (torch 2.2.2, hf_hub 0.23.4, pyannote 3.3.2).
  - Finding: synthetic macOS `say` voices merge to 1 speaker (degenerate TTS
    embeddings) even though segmentation boundaries are exact — a test-data
    artifact, NOT a pipeline issue. Validate future changes on real human audio.
  - The optional `num_speakers` hint is worth surfacing in the UI (helps when
    the user knows the count).
- **M2 ✅** — migration `0027_diarization_jobs` + sync-worker `/api/v1/diarization/{start,status,audio,callback}` (async, callback, token-gated audio fetch). tsc clean.
- **M3 ✅** — `emitSourceCellDelete` + `run-diarization.ts` (start→poll→apply: replace media cells with per-turn `medium:'media'` cells + "Speaker N" cast) + ProjectWorkspace "Diarize" button. tsc clean; tests green.
- **M4 — verify end-to-end** (next). REQUIRES the worker publicly reachable (Modal callback + audio fetch): deploy the sync-worker (secrets now set) or run a `cloudflared` tunnel for local dev, set `DIARIZATION_PUBLIC_BASE` accordingly, then drive a real multi-speaker clip in the app.
- Cleanup — remove wasm loader + `resampleToMono16k` (dead since the pivot).

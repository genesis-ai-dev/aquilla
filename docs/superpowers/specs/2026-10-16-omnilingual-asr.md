# Omnilingual ASR transcription (CTC auto + zero-shot opt-in)

Status: design, 2026-10-16. Branch `feat/omnilingual-asr` (off origin/dev).

## Goal

Transcribe low-resource languages that Whisper cannot handle. We do this with Meta's
[Omnilingual ASR](https://github.com/facebookresearch/omnilingual-asr) (Apache 2.0),
self-hosted on Modal. The service has two models:

- **Omnilingual CTC 1B.** It runs automatically when Whisper does not support the
  audio's language. Whisper (OpenRouter `whisper-1`) still runs for every language it
  supports.
- **Omnilingual LLM 7B Zero-Shot (ZS).** A user opts into it in their Preferences. It
  learns the language from up to 10 (audio, transcript) pairs taken from the same
  project. This model matters most for languages that no ASR model has seen.

## Decisions (from Ryder, 2026-10-16)

| Topic | Decision |
|---|---|
| Model selection | **Automatic by language.** Whisper when Whisper supports the language, otherwise Omnilingual CTC. ZS is an explicit opt-in per user. |
| ZS examples | **Automatic from the project.** Prefer examples whose *source text* is similar to the cell being transcribed. Otherwise use any valid examples. Skip ultra-short clips. |
| Org gate | **Org admins** can turn ZS off. The setting is **on by default**, and each user must still pick ZS. |
| Pricing | **Metered GPU time.** Cost = GPU-seconds × GPU rate × amortization factor, then the usual credit markup. **No price before a single run.** Before a **batch** run, show the % of remaining credits the batch will use. |
| Cold start | ZS starts slowly. A toast with a progress indicator polls the service's status until the model is ready, then the run starts. |

## Facts from the upstream repo

- CTC 1B: about 3 GiB of VRAM and 3.7 GiB of weights. RTF is 0.002 on an A100 (RTF = processing time ÷ audio length).
- LLM 7B ZS: about 20 GiB of VRAM and 30 GiB of weights. RTF is 0.194 on an A100.
- Input must be **shorter than 40 s**. ZS was trained on context clips of up to 30 s.
- ZS API: `pipeline.transcribe_with_context(audio, context_examples=[[ContextExample(path, text), …]], batch_size=1)`. It takes 1–10 examples. The model has exactly 10 slots: it duplicates examples when there are fewer than 10 and drops examples beyond 10.
- Language codes have the form `{iso639-3}_{Script}`, for example `eng_Latn`. CTC has no language conditioning. The LLM models accept an optional `lang`.
- **The pipeline does not output timestamps.** Aquilla needs word timings (`chunks`), so the service must align the words itself (see below).

## Architecture

```
client (transcribe-hosted.ts)
  ├─ ZS selected? → POST /api/v1/audio/transcriptions/warm + poll …/status  (toast)
  ├─ ZS selected? → GET sync-worker /api/v1/projects/:id/transcription-examples   (pick ≤10 pairs)
  └─ POST auth-worker /api/v1/audio/transcriptions { model, language(BCP-47), examples? }
        ├─ Whisper-supported + model=auto → OpenRouter whisper-1   (unchanged)
        └─ otherwise → Modal omnilingual-asr /transcribe  (shared secret)
               returns { text, words[{text,start,end}], gpuSeconds, gpu }
        billing: rawCents = gpuSeconds × rate[gpu] × OMNI_ASR_AMORTIZATION → reserve/settle
```

### 1. Modal service: `infra/modal/omnilingual_asr.py`

The structure, decorators, pins and secrets follow `diarization.py`.

- `OmniCTC` class, **L4**. It loads `omniASR_CTC_1B`. Weights are baked into the image at build time. `scaledown_window=300`.
- `OmniZS` class, **L40S 48 GB** to start. If benchmarks show it doesn't fit, switch to an A100-80GB. It loads `omniASR_LLM_7B_ZS`, with weights in a `modal.Volume` because a 30 GB image layer is too large. `scaledown_window=600`.
- Both classes also load **CTC 300M as the aligner**. It runs CTC forced alignment (`torchaudio.functional.forced_align`) of the hypothesis text against the audio's CTC emissions. The aligner produces word start/end times. If forced alignment fails for a script, the fallback spreads timings evenly by character within the segment. The response then carries `timingsApproximate: true`.
- Web endpoints (FastAPI). Every endpoint checks `X-Omni-Secret` with a constant-time compare.
  - `POST /transcribe`: body `{ model: "ctc"|"zs", audio: <base64 16 kHz mono WAV, <40 s>, lang?: "xxx_Scrp", examples?: [{ url, text }] }`. The service fetches each example URL (presigned R2 URL, host allow-listed as in diarization), resamples it, and trims it to 30 s. Response: `{ text, words, gpuSeconds, gpu, timingsApproximate }`. `gpuSeconds` is the wall time inside the GPU method.
  - `POST /warm {model}`: `.spawn()`s a no-op on the class so a container starts. Returns immediately.
  - `GET /status?model=zs`: returns `{ state: "cold"|"starting"|"ready" }`. This reads a `modal.Dict` that `@modal.enter` sets (`starting` → `ready` with a heartbeat timestamp) and `@modal.exit` clears. Any state whose heartbeat is older than 90 s counts as `cold`.
- Secrets: `aquilla-omni-asr` (`OMNI_SHARED_SECRET`). Deploy is manual (`modal deploy`), in the genesis-ai-dev workspace.

### 2. Example selection: sync-worker `GET /api/v1/projects/:projectId/transcription-examples`

The query takes `lane` (target lane tag), `sourceText?`, `excludeCellId?` and `limit` (default 10, max 10). The route sits behind the normal project read wall (role ≥ contributor).

- Candidates come from `cell_audio a` (`deleted=0`, `selected=1`, same lane resolution as `cell-audio-read-route.ts`) joined to the target `cells c` with non-empty `value`.
  - The effective duration is `duration_ms` minus trims. Only **2 s ≤ duration ≤ 30 s** qualifies; clips under 2 s teach the model almost nothing.
  - Rank 0: validated take or validated cell (`validator_count > 0` or `c.validated`).
- **Similarity.** When `sourceText` is given, the route scores each candidate by token overlap with the candidate's source cell text: lower-cased word sets, Jaccard similarity. The score is computed in the Worker over at most the 500 newest qualifying candidates. Order: validated first, then similarity descending, then a duration near 8–15 s, then newest. With no `sourceText`, the order is validated, then duration, then newest.
- Response: `[{ cellId, fileId, text, durationMs, audioUrl }]`. `audioUrl` is a short-lived (10 min) presigned R2 GET URL.
- With zero results, the client blocks ZS for that run and falls back to the automatic model. A toast tells the user that ZS needs at least one recorded and transcribed cell in this language.

### 3. auth-worker route `routes/transcription.ts`

- Schema: add `model?: "auto" | "zs"` (default `auto`). `language` is loosened to a BCP-47 tag (`^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$`). Add `examples?: [{ url, text }]` (≤10, URLs must be our R2 presign host).
- Routing:
  - `auto`: when `whisperLanguageFromTag(tag)` is defined, use the existing Whisper path, **byte-for-byte unchanged**. Otherwise call Modal `ctc` with `lang` from `omniLanguageFromTag(tag)`.
  - `zs`: org gate (below), at least one example required, then call Modal `zs`.
- The audio cap stays at 60 s per request. The **client** cuts audio into windows of 30 s or less for Omnilingual (`windowSamples` depends on the route). The server rejects Omnilingual audio of 40 s or longer.
- Org gate: read `org_settings.settings.transcription?.zeroShotEnabled` for the project's org. If it is `false`, return 403 `zero_shot_disabled`. Absent means enabled.
- Billing, for Omnilingual only:
  - Bound = `ceil(audioSec × MAX_RTF[model] + 30) × rate[gpu] × amort`.
  - `reserveWorkspaceUsage` with that bound.
  - After the call: `rawCents = gpuSeconds × rate[gpu] × OMNI_ASR_AMORTIZATION`. Settle with this through `settleWorkspaceUsage`, or `recordCredit` in legacy mode.
  - The rates live in `db/shared/billing-cost.ts`-style constants (`OMNI_GPU_CENTS_PER_SEC = { L4: 0.0222, L40S: 0.0542, A100_80: 0.0694 }`). They must be checked against Modal pricing at deploy time. `OMNI_ASR_AMORTIZATION` is an env var with default 1.5; it covers idle scaledown time and cold starts.
  - The existing ×4 credit markup applies on top.
- New thin proxies `POST /api/v1/audio/transcriptions/warm` and `GET …/status?model=zs` check auth, then forward to Modal. Warming is free, and only a project member can trigger it.

### 4. Language mapping: `src/lib/audio/omni-language.ts` (also imported by the worker, or duplicated)

`omniLanguageFromTag(bcp47)` maps the tag to `xxx_Scrp`:

- An ISO 639-1 code becomes 639-3 (extend the existing map in `language.ts`).
- The script comes from an explicit subtag, or a small default-script table. When the script is unknown, the function returns `undefined` and the request goes to CTC without `lang`.

`whisperLanguageFromTag` itself does not change. The client now sends the **raw tag** to the server, and the server makes the decision.

### 5. Client

- **Preferences → Transcription** (`LocalModelsSection.tsx`): when the provider is Hosted, show a model radio. "Automatic (Whisper, or Omnilingual for languages Whisper doesn't know)" is the default. "Omnilingual Zero-Shot (learns from this project's recordings; slower; uses more credits)" is hidden when the active org has turned it off. The choice is stored per user in localStorage, like the provider (`aq.transcription-model.v1.<username>`). Selecting ZS fires `/warm`.
- **Org settings**: org admins get a toggle "Allow zero-shot transcription" (`OrgWideSettings.transcription.zeroShotEnabled`, default true). The permission policy key is owner/maintainer.
- **Warm-up toast** (`src/lib/audio/omni-warmup.ts` + component). When a ZS run starts and `/status` is not `ready`, the client fires `/warm` and shows a persistent toast. The toast has `IntelligentProgress` and the text "Starting the zero-shot model, about 1–3 minutes". It polls `/status` every 4 s with a 6 min cap. When the status is `ready`, the toast closes and the queued transcription runs. If the cap is reached, the toast shows an error and offers Retry or Use automatic. All runs that are queued at once share a single warm-up.
- **Batch** (`batch-audio.ts` / `BatchVoiceDialog`): with ZS selected, the dialog shows a confirm line before the run, for example "≈ 12% of this week's remaining credits".
  - Estimate = total audio sec × `ZS_EST_GPU_SEC_PER_AUDIO_SEC` × rate × amort × markup.
  - The client takes `ZS_EST_GPU_SEC_PER_AUDIO_SEC` from `/status`, so the server owns it.
  - The remaining credits come from `GET /api/v1/usage/org/:orgId/credits` (`remaining`). When that endpoint returns 403, the dialog shows an absolute "≈ N credits" instead.
- `transcribe-hosted.ts`: for Omnilingual routes, use a 30 s window instead of 60 s. Pass `model`, the raw `language` tag and `examples`. Fetch examples once per cell, keyed by `sourceText` = the cell's source text.

## Risks / unknowns to retire first

1. **Forced alignment with the Omnilingual CTC vocabulary.** We need to confirm that the tokenizer is character-level enough for `forced_align`, by spiking it on the Modal box. The fallback is approximate timings. Prior art: `fia_align` (MMS_FA) in the sibling fia repo.
2. **ZS memory with 10 × 30 s context.** Check whether it fits on an L40S. A benchmark run decides between L40S and A100-80GB. It also measures the real GPU-seconds per audio-second that feed `ZS_EST_GPU_SEC_PER_AUDIO_SEC`.
3. **Cold start for 30 GB of weights from a Volume.** A cold start takes an estimated 1–3 min. Measure it and put the real number in the toast copy.
4. **fairseq2 / torch pins on Modal.** The upstream repo does not pin versions. Expect a pinning pass like the pyannote one.
5. **Preview limitation.** The client calls sync-worker (examples) and auth-worker (transcribe) separately, so preview deploys can test this path, because it doesn't cross the sync→auth seam. Modal calls from a preview need the secret set on the preview auth-worker.

## Out of scope (this PR)

- On-device or Tauri Omnilingual (sherpa-onnx CTC 300M). That is a follow-up.
- User-pinned example sets, and the "Unlimited" long-form variants.
- Platform-admin feature-flag system (lives on unmerged `feat/dcs-package-flags`).

## Verification

- Modal: run `modal run` with a smoke script on a known-language clip (eng) and on a low-resource clip, for both CTC and ZS. Record the RTF, the cold-start time and the GPU used.
- auth-worker unit tests:
  - Whisper routing does not change for supported tags.
  - Unsupported tags route to Modal CTC.
  - ZS returns 403 when the org disables it.
  - ZS returns 400 without examples.
  - Billing settles `gpuSeconds × rate × amort` and never zero.
- sync-worker tests: the examples route skips clips under 2 s and over 30 s, ranks validated and similar examples first, and enforces the read wall.
- Client tests:
  - Window size per route.
  - The warm-up poller resolves when the state is ready and times out at the cap.
  - The batch % estimate.
- Live: transcribe a real low-resource-language take in the dev stack with ZS.

# Transcription model choice: Omnilingual ASR, Qwen3-ASR, zero-shot

Status: draft for review · 2026-10-16 · branch `feat/omnilingual-asr`

## Goal

Hosted transcription today always calls OpenRouter `openai/whisper-1`
(`auth-worker/src/routes/transcription.ts`). Whisper covers 99 languages, so many
projects get auto-detect and poor output. This change adds three models and a
picker:

| Model id (ours)   | Backend                                    | Languages | Word timings | Cost basis |
|-------------------|--------------------------------------------|-----------|--------------|------------|
| `whisper`         | OpenRouter `openai/whisper-1` (unchanged)  | 99        | yes (provider) | provider `usage.cost` |
| `qwen3-asr`       | OpenRouter `qwen/qwen3-asr-1.7b`           | 30 + 22 Chinese dialects | yes (provider, verified 2026-10-16) | provider `usage.cost` |
| `omni-ctc`        | Modal, `omniASR_CTC_1B_v2`                 | 1,668     | ours (CTC forced alignment) | metered GPU-seconds |
| `omni-zs`         | Modal, `omniASR_LLM_7B_ZS` + project examples | any (few-shot) | ours (CTC forced alignment) | metered GPU-seconds |

Facts checked on 2026-10-16:

- Qwen3-ASR on OpenRouter accepts our current request shape (`input_audio`,
  `language`, `verbose_json`, `timestamp_granularities`). A live probe returned
  `words[]` and `usage.cost`. List price is about $0.00045/min, against $0.006/min
  for whisper-1.
- Omnilingual CTC and LLM accept clips **under 40 s** only. ZS accepts up to
  60 s per the inference README, but was trained on ≤30 s. Omnilingual returns no
  timestamps.
- ZS takes 1–10 `(audio, transcript)` context examples. Fewer than 10 are
  duplicated; more are cropped. Each example should be ≤30 s.
- Omnilingual code and weights are Apache 2.0. Qwen3-ASR is Apache 2.0.

## Decisions (from Ryder, 2026-10-16)

1. **Auto by language.** The default is "Automatic". The server picks the model
   from the project language. Users can override in Preferences.
2. **ZS examples come from the project**, and they should be similar to the
   cell being transcribed (see §4). Ultra-short clips are excluded.
3. **ZS is gated per org by org admins, default ON.** The user must still pick
   it, because Automatic never chooses ZS.
4. **Metered GPU-time billing.** Before a run, show a cost only for **batch**
   jobs, as "about N% of this week's remaining credits". Single-cell runs show no
   price.

## 1. Automatic routing (server, `pickAsrModel(languageTag)`)

1. The tag is a Chinese variety (`zh*`, `yue`, `cmn`, `wuu`, `nan`, `hak`, …) or
   in the Qwen set → `qwen3-asr`.
2. The tag is in the Whisper set → `whisper` (no change for current users).
3. The tag is in the Omnilingual set → `omni-ctc`.
4. Unknown or empty tag → `whisper` with auto-detect (today's behaviour).

**Open question for review:** Qwen3-ASR is about 13× cheaper than whisper-1 and
covers the 30 largest languages. Should it replace Whisper in step 2 for those
30? This draft keeps Whisper so existing users see no change.

## 2. Language catalogs (picker)

`src/lib/audio/asr-catalog/` ships one static list per model:

- `whisper.ts`: reuse `WHISPER_TWO_LETTER` + `THREE_TO_TWO` from `language.ts`.
- `qwen3-asr.ts`: the 30 ISO codes plus the 22 named dialects (display only;
  OpenRouter has no dialect parameter, so dialects are recognized under
  `zh`/`yue`).
- `omnilingual.json`: the 1,668 `xxx_Script` codes from upstream
  `src/omnilingual_asr/models/wav2vec2_llama/lang_ids.py`, about 27 KB. It is
  lazy-loaded so it stays out of the main bundle.

The picker row for each model shows **"Supports <project language>" ✓/✗** and a
"See all N languages" disclosure with a search box. `omni-zs` shows "Any
language. Learns from your project's recorded takes" and the number of usable
examples the project has.

A shared helper maps a BCP-47 project tag to each model's code:
`toWhisperCode`, `toQwenCode`, and `toOmniCode`. `toOmniCode` maps ISO 639-1 to
639-3 (we already have the reverse map), then takes the script from the tag, or
the first upstream match for that language.

## 3. Modal service `infra/modal/omnilingual_asr.py`

Follows the `diarization.py` conventions: weights are baked into the image, and
auth is a shared secret. The calls are synchronous, because a clip is ≤40 s and
the request finishes in seconds once warm.

- `OmniCtc` class: L4 GPU, CTC 1B v2 (~3 GiB VRAM), `scaledown_window` 300 s.
- `OmniZs` class: one 48 GB-class GPU (L40S or A100-40GB; ~20 GiB VRAM). It runs
  ZS 7B plus CTC 300M for alignment. `scaledown_window` 600 s.
- Word timings come from CTC emissions + `torchaudio.functional.forced_align` on
  the output transcript. The result is mapped to `{text, chunks:[{text,start,end}]}`.
- Every response includes `gpu_seconds` (wall time inside the GPU method) and
  `gpu` (type), which billing uses.
- Endpoints:
  - `POST /transcribe` `{model, audio_b64, lang?, examples?:[{audio_url,text}]}`.
  - `POST /warm` `{model}` spawns a no-op on the class. That starts a container
    and returns at once.
  - `GET /status?model=` returns `{state:"cold"|"starting"|"ready"}` from a
    `modal.Dict` heartbeat. `@modal.enter` writes the heartbeat when loading
    finishes, and each call refreshes it.

Secrets: `aquilla-omni-asr` holds `OMNI_ASR_SHARED_SECRET`. auth-worker env:
`OMNI_ASR_MODAL_URL` and `OMNI_ASR_SHARED_SECRET`.

## 4. ZS example selection (sync-worker, new route)

`GET /api/v1/projects/:projectId/transcription-examples?lane=<tag>&cellId=<id>&limit=10`

- Candidates: selected, non-deleted `cell_audio` takes on the lane whose cell
  has non-empty target text. Effective duration
  (`duration_ms` minus trims) must be between **2 s and 30 s**. Takes with
  `validator_count > 0` or a validated cell rank first.
- **Similarity:** when the requesting cell has source text, rank candidates by
  word overlap between their source text and that source text (BM25 over the
  candidates' source cells), then by validation, then by closeness in duration.
  With no source text, rank by validation, then by spread across files.
- The target cell itself is excluded.
- Response: `[{cellId, text, audioUrl (short-lived presigned R2), durationMs}]`.
- The client calls this and forwards the examples in the transcription request.
  It is the user's own project data and credits, so the auth-worker does not
  re-select. This also avoids the sync→auth hop, which previews can't exercise.

When no example qualifies, ZS returns a typed error `zs_no_examples`. The client
then offers "Use Omnilingual standard instead".

## 5. Route changes (`auth-worker/src/routes/transcription.ts`)

- Request gains `model?: "auto"|"whisper"|"qwen3-asr"|"omni-ctc"|"omni-zs"`
  (default `auto`) and `examples?`. `language` widens from `^[a-z]{2,3}$` to a
  BCP-47 tag, which the server maps per model.
- Response gains `model` (the one actually used), so the client can show it.
- The two OpenRouter models share today's path. Only the `model` string and the
  price lookup change (`transcriptionCostBound` already reads the catalog per
  model).
- Omni models:
  - Org gate for ZS: `org_settings.settings.transcriptionZeroShot !== false`.
    If it is off, return 403 `zs_disabled`.
  - Reserve with a bound computed as
    `maxGpuSeconds(model, audioSeconds, examplesSeconds) × rate × amortization`.
  - Call Modal, then settle with
    `raw = gpu_seconds × GPU_RATE[gpu] × OMNI_ASR_AMORTIZATION` (env; start at
    1.5 to cover idle scale-down time and cold starts). The normal 4× credit
    multiplier from `db/shared/billing-cost.ts` applies on top.
  - When Modal reports a cold container, return 503 `asr_warming` with
    `Retry-After`. The client never holds a request through a multi-minute cold
    start.
- The client chunks Omnilingual audio into **≤30 s windows**, split at the
  lowest-energy point near each boundary. Whisper and Qwen keep 60 s windows.

## 6. Client

- **Preference** (`transcription-preference.ts`): add a per-user model key
  `aq.transcription-model.v1.<username>`, default `auto`, next to the existing
  hosted/local provider key.
- **Picker** (`LocalModelsSection.tsx`, Preferences): a radio list of
  Automatic, Whisper, Qwen3-ASR, Omnilingual, Omnilingual Zero-Shot. Each row
  shows the catalog row from §2. ZS is hidden when the org has it disabled.
- **Org setting**: an org-admin toggle "Allow zero-shot transcription", stored
  in `OrgWideSettings.transcriptionZeroShot` (absent means on).
- **Warm-up UX:** when ZS is the selected model, the client calls `/warm` once
  when the user picks it in Preferences, and again when a transcription starts.
  If the route returns `asr_warming`, one persistent toast appears: "Starting the
  zero-shot model. First use takes a minute or two." It shows `IntelligentProgress`
  and polls `/status` every 5 s. When the state is `ready`, the toast resolves and
  queued cells continue. Cells waiting on the warm-up show "Waiting for model" in
  `transcribe-status`.
- **Batch estimate** (`BatchVoiceDialog` / batch-audio): estimated credits =
  total audio seconds × the model's published credits-per-audio-second (a server
  constant, measured after deploy). It shows as a percentage of
  `remaining` from `GET /api/v1/usage/org/:orgId/credits`. When that endpoint
  returns 403 for non-maintainers, it shows the absolute estimate instead.

## 7. Tests (intent)

- `pickAsrModel` routes Cantonese to Qwen, Swahili to Whisper, and a
  Whisper-unsupported code (for example `tpi` Tok Pisin) to Omnilingual.
- The ZS gate: an org with `transcriptionZeroShot:false` gets 403 even if the
  client sends `omni-zs`.
- Billing: settle uses Modal's `gpu_seconds`, not audio length. Test that a
  10 s clip with 40 s of GPU time is billed for 40 s.
- Example ranking: a candidate sharing source words outranks a validated but
  unrelated one. Clips under 2 s are excluded.
- Warm-up: `asr_warming` → toast → `ready` → the queued cell is transcribed
  exactly once.

## 8. Out of scope

- On-device Omnilingual (sherpa-onnx 300M for Tauri) is a later ticket.
- User-pinned example sets ("auto + pinnable") are a later ticket.
- Omnilingual "Unlimited" variants for long files are not needed, because we
  chunk.

## 9. Ryder-only steps

- `modal deploy infra/modal/omnilingual_asr.py` in the genesis-ai-dev
  workspace, plus `modal secret create aquilla-omni-asr …`.
- `wrangler secret put OMNI_ASR_SHARED_SECRET` on the auth-worker envs.
- After the first deploy, measure real GPU-seconds per audio-second for ZS and
  CTC, and set the batch-estimate constants.

# Transcription models: Omnilingual ASR (CTC + zero-shot), Qwen3-ASR, model picker

Status: design, 2026-10-16. Branch `feat/omnilingual-asr` (off origin/dev).
This spec merges two drafts written the same day. The first is this file's
earlier version, which covered Modal, zero-shot, billing and warm-up. The second
is `2026-10-16-omnilingual-asr-design.md`, which covered the model picker, the
language catalogs and Qwen3-ASR; that file is now deleted. Where the two drafts
named the same thing differently, this spec keeps the names that the
in-progress server and client branches already use.

## Goal

Hosted transcription today always calls OpenRouter `openai/whisper-1`. Whisper
covers 99 languages, so many of our projects get auto-detect and poor output.
This work adds three models and a picker that tells the user which model supports
the project's language.

| Model id (ours) | Backend | Languages | Word timings | Cost basis |
|---|---|---|---|---|
| `whisper` | OpenRouter `openai/whisper-1` (unchanged) | 99 | provider | provider `usage.cost` |
| `qwen3-asr` | OpenRouter `qwen/qwen3-asr-1.7b` | 30 + 22 Chinese dialects | provider (verified 2026-10-16) | provider `usage.cost` |
| `omni-ctc` | Modal, `omniASR_CTC_1B` (v2 card if present) | 1,600+ | ours (CTC forced alignment) | metered GPU-seconds |
| `omni-zs` | Modal, `omniASR_LLM_7B_ZS` + project examples | any (few-shot) | ours (CTC forced alignment) | metered GPU-seconds |

## Decisions (from Ryder, 2026-10-16)

| Topic | Decision |
|---|---|
| Model selection | **Automatic by language** is the default; the server picks the model. Users can override the choice in Preferences with the picker. Automatic never picks ZS. |
| Picker | A catalog shows, for each model, whether it supports the project language, plus a searchable list of all the languages it supports. |
| ZS examples | **Automatic from the project.** Examples whose *source text* is similar to the cell's source text rank first. Clips under 2 s are excluded. |
| Org gate | **Org admins** can turn ZS off. It is **on by default**, and each user must still pick it. |
| Pricing | **Metered GPU time**: GPU-seconds × GPU rate × amortization, then the usual 4× credit markup. **No price is shown before a single run.** A **batch** run first shows the % of this week's remaining credits it will use. |
| Cold start | ZS starts slowly. A toast with a progress indicator polls the status endpoint until the model is ready, and then the queued work continues. |
| Agents | External agents can trigger transcription, including ZS, through the Agent API (REST) and the MCP server (§7). |

## Upstream facts (checked 2026-10-16)

- **Clip length.** Omnilingual CTC and LLM accept clips **under 40 s** only. ZS was trained on context clips of ≤30 s.
- **CTC 1B.** About 3 GiB of VRAM. Real-time factor (RTF) 0.002 on an A100.
- **ZS 7B.** About 20 GiB of VRAM and 30 GiB of weights. RTF 0.194 on an A100.
- **ZS context.** `pipeline.transcribe_with_context(audio, context_examples=[[ContextExample(audio, text), …]])` takes 1–10 examples. It repeats the examples to fill 10 slots when there are fewer, and crops anything beyond 10.
- **Timestamps.** Omnilingual returns plain text with no timestamps. Its tokenizer is a **char tokenizer** (`omniASR_tokenizer_v1`, `char_tokenizer`), so CTC forced alignment over characters is viable.
- **Qwen3-ASR on OpenRouter.** It accepts our current request shape and returns `words[]` and `usage.cost`. It costs about $0.00045/min, against $0.006/min for whisper-1.
- **Licenses.** Omnilingual and Qwen3-ASR are both Apache 2.0.

## 1. Automatic routing (server, `pickAsrModel(languageTag)`)

1. If the tag is a Chinese variety (`zh*`, `yue`, `cmn`, `wuu`, `nan`, `hak`, …) or is in the Qwen-only set, use `qwen3-asr`.
2. If the tag is in the Whisper set, use `whisper`. Existing users see no change.
3. If the tag is in the Omnilingual set, use `omni-ctc`.
4. If the tag is unknown or empty, use `whisper` with auto-detect, which is today's behavior.

**Open question (Ryder):** Qwen3-ASR is about 13× cheaper than Whisper. Should it
replace Whisper in step 2 for its 30 languages? Until Ryder answers, Whisper stays.

## 2. Language catalogs (picker)

`src/lib/audio/asr-catalog/` ships one static list per model:

- **`whisper.ts`** reuses `WHISPER_TWO_LETTER` and `THREE_TO_TWO` from `language.ts`.
- **`qwen3-asr.ts`** lists the 30 ISO codes plus the 22 named dialects. The dialects are display-only: OpenRouter has no dialect parameter, so they are recognized under `zh`/`yue`.
- **`omnilingual.json`** holds the `xxx_Script` codes from upstream `omnilingual_asr/models/wav2vec2_llama/lang_ids.py`. It is lazy-loaded so it stays out of the main bundle.

Each model gets one row in the picker:

- The row shows **"Supports <project language>" ✓/✗** and a "See all N languages" disclosure with a search box.
- The `omni-zs` row shows "Any language — learns from your project's recorded takes" and the number of usable examples the project has. That number comes from the examples route with `limit=10`.

Shared mapping helpers: `toWhisperCode`, `toQwenCode` and `toOmniCode`. They live in one
module that the client and the auth-worker both import, or that is duplicated with a parity test.

- `toOmniCode` maps ISO 639-1 to 639-3.
- It then takes the script from the tag's script subtag.
- Without a script subtag, it uses the first upstream code for that language.

## 3. Modal service `infra/modal/omni_asr.py`

The service follows the `diarization.py` conventions: a shared secret, and a URL allow-list for every fetched URL.

**Classes**

- **`OmniCTC`** runs on an L4 with CTC 1B. `scaledown_window` is 300 s.
- **`OmniZS`** runs on an L40S 48 GB, or an A100-80GB if the spike shows that is needed. It loads ZS 7B. `scaledown_window` is 600 s.
- **Weights** for both classes live in the `aquilla-omni-asr-weights` Volume. The 30 GB ZS checkpoint is too big for an image layer.
- **Word timings.** Both classes also load **CTC 300M as the aligner**. It runs a self-contained CTC Viterbi alignment (`_ctc_viterbi`) of the hypothesis text against the CTC emissions to produce word timings. We do not use `torchaudio.functional.forced_align`, which newer torchaudio drops. If alignment fails, the service spreads the timings proportionally and returns `timingsApproximate: true`.

**Endpoints.** Every endpoint is FastAPI and authenticated with `X-Omni-Secret`.

- **`POST /transcribe`**
  - Request: `{ model: "ctc"|"zs", audio: <base64 16 kHz mono WAV, <40 s>, lang?: "xxx_Scrp", examples?: [{ url, text }] }`.
  - Response: `{ text, words:[{text,start,end}], gpuSeconds, gpu, timingsApproximate }`.
  - If the ZS container is cold, it returns `{ warming: true }` immediately instead of blocking.
- **`POST /warm {model}`** `.spawn()`s a no-op so that a container starts, and returns immediately.
- **`GET /status?model=`** returns `{ state: "cold"|"starting"|"ready", estGpuSecPerAudioSec }`.
  - The state comes from a `modal.Dict` heartbeat. `@modal.enter` sets `starting` and then `ready`, every call refreshes the heartbeat, and `@modal.exit` clears it.
  - A heartbeat older than the ZS scaledown window plus 60 s (660 s) counts as `cold`. A shorter window would report an idle but still-warm container as cold.

**Secrets and deploy**

- Modal secret `aquilla-omni-asr` holds `OMNI_SHARED_SECRET`.
- The auth-worker needs `OMNI_ASR_MODAL_URL` (a var) and `OMNI_SHARED_SECRET` (a secret).

## 4. ZS example selection (sync-worker)

`GET /api/v1/projects/:projectId/transcription-examples?lane=<tag>&cellId=<id>&sourceText=<optional override>&limit=10`

The route sits behind the normal project read wall.

**Candidates.** The route takes selected, non-deleted `cell_audio` takes on the lane (same lane resolution as
`cell-audio-read-route.ts`) whose target cell has non-empty text. The effective duration (`duration_ms` minus trims) must be between **2 s and 30 s**. The requesting cell itself is excluded.

**Ranking.** When the requesting cell (looked up by `cellId`) or the `sourceText` override has source text, the route ranks candidates by word overlap between their source text and that text, in this order:

1. Token overlap (BM25 or Jaccard over lower-cased words; the implementation picks one, computed over at most the 500 newest candidates).
2. Validation (`validator_count > 0` or a validated cell).
3. Duration closest to 8–15 s.

Without source text, the order is validation, then spread across files, then newest.

**Response.** `[{ cellId, fileId, text, durationMs, audioUrl }]`. `audioUrl` is a presigned R2 URL that is valid for 10 minutes.

The client calls this route and forwards the examples in the transcription request. The examples are the user's own project data and the user pays the credits, so the auth-worker does not choose the examples again. This also avoids the sync→auth hop, which previews cannot exercise.

## 5. Route changes (`auth-worker/src/routes/transcription.ts`)

**Request and response**

- The request gains `model?: "auto"|"whisper"|"qwen3-asr"|"omni-ctc"|"omni-zs"` (default `auto`) and `examples?` (≤10, URLs on the R2 presign host only).
- `language` widens from `^[a-z]{2,3}$` to a BCP-47 tag, and the server maps it for each model.
- The response gains `model` (the model actually used) and `timingsApproximate`.

**OpenRouter models.** `whisper` and `qwen3-asr` share today's path. Only the model string and the per-model price lookup change; `transcriptionCostBound` already reads the price catalog per model.

**Omnilingual models**

- **Length.** Audio of 40 s or longer is rejected with 400.
- **ZS org gate.** If `org_settings.settings.transcription?.zeroShotEnabled === false`, the route returns 403 `zero_shot_disabled`. A missing setting counts as enabled.
- **ZS examples.** ZS with no examples returns 400 `zs_no_examples`.
- **Billing.** Reserve with the bound `ceil(audioSec × MAX_RTF[model] + examplesSec × k + 30) × rate × amort`. After the call, settle `rawCents = gpuSeconds × OMNI_GPU_CENTS_PER_SEC[gpu] × OMNI_ASR_AMORTIZATION`. The amortization is an env var with default 1.5. The normal 4× multiplier from `db/shared/billing-cost.ts` applies on top. A settlement must never be zero.
- **Cold start.** If Modal answers `{warming:true}`, the route releases the reservation and returns 503 `asr_warming` with `Retry-After: 10`.

**Warm-up proxies.** `POST /api/v1/audio/transcriptions/warm` and `GET …/status?model=` check auth and project membership, then forward to Modal.

**Windowing.** The client chunks Omnilingual audio into **≤30 s windows**, splitting at the lowest-energy point near each boundary. Whisper and Qwen keep 60 s windows.

## 6. Client

- **Preference.** `aq.transcription-model.v1.<username>` holds the model choice, default `auto`. It sits next to the existing hosted/local provider key.
- **Picker.** `LocalModelsSection.tsx` (Preferences) shows a radio list: Automatic, Whisper, Qwen3-ASR, Omnilingual, Omnilingual Zero-Shot. Each row shows its catalog entry from §2. The ZS row is hidden when the org has disabled ZS. Selecting ZS fires `/warm`.
- **Org setting.** Org admins get a toggle, "Allow zero-shot transcription", stored as `OrgWideSettings.transcription.zeroShotEnabled`. A missing value means on.
- **Warm-up.** `src/lib/audio/omni-warmup.ts` runs a single shared warm-up for all callers.
  - When a ZS transcription starts and `/status` is not `ready`, or the route returns `asr_warming`, one persistent toast appears with `IntelligentProgress`: "Starting the zero-shot model — about 1–3 minutes".
  - The toast polls `/status` every 4 s, with a 6-minute cap.
  - When the status turns `ready`, the toast resolves and the queued cells run, each exactly once. Waiting cells show "Waiting for model" in `transcribe-status`.
  - When the cap is reached, the toast shows an error with Retry and "Use automatic".
- **No examples.** On `zs_no_examples`, or when the examples route returns zero results, a toast offers "Use Omnilingual standard instead".
- **Batch estimate.** `BatchVoiceDialog` / batch-audio estimates the credits as total audio seconds × `estGpuSecPerAudioSec` (from `/status`) × rate × amortization × markup.
  - The estimate is shown as a percentage of `remaining` from `GET /api/v1/usage/org/:orgId/credits`.
  - That endpoint returns 403 for non-maintainers; in that case the dialog shows the absolute credit count instead.

## 7. Agent API / MCP

sync-worker's external surface (`/api/v1/external/*`, the MCP server, and the discovery doc) gains two tools:

- **`transcribe_audio`.**
  - Input: `(projectId, fileId, cellId)` or raw audio, plus `model` (same enum as §5), an optional `language`, and optional `exampleCellIds`. Without `exampleCellIds`, the tool picks examples automatically with the §4 ranking.
  - Output: `{text, words, model, timingsApproximate, creditsCharged}`.
  - The tool applies the same org gate, billing and windowing as §5. Agents get server-side windowing.
  - The output is read-only. Writing timings back to a cell goes through the changeset/approval gate.
  - Credentials are project-scoped PATs.
- **`transcription_status`** lets an agent warm ZS and poll for readiness.

docs/AGENT-API.md gets a worked ZS example for a low-resource language.

**Preview caveat.** A preview sync-worker cannot call a preview auth-worker. If the agent tool calls across that seam, the Modal call and the billing move into a shared module that both workers use.

## 8. Modal spike results (2026-10-16)

All four risks are retired. Test audio: FLEURS Dholuo (`luo_Latn`) test clips, with 10 other Dholuo utterances as ZS examples. Plus one English `say` clip.

| | CTC 1B (L4) | ZS 7B (L40S 48 GB) |
|---|---|---|
| Peak GPU memory | 2.7 GiB | 16.4 GiB with 10 examples (fits; no A100 needed) |
| GPU-seconds, 10.6 s clip | 0.92 | 4.7 |
| GPU-seconds, 20 s clip | — | 6.1 |
| `estGpuSecPerAudioSec` (conservative) | 0.1 | 0.5 |
| Model load, weights cached on the Volume | 23 s | 62 s (~113 s end-to-end cold start) |
| First-ever load (downloads weights) | 165 s | 678 s (29 GB) |

- **Quality (one clip).** Reference: "…malo 20 te mar pi ma pukore oko e-aoche…". CTC heard "maloe mar pima pukore". ZS heard "malo te mar pi mapukore". ZS was closer on every clip we checked.
- **Alignment.** The char vocabulary works. `bos_idx = 0` is the CTC blank, and `pad = 1`, `eos = 2`. Real word timings come back with `timingsApproximate: false` for both models.
- **Pins.** fairseq2n 0.6 pins torch 2.8.0, so torchaudio must also be 2.8.0 (an unpinned install pulls a CUDA 13 build). Use `pyarrow==21.0.0`, because 22+ needs numpy 2. `XDG_CACHE_HOME` must not point at the Volume: the Modal runtime writes there before the Volume mounts.
- **The service file must not be called `omnilingual_asr.py`.** That name shadows the package, so it is `omni_asr.py`.
- **HTTP path checked with `modal serve`:**
  - A bad secret gets 401.
  - A cold ZS container returns `{warming:true}` and spawns a warm-up, and `/status` moves to `ready`.
  - ZS fetches 10 https example URLs and returns a transcript and timings in about 8 s while warm.
- **ZS cold-start copy.** "about 1–3 minutes" holds, at about 2 min.

## 9. Tests (intent)

- `pickAsrModel` routes Cantonese to Qwen, Swahili to Whisper, and a Whisper-unsupported code (Tok Pisin, `tpi`) to Omnilingual. Requests that resolve to Whisper are byte-for-byte unchanged.
- **ZS gate.** An org with `zeroShotEnabled:false` gets 403 even when the client sends `omni-zs`. ZS with no examples gets 400 `zs_no_examples`.
- **Billing.** Settlement uses Modal's `gpuSeconds`, not the audio length: a 10 s clip that uses 40 s of GPU time is billed for 40 s. A settlement is never zero.
- **Example ranking.** A candidate that shares source words outranks a validated but unrelated one. Clips under 2 s or over 30 s are excluded. The read wall is enforced.
- **Warm-up.** `asr_warming` leads to the toast, then `ready`, and the queued cell is transcribed exactly once. Reaching the cap shows the error. Concurrent callers share one warm-up.
- **Client.** The window size is chosen per model. The batch % calculation is tested.
- **Agent tool.** The gate and billing match the in-app path. A write-back attempt produces a changeset, not a commit.

## 10. Out of scope

- On-device Omnilingual (sherpa-onnx CTC 300M for Tauri).
- User-pinned example sets.
- Omnilingual "Unlimited" long-form variants. We chunk the audio, so we don't need them.
- The platform-admin feature-flag system (it lives on the unmerged `feat/dcs-package-flags` branch).

## 11. Ryder-only steps

- Run `modal deploy infra/modal/omni_asr.py` in the genesis-ai-dev workspace, and `modal secret create aquilla-omni-asr OMNI_SHARED_SECRET=…`.
- Run `wrangler secret put OMNI_SHARED_SECRET` and set `OMNI_ASR_MODAL_URL` on the auth-worker environments.
- Give launch timing for the announcement page and the LinkedIn post (drafts are on the aquilla-marketing branch `omnilingual-asr-announce`).

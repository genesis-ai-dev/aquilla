# OmniVoice TTS on Modal + org-attributed usage metering

**Date:** 2026-06-13
**Status:** Approved (design); pending implementation plan
**Author:** Ryder Wishart (with Claude)

## Summary

Host [k2-fsa/OmniVoice](https://github.com/k2-fsa/OmniVoice) — a zero-shot,
600+-language text-to-speech / voice-design model (Apache-2.0, diffusion-LM
architecture, uses Whisper internally for reference ASR) — on Modal, behind an
authenticated worker route. Use it to (1) generate spoken audio for translated
target cells, and (3) produce base TTS that feeds the existing Seed-VC
voice-conversion step. Meter usage by **audio seconds generated**, recorded
**per-user with `org_id` attribution**, and surface the resulting stats on both
the **user Preferences page** and the **org Overview dashboard**. No pricing is
shown.

This builds entirely on existing patterns:
- Modal endpoint mirrors `infra/modal/seed_vc.py`.
- Worker route mirrors `sync-worker/src/voice-convert.ts`.
- Metering mirrors `auth-worker/src/lib/ai-budget.ts`.
- Org rollup mirrors `src/components/org/WorkloadRollup.tsx` (maintainer-gated).

## Context / current state

- **Rate limiting today is per-user + global, NOT per-org.** `ai_usage_daily
  (user_id, date_utc, request_count)` + `recordAndCheckBudget`/`runAiGuard` in
  `auth-worker/src/lib/ai-budget.ts`, enforced on the OpenRouter LLM proxy only.
  Default thresholds are large and `AI_BUDGET_ENFORCE` defaults to **log-only**.
- **Org schema has no plan/tier/quota fields** (`db/postgres/schema.sql`;
  billing fields were stripped in migration 0001). Projects belong to orgs, so
  `org_id` is resolvable from any project.
- **Existing Modal services are not metered at all.** Seed-VC
  (`/api/v1/voice/convert`) and diarization run on Modal via shared-secret
  bindings in `sync-worker`. Both workers (`auth-worker`, `sync-worker`) hold the
  same `HYPERDRIVE`→Neon Postgres binding.
- **No usage endpoint or usage UI exists.** `ai_usage_daily` + `agent_runs` hold
  data but nothing exposes it. `src/pages/Preferences.tsx` is device-local only.

## Decisions (locked during brainstorming)

| Decision | Choice |
| --- | --- |
| Enforcement scope | **Per-user**, with `org_id` attribution recorded for rollup. No org-level quotas yet. |
| Metering unit | **Audio seconds generated.** |
| Enforcement mechanism | **Pre-check + post-record:** if today's recorded user-seconds ≥ limit → 429; else generate, then add actual output seconds. A single request may overshoot slightly; the next is blocked. |
| Enforcement default | **Log-only** (`TTS_BUDGET_ENFORCE` env flag, off by default), mirroring the LLM guard while sizing limits. |
| Usage surfaces | **Both** user Preferences and org Overview dashboard. No pricing. |
| Storage | **Approach A** — new `tts_usage_daily` table; the working `ai_usage_daily` LLM path is untouched. |
| Route home | **sync-worker** (owns R2 cell-audio + sync-token `(projectId, fileId)` auth; output feeds Seed-VC). |
| Use cases | (1) TTS of translated cells; (3) TTS output feeds Seed-VC re-voice. The returned `audioId` is a valid `sourceAudioId` for `/api/v1/voice/convert` — no special chaining code. |

## Components

### 1. Modal endpoint — `infra/modal/omnivoice.py`

Sibling of `seed_vc.py`. Image clones the OmniVoice repo and installs deps;
`OmniVoice.from_pretrained()` loads **once** in `@modal.enter()` with weights on
a persistent `modal.Volume` (HF cache dirs pointed at the Volume, committed after
first download). `HF_TOKEN` comes from a Modal secret.

`@modal.asgi_app()` FastAPI with:
- `GET /health` → `{ ok: true }`.
- `POST /synthesize` — multipart/JSON: `text` (required), optional `voice_ref`
  (reference wav bytes for voice cloning), `language`, and diffusion params
  (sane defaults). Auth: `X-Auth-Token` must equal `OMNIVOICE_TOKEN` (Modal
  secret) → 401 otherwise. Returns `audio/wav` **plus an
  `X-Audio-Duration-Seconds` response header** (the metering unit, computed from
  the generated waveform: `num_samples / sample_rate`).

GPU `L40S`, `scaledown_window` ~300s. Deploy:
`modal secret create omnivoice-auth OMNIVOICE_TOKEN=<random>` then
`modal deploy infra/modal/omnivoice_app.py` (file is `omnivoice_app.py`, NOT
`omnivoice.py` — that name would shadow the installed `omnivoice` package; using existing `MODAL_TOKEN_ID/SECRET`
+ `HF_TOKEN` from gitignored `.env`).

### 2. Worker route — `sync-worker/src/tts.ts` → `POST /api/v1/voice/tts`

Mirrors `voice-convert.ts`. New env bindings on `VoiceConvertEnv`-style interface
(or a dedicated `TtsEnv`): `OMNIVOICE_URL`, `OMNIVOICE_TOKEN`, plus the existing
`SNAPSHOTS` (R2), `SYNC_SECRET_KEY`, `R2_KEY_PREFIX`, and `HYPERDRIVE`.

Request body: `{ projectId, fileId, cellId?, text, voiceRef? | referenceAudioId?,
language? }`. Auth: sync-token scoped to `(projectId, fileId)` via
`verifyTokenForFile` (identical to `/audio` and `/voice/convert`).

Flow:
1. Verify token; resolve `userId` (from token claim) and `orgId` (project→org
   lookup via Postgres).
2. **Pre-check** budget (`tts-budget.ts`): read today's user-seconds; if
   enforcing and ≥ limit → 429 `{ error: "tts_daily_limit_exceeded" }`.
3. `POST` to `OMNIVOICE_URL/synthesize` with `X-Auth-Token: OMNIVOICE_TOKEN`,
   sending `text` (+ optional reference clip resolved from R2 if
   `referenceAudioId` given).
4. Read returned WAV + `X-Audio-Duration-Seconds`.
5. Write WAV to R2 as a cell-audio object (`audioObjectKey` / `frontier-audio://`
   scheme, same layout as `voice-convert`); return `{ audioId, durationSeconds }`.
6. **Post-record** the actual seconds (`tts-budget.ts`) to the user, org, and
   global rows.

Failure handling: Modal/R2 errors return a structured error and **do not**
record seconds. Counter-write failures are logged but never block a successful
synthesis (degrade gracefully, mirroring `ai-budget.ts`).

Use case 3: the returned `audioId` is passed by the client as `sourceAudioId` to
the existing `/api/v1/voice/convert` for re-voicing — two single-purpose calls,
no new chaining code.

### 3. Metering — `sync-worker/src/tts-budget.ts` + migration

New migration `db/postgres/migrations/00NN_tts_usage_daily.sql`:

```sql
CREATE TABLE tts_usage_daily (
  user_id       INTEGER          NOT NULL,
  org_id        INTEGER          NOT NULL,  -- 0 = global sentinel
  date_utc      DATE             NOT NULL,
  request_count INTEGER          NOT NULL DEFAULT 0,
  audio_seconds DOUBLE PRECISION NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, org_id, date_utc)
);
CREATE INDEX idx_tts_usage_org_date ON tts_usage_daily (org_id, date_utc);
```
Apply to live Neon as well as `schema.sql` (guard against D1→Neon drift).

`tts-budget.ts` mirrors `ai-budget.ts`:
- `checkTtsBudget(db, userId, env)` — **pre-check**: read today's user-seconds;
  return `{ over, seconds, limit }`. `TTS_USER_DAILY_SECONDS_LIMIT` (default
  large while sizing).
- `recordTtsUsage(db, userId, orgId, seconds, env)` — two upserts (each +1
  request, +seconds): the **per-user row** `(userId, orgId, today)` and the
  **global sentinel row** `(0, 0, today)`. Org totals are NOT a separate stored
  row — they are derived at read time as `SUM(...) WHERE org_id = ?` over the
  per-user rows. The global sentinel gives an O(1) platform total without a scan.
- `runTtsGuard(...)` — pre-check + enforce flag (`TTS_BUDGET_ENFORCE === "true"`,
  default log-only). Over-budget in log-only logs a warning and passes.

The working `ai_usage_daily` LLM enforcement path is **not modified**.

### 4. Read endpoints — `auth-worker`

- `GET /api/v1/usage/me` — caller's own rollup: today's TTS seconds + request
  count (from `tts_usage_daily` where `user_id = caller`), today's LLM requests
  (from `ai_usage_daily`), and a small N-day (e.g. 7) history. JWT-authed.
- `GET /api/v1/usage/org/:orgId` — per-member rollup for the org:
  `SUM(audio_seconds)`, `SUM(request_count)` grouped by `user_id` where
  `org_id = :orgId` (+ joined usernames), plus LLM request counts. **Maintainer-
  gated** (verify caller is a manager of the org → 403 otherwise), matching the
  workload endpoint's gate. The UI swallows 403 so the section hides for
  non-managers.

### 5. Frontend

- **Client libs** in `src/lib/sync/`: `synthesizeCellTts(...)` (calls
  `/api/v1/voice/tts`), `getMyUsage(jwt)`, `getOrgUsage(jwt, orgId)`.
- **Preferences** (`src/pages/Preferences.tsx`): new `<UsageSection />` inserted
  after the Privacy section, before `<PersonalProviderSection />`. Shows "today:
  N min audio generated, M AI requests" + a small 7-day history. Uses the
  `rounded-lg border bg-card p-4` section convention and a `useUserUsage()` hook.
  No pricing.
- **Org Overview** (`src/components/org/OrgHome.tsx`): new `<UsageRollup />`
  rendered beside `<WorkloadRollup />`. Per-member audio-minutes + request
  counts. Renders nothing for non-managers (403) or when usage is zero —
  identical self-hiding pattern to `WorkloadRollup`.
- **Trigger (use case 1):** a "Generate audio" affordance on a translated cell
  that calls `synthesizeCellTts` and attaches the returned `audioId` via the
  existing cell-audio attach flow. Kept minimal; reuses existing audio plumbing.

## Data flow

```
Editor "Generate audio" (cell text)
  → POST /api/v1/voice/tts  [sync-worker]
      → pre-check tts_usage_daily (per-user)         [Postgres]
      → POST OMNIVOICE_URL/synthesize (X-Auth-Token) [Modal GPU]
          ← audio/wav + X-Audio-Duration-Seconds
      → write WAV to R2 (cell-audio object)          [R2]
      → record seconds (user + org-attr + global)    [Postgres]
  ← { audioId, durationSeconds }
  → (optional, use case 3) POST /api/v1/voice/convert with sourceAudioId

Preferences  → GET /api/v1/usage/me        [auth-worker → Postgres]
Org Overview → GET /api/v1/usage/org/:orgId [auth-worker → Postgres, maintainer-gated]
```

## Testing (intent-encoding, Rule 9)

- `tts-budget.test.ts`: pre-check blocks when over **only when enforcing**;
  log-only passes through; `recordTtsUsage` writes correct seconds to the user
  row and the global sentinel; org rollup SUM attributes to the right `org_id`.
- `tts.test.ts`: route rejects bad/absent sync-token; Modal call mocked; parses
  `X-Audio-Duration-Seconds`; writes R2; returns `audioId`; a Modal failure
  records **no** seconds.
- Read-endpoint tests: `/usage/me` shape; `/usage/org/:orgId` returns 403 for a
  non-manager and aggregates correctly for a manager.
- UI: `UsageSection` renders user totals; `UsageRollup` hides on 403 and on zero
  usage.

## Out of scope (YAGNI)

- Org-level **enforcement** / plans / tiers (schema is org-ready via `org_id`,
  but no plan/tier fields are added).
- Pricing or cost display.
- Single-call TTS+re-voice chaining (two calls instead).
- Streaming audio.
- Backfilling historical usage.

## Risks / notes

- **D1→Neon drift:** the new migration must be applied to live Neon, not just
  `schema.sql`, or `/usage/*` and the TTS route 500 with column-not-found.
- **Modal cold start:** first synthesis after scale-to-zero downloads weights
  once (Volume-cached thereafter) — UI should tolerate a slow first call.
- **Overshoot:** pre-check+post-record allows one over-limit request; acceptable
  per decision, and moot while default is log-only.
- **Reference-clip reuse:** voice cloning can reuse the project-scoped reference
  clips already stored for Seed-VC (`/api/v1/voice/reference/...`).

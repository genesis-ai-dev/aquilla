# Operational Security Review — 2026-09-03

_Tenth pass in the standing series. Follows `docs/OPSEC-REVIEW-2026-08-31.md`
(OPS-25…OPS-26), `docs/OPSEC-REVIEW-2026-08-27.md` (OPS-22…OPS-24),
`docs/OPSEC-REVIEW-2026-08-24.md` (OPS-18…OPS-21),
`docs/OPSEC-REVIEW-2026-08-20.md` (OPS-15…OPS-17),
`docs/OPSEC-REVIEW-2026-08-17.md` (OPS-11…OPS-13),
`docs/OPSEC-REVIEW-2026-08-13.md` (OPS-8…OPS-10),
`docs/OPSEC-REVIEW-2026-08-11.md`, `docs/OPSEC-REVIEW-2026-08-10.md`
(OPS-1…OPS-7) and `docs/OPSEC.md` (V1…V9). New findings continue the **OPS-n**
series at OPS-27._

_Numbering note: this pass ran on 2026-09-03 against a tree that did not yet
contain `docs/OPSEC-REVIEW-2026-08-31.md`, and originally took OPS-25/OPS-26
for its two findings — the same numbers the 08-31 pass had already assigned
to the invite-preview session check and invite-token storage. Reconciled on
2026-09-11 when the branch was brought up to `dev`, in the 08-31 pass's favour
(it landed first, per the 08-12 precedent): this pass's findings are
**OPS-27 and OPS-28** everywhere below. The findings themselves are unrelated
to 08-31's; only the numbers moved._

**Scope for this pass: API security & data exposure**, the fourth pass on
this theme (`docs/OPSEC-REVIEW-2026-08-13.md`, `-08-20.md`, `-08-27.md` were
the first three), in the rotating weekly cycle (auth/session Mon, authz/access
Tue, injection Wed, **API/data exposure Thu**, infra/deployment Fri). Prior
passes on this theme have already closed rate limiting on the external Agent
API, PAT scoping, IDOR on artifact/changeset routes, mass-assignment/
`SELECT *` exposure, SSRF on the aquifer/chat/diarization/voice-convert
proxies, and audio-id path safety — see those files for what's already fixed.
This pass covers new ground: the first-party OpenRouter/TTS proxies
(`/api/v1/chat/completions`, `/api/v1/ai/agent/run`, `/api/v1/voice/tts`) and
a sweep for raw-error-text leakage across authenticated write routes.

Every finding is labelled **FACT** (verified against a file:line or a test
run at this commit) or **JUDGMENT** (reasoned inference).

**What this pass turned up.** The two prior open items on this theme —
OPS-24 (credit-cap check-then-act race) and V7/SEC-1 (prod/dev shared signing
keys) — are unchanged and out of scope for the reasons already recorded in
`docs/OPSEC-REVIEW-2026-08-27.md`; re-flagged below per standing practice.
This pass's own finding is adjacent to, but distinct from, OPS-24: it's not
about a race in the enforcement path, it's that **enforcement itself is off
in every deployed environment**, and — unlike the external Agent API's
routes, all rate-limited since OPS-15/OPS-22 — the two OpenRouter proxies and
the TTS synthesis route had no volumetric control at all, of any kind. A
second, smaller finding closes two raw-database-error responses the same
sweep turned up.

---

## Findings

### OPS-27 — The AI chat, agent-run, and TTS proxies had no rate limiting, and every spend guard on them defaults to off in production — **FIXED (rate limiting); enforcement flags flagged for product decision** [FACT]

**Files:**
- `auth-worker/src/lib/ai-budget.ts:191`, `auth-worker/src/lib/credits.ts:42,64`,
  `sync-worker/src/tts-budget.ts:9,101-124` — all three spend guards
  (`runAiGuard`'s daily request budget, `creditGuard`'s org credit cap,
  `runTtsGuard`'s daily seconds budget) default to **log-only**: an over-cap
  request is `console.warn`'d and let through.
- `auth-worker/wrangler.toml`, `sync-worker/wrangler.toml` — confirmed by
  reading every environment block: `AI_BUDGET_ENFORCE`, `CREDIT_ENFORCE`, and
  `TTS_BUDGET_ENFORCE` are never set to `"true"` anywhere, including
  `[env.production.vars]`. Production runs with every one of these guards in
  log-only mode.
- `auth-worker/src/routes/chat.ts`, `auth-worker/src/routes/agent.ts`,
  `sync-worker/src/tts.ts` — before this fix, none of the three routes had
  any rate limit of their own; the only counters touching them were the
  above daily budgets, which (per the above) never actually block.
- `auth-worker/src/utils/rate-limit.ts:49` — self-registration is throttled
  only 15 accounts per IP per 15 minutes; trivially spread across IPs.

**Attack scenario:** an attacker self-registers (open, lightly throttled)
and fires a sustained burst at `POST /api/v1/chat/completions`,
`POST /api/v1/ai/agent/run`, or `POST /api/v1/voice/tts`. Every spend guard
logs a warning and returns `{ok: true}` — nothing 429s. This runs unbounded
cost against the platform's shared `OPENROUTER_API_KEY` (chat/agent, with
`ai/agent/run` additionally driving up to 8 tool iterations and a 60k-token
ceiling per call) or the shared Modal GPU endpoint (TTS) — a straightforward
billing/compute-exhaustion DoS with no volumetric control at the app layer.

**Fixed:** a per-user sliding-window throttle on each route, using the same
primitive (`db/shared/rate-limit.ts`, `auth_rate_limit_events`, 15-minute
window) the external Agent API's per-credential throttles already use (OPS-15/
OPS-22). This is deliberately orthogonal to the enforce/budget flags above —
those are a per-org product decision (an admin opts a specific org into a hard
daily cap) and this pass doesn't change that semantics or flip any default;
it adds the floor that was missing regardless of whether budget enforcement is
ever turned on: a real bound on burst request volume.

| Route | Cap / 15 min | Why this number |
|---|---|---|
| `POST /api/v1/chat/completions` | 300 per user (`CHAT_MAX_PER_USER_PER_WINDOW`, `chat.ts`) | Matches the external API's established "cheap read" tier (`READ_MAX_PER_CREDENTIAL`/`SEARCH_MAX_PER_CREDENTIAL` = 300) — wide enough that no real per-cell-suggestion session gets close. |
| `POST /api/v1/ai/agent/run` | 60 per user (`AGENT_RUN_MAX_PER_USER_PER_WINDOW`, `agent.ts`) | Lower than chat's: each call is a multi-turn tool loop (up to 8 iterations, 60k tokens), not a single completion. A real interactive session runs a handful of agent turns, never dozens per minute. |
| `POST /api/v1/voice/tts` | 200 per user (`TTS_MAX_PER_USER_PER_WINDOW`, `tts.ts`) | GPU-backed synthesis against a single shared Modal endpoint; wide enough for a real batch-narration session (many short clips in one sitting). |

**Not fixed here — flagged for product/ops decision, not auto-changed:**
flipping `AI_BUDGET_ENFORCE` / `CREDIT_ENFORCE` / `TTS_BUDGET_ENFORCE` to
`true` globally is a business decision (it starts actually rejecting
over-cap orgs/users, not just logging them) with real UX consequences for
legitimate heavy users, and interacts with OPS-24's still-open race in the
credit-cap path — not something to flip as a side effect of an API-security
pass. Recorded here so it isn't silently lost: whoever owns billing/product
for this should decide per-environment defaults deliberately, informed by
the log-only warnings these guards have been emitting.

### OPS-28 — Two authenticated write routes echoed raw database error text — **FIXED** [FACT]

**Files:** `auth-worker/src/routes/knowledge.ts:202`,
`auth-worker/src/routes/agent-artifacts.ts:149`.

Both routes' `catch` block on an R2-then-Postgres-insert sequence built the
500 response body from `` `... insert failed: ${String(err)}` ``, echoing the
raw driver exception (e.g. a Postgres constraint-violation message, which can
name tables/columns/constraints) straight back to the caller. Inconsistent
with the deliberate sanitization already established elsewhere — e.g.
`sync-worker/src/external/errors.ts`'s `toErrorResponse`, whose own comment
states raw exception text "can leak schema/query internals" and is therefore
never echoed on the external Agent API surface.

**Exploitability:** low severity — both routes require an authenticated
session and at minimum project-CONTRIBUTOR-level access to reach the insert
in the first place, and the leak is schema-fingerprinting detail, not data.
Fixed anyway since it's a one-line, zero-risk consistency fix once found, and
"low severity" is exactly the class of gap that compounds if left for a
determined attacker chaining several small leaks.

**Fixed:** both now log the error server-side (`console.error`) and return a
generic message, mirroring `toErrorResponse`'s pattern.

---

## Risk assessment

| ID | Finding | Likelihood | Impact | Risk | State |
|---|---|---|---|---|---|
| OPS-27 | No rate limit on chat/agent-run/TTS proxies; spend guards log-only in prod | Medium — any self-registered account, no special access needed | High — unbounded spend against the shared OpenRouter key / Modal GPU endpoint | **High** | Rate limiting fixed; enforce-flag decision flagged for product/ops |
| OPS-28 | Raw DB error text returned on two insert-failure paths | Low — requires an authenticated session and a triggerable constraint failure | Low — schema-fingerprinting only, no data disclosure | **Low** | Fixed |

---

## Countermeasures applied in this change

| Control | Where |
|---|---|
| Per-user rate limit, 300/15min, on `POST /api/v1/chat/completions` | `auth-worker/src/routes/chat.ts` |
| Per-user rate limit, 60/15min, on `POST /api/v1/ai/agent/run` | `auth-worker/src/routes/agent.ts` |
| Per-user rate limit, 200/15min, on `POST /api/v1/voice/tts` | `sync-worker/src/tts.ts` |
| Raw DB error text no longer returned to the client on insert failure | `auth-worker/src/routes/knowledge.ts`, `auth-worker/src/routes/agent-artifacts.ts` |

Every rate limit has a regression test: `chat-guard.test.ts` and
`agent-route.test.ts` (auth-worker) and `tts.test.ts` (sync-worker) each
assert a 429 (and that the upstream/Modal call never happens) once the
per-user window is pre-seeded over the cap, and 200 for a fresh user even
when another user has flooded the same window.

## Reviewed and confirmed safe — no change needed

- **CORS (`Access-Control-Allow-Origin: *`)** on both workers — re-verified no
  cookie-based auth exists anywhere in either worker (grep for
  `cookie`/`Set-Cookie`/`credentials: 'include'` found nothing beyond the
  comment in `sync-worker/src/cors.ts` itself); auth travels exclusively as
  `Authorization: Bearer <jwt>`. Wildcard origin + bearer-only auth (no
  ambient credentials) is not exploitable the way wildcard + cookies would
  be — matches the standing assessment in `docs/OPSEC-REVIEW-2026-08-06.md`
  §OPS-7/`OPSEC.md`.
- **Agent API PAT scoping, IDOR on artifact/changeset routes, mass
  assignment, SSRF on the four outbound proxies** — unchanged from
  `docs/OPSEC-REVIEW-2026-08-27.md`; re-checked, no new gap found.
- **PAT (credential) handling, `AGENT_SANDBOX_KEY` comparison, platform-admin
  step-up, org-settings secret redaction, `/users/lookup` PII scope, SQL
  injection, artifact `Content-Type` handling, auth/session middleware** —
  all re-swept this pass against the newer surface (chat/agent/TTS routes
  specifically); no gap found beyond OPS-27/OPS-28 above.

## Not fixed here — needs follow-up

- **OPS-24** — the credit-guard check-then-act race, unchanged; still needs a
  billing-scoped pass rather than a side effect of this one.
- **OPS-27's enforce-flag question** — whether/when to flip
  `AI_BUDGET_ENFORCE`/`CREDIT_ENFORCE`/`TTS_BUDGET_ENFORCE` to `true` in any
  environment is a product/billing decision, not a mechanical security patch;
  flagged for whoever owns that call.
- **V7/SEC-1 (prod/dev share `SECRET_KEY`/`SYNC_SECRET_KEY`)** — unchanged,
  still the highest-leverage open item across the whole series; out of scope
  for this pass's theme but re-flagged per standing practice.

---

_Re-run the mechanical parts of this review with: `cd auth-worker && npx tsc
--noEmit && npx vitest run` and `cd sync-worker && npx tsc --noEmit && npx
vitest run`._

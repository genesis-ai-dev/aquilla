# Org credits & unified compute-cost model

**Date:** 2026-06-13 · **Status:** Approved (user-directed defaults; tune via config)
**Builds on:** `2026-06-13-omnivoice-tts-design.md` (TTS metering already on main).

## Goal

A single dollar-denominated accounting layer across all three compute rails
(LLM chat, AI agent, TTS GPU), expressed to org admins as **credits** (cost ×
SaaS markup), with **daily + weekly caps** (both enforced) plus a stricter
**agent sub-cap**. Visible to **platform admins** now; revealed to an org's
admins behind a per-org **flag**. **Never shown to end-user translators.**
Enforcement **off by default** (record + display only) — commercial functionality
is not yet exposed to users.

## Key decisions (all config — retunable without code changes)

- **Store raw cost, derive credits on read.** Each rail records its *actual*
  infra/provider cost (`raw_cost_cents`); credits, markup and caps are applied at
  read/cap time. So markup/caps can change retroactively. (Matches the
  derive-on-read preference.)
- **Credit = 1¢ of customer-facing price.** `credits = ceil(raw_cost_cents ×
  markup(rail))`.
- **Markup defaults:** `markup = 4.0` (covers invisible/team costs — cost-plus
  SaaS norm 3–5×); **`agentMarkup = 5.0`** (agent blows up fastest).
- **Caps (credits), platform defaults, per-org overridable:**
  `dailyCap = 1000` ($10/day), `weeklyCap = 5000` ($50/wk),
  **agent sub-cap** `agentDailyCap = 600`, `agentWeeklyCap = 3000`.
  *(Placeholders — user will tune. Conservative + enforcement off, so safe.)*
- **Both caps enforced + agent sub-cap:** a call is allowed iff
  `daySpend < dailyCap` AND `weekSpend < weeklyCap` AND (rail≠agent OR
  (`agentDaySpend < agentDailyCap` AND `agentWeekSpend < agentWeeklyCap`)).
  This gives the requested shape: burn a week's budget in a few heavy days (week
  cap stops you), or cap out one day yet keep using the rest of the week.
- **Enforcement off by default** (`creditEnforce = false`): record + surface in
  admin only; flip per-org/global later. Mirrors the existing AI budget log-only
  default.
- **Week window:** rolling 7 days (today − 6 … today, UTC). Simpler + fairer than
  ISO-week resets while sizing.

## Data model

Migration `0042_org_credit_usage_daily.sql` (+ `db/postgres/schema.sql`):
```sql
CREATE TABLE org_credit_usage_daily (
  org_id         INTEGER          NOT NULL,   -- 0 = no-org fallback
  user_id        INTEGER          NOT NULL,
  date_utc       DATE             NOT NULL,
  rail           TEXT             NOT NULL,    -- 'llm' | 'agent' | 'tts'
  raw_cost_cents DOUBLE PRECISION NOT NULL DEFAULT 0,  -- ACTUAL infra cost
  units          INTEGER          NOT NULL DEFAULT 0,  -- requests (llm/agent) | whole audio-seconds (tts)
  PRIMARY KEY (org_id, user_id, date_utc, rail)
);
CREATE INDEX idx_org_credit_org_date ON org_credit_usage_daily (org_id, date_utc);
```
This is the **$-truth**. Existing `ai_usage_daily` (request counts), `agent_runs`
(per-run detail), `tts_usage_daily` (audio-seconds) stay as-is for their own
units; the new table is the cross-rail cost rollup.

Per-org config lives in `org_settings` JSON under key `credits`:
`{ markup?, agentMarkup?, dailyCap?, weeklyCap?, agentDailyCap?, agentWeeklyCap?,
enforce?, showToOrg? }` — any missing field falls back to the platform env default.

## Shared formula (spec is the single source of truth; implemented identically in
auth-worker `credits.ts`, sync-worker `credits.ts`, frontend `src/lib/credits.ts`
— small pure functions, no cross-package import):

```ts
creditsFor(rawCents, rail, cfg) = Math.ceil(rawCents * (rail === 'agent' ? cfg.agentMarkup : cfg.markup))

// spend = sums of creditsFor(...) for the org over the window, total + agent-only
checkCredits(spend, rail, cfg): { ok: boolean, reason?: 'daily'|'weekly'|'agent_daily'|'agent_weekly' }
  if spend.dayCredits      >= cfg.dailyCap       -> { ok:false, reason:'daily' }
  if spend.weekCredits     >= cfg.weeklyCap      -> { ok:false, reason:'weekly' }
  if rail==='agent' && spend.agentDayCredits  >= cfg.agentDailyCap  -> { ok:false, reason:'agent_daily' }
  if rail==='agent' && spend.agentWeekCredits >= cfg.agentWeeklyCap -> { ok:false, reason:'agent_weekly' }
  else { ok:true }
```

## Components

### WS-SCHEMA — `db/postgres/migrations/0042_org_credit_usage_daily.sql` + schema.sql

### WS-AUTH-CREDITS — auth-worker (the priority rail: agent + chat)
- `auth-worker/src/lib/credits.ts`: the formula above; `resolveCreditConfig(env, orgId, db)` (env defaults ⊕ org_settings.credits); `recordCredit(db, orgId, userId, rail, rawCostCents, units)` (upsert into org_credit_usage_daily); `readSpend(db, orgId, day|week)`; `creditGuard(...)` (pre-check; enforce only when cfg.enforce).
- Wire into `agent.ts`: resolve org from project, on each run **record agent raw cost** (the run's `cost_cents`) → org_credit_usage_daily(rail='agent'); **pre-check `creditGuard` with agent sub-cap** before starting a run (block with 429 when enforcing — agent is the dangerous rail). Keep the existing token ceiling.
- Wire into `chat.ts`: record LLM raw cost (OpenRouter `usage.cost`, or fallback ~1¢/req) → rail='llm'; pre-check.
- Endpoint `GET /api/v1/usage/org/:orgId/credits`: returns `{ config (caps+markup, redacted of nothing sensitive), day:{totalCredits, byRail, agentCredits}, week:{…}, remaining:{daily,weekly,agentDaily,agentWeekly}, enforce }`. **Auth: platform-admin OR (org-maintainer AND cfg.showToOrg).**
- Platform-admin config endpoints (under existing admin routes): `GET /api/v1/admin/credits/orgs` (all orgs' spend+caps), `PATCH /api/v1/admin/credits/org/:orgId` (set markup/caps/enforce/showToOrg → org_settings.credits). Gated by `platform-admin.ts` middleware.

### WS-SYNC-CREDITS — sync-worker (TTS rail)
- `sync-worker/src/credits.ts`: same formula (record + optional pre-check).
- In `tts.ts`: estimate TTS raw cost (`TTS_COST_CENTS_PER_CALL` default 2¢, rough cold-start-amortized estimate, configurable; optionally + `durationSeconds × TTS_COST_PER_AUDIO_SEC_CENTS`) and `recordCredit(rail='tts')`. Optional pre-check (low priority — TTS is the cheap rail). Keep existing audio-seconds metering.

### WS-FRONTEND-ADMIN — frontend (admin-only; org behind flag; NEVER end users)
- `src/lib/credits.ts`: display helpers (creditsFor, format credits, cap-usage %).
- `src/lib/sync/credits.ts`: `getOrgCredits(jwt, orgId)`, admin `listOrgCredits(jwt)`, `setOrgCreditConfig(jwt, orgId, patch)`.
- **AdminConsole**: new "Compute / Credits" section — per-org table: day & week credit spend, **agent spend highlighted**, caps, % used, editable caps/markup, `enforce` toggle, `showToOrg` toggle. (Find AdminConsole via `platform-admin` usages.)
- **Org overview**: a credits/cap panel rendered ONLY when `cfg.showToOrg` is on AND the viewer is an org admin/maintainer (role ≥ maintainer). Shows credit cap usage (daily/weekly bars, agent sub-cap), in credits (no raw provider $ necessarily). Self-hides otherwise. **Must not render for end-user translators.**

## Config (platform env defaults, all optional)
`CREDIT_MARKUP=4`, `CREDIT_AGENT_MARKUP=5`, `CREDIT_DAILY_CAP=1000`,
`CREDIT_WEEKLY_CAP=5000`, `CREDIT_AGENT_DAILY_CAP=600`,
`CREDIT_AGENT_WEEKLY_CAP=3000`, `CREDIT_ENFORCE=false`,
`TTS_COST_CENTS_PER_CALL=2`.

## Testing (intent)
- credits.ts unit tests (each worker + frontend): `creditsFor` markup incl. agent
  5×; `checkCredits` blocks on daily/weekly/agent-daily/agent-weekly with correct
  reason; enforce-off never blocks; rolling-7-day window.
- auth: agent run records agent cost + pre-check blocks when agent sub-cap hit
  (enforce on); chat records llm cost; `/credits` endpoint admin vs org-flag vs
  403 for plain member; admin PATCH writes org_settings.credits.
- sync: tts records tts cost into org_credit_usage_daily.
- frontend: admin table renders + agent highlight; org panel hides when
  showToOrg off / viewer is a non-admin; never renders for translator role.

## Out of scope (v1)
- Real-money billing / payment. Stripe. Invoices.
- Exposing any of this to end-user translators.
- GPU-size optimization (deferred per user).
- Exact Modal GPU-second cost ingestion (use the configurable per-call estimate).
- Materialized credit balances (derive-on-read).

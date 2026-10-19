# Unified billing — one meter, one entitlement check, three plans

**Status:** Proposal · 2026-10-19 · Ryder (drafted with Claude). Ryder answered all twelve
questions on 2026-10-19; they are recorded inline as **✅ Decided**. Tickets not yet filed.
**Inputs:** billing audit 2026-10-16; code audit of `origin/dev` at `1fefb63e3` (this doc cites
it throughout); `docs/pricing/pricing-model.md`; the superseded Field Plan spec
`2026-08-13-stripe-field-plan-billing.md`; `docs/runbooks/billing-spec-proposed.md` (superseded).
**Linear:** none filed yet — the ticket split in §9 waits for approval. Related and already open:
AQU-2014 (Team onboarding), AQU-2015 (BYOK for server features).

Questions are numbered Q1…Q12 inline and collected in §8. All are resolved.

---

## 0. The problem in one paragraph

Aquilla has **three usage ledgers in three units**, and none of them enforces in production.
`org_credit_usage_daily` stores raw provider cents (credits = raw × 4, agent × 5) behind a
log-only `creditGuard`. `org_word_usage_daily` counts whitespace words of the *input* prompt and
`wordGuard` returns `{ok:true}` unconditionally (`auth-worker/src/lib/billing/words.ts:459-473`),
so every `return 429` after it is dead code. `workspace_usage_requests` reserves and settles
micro-units at 4× raw cost — the only correct design — but runs only when
`BILLING_WEEKLY_USAGE_ENFORCE=true`, which no environment sets. On top of that there are two
plan models (Field/Explore/Enterprise in `org_billing.plan`, and Free/Pro/Max 5×/Max 20×/Team/
Team 20× in `workspace_plan_entitlements`), a 10-price Stripe catalog, and **13+ paid AI paths
that are metered by nothing**. The only limits that actually bite are per-user rate limits and
a $500/day platform spend ceiling — and that ceiling cannot see metered spend (§5.2). Turning
enforcement on today would refuse AI to every org without a `billing_scope` and to every legacy
Field/Enterprise org (§5.1).

## 1. What we want (requirements)

| # | Requirement | Source |
|---|---|---|
| R1 | **One meter**, in one unit, fed by actual raw provider cost. | Ryder |
| R2 | **One entitlement check** that every billable AI action passes before it spends. | Ryder |
| R3 | **Free for every org by default**: the whole app plus a capped weekly AI allowance; the cap is editable in the admin portal. | Ryder |
| R4 | **Team ≈ $500/mo** via Stripe: managed multimodal AI, basic support. | Ryder |
| R5 | **Enterprise** is an admin flag: unmetered, invoiced outside Stripe, still recorded for cost, optional contract end date. | Ryder |
| R6 | **BYOK for everything**: an org with its own key spends nothing on our meter. | Ryder, AQU-2015 |
| R7 | **Users only ever see a % meter**, never credits, words, or dollars. | Ryder, `pricing-model.md:13` |
| R8 | Rollout cannot strand a single org: shadow first, enforce second. | audit |
| R9 | Remove the dead billing code once the unified path is live. | Ryder |

## 2. ONE meter

### 2.1 Decision: keep `workspace_usage_requests`, retire the other two

| Ledger | Unit | Cost source | Verdict |
|---|---|---|---|
| `org_credit_usage_daily` (`auth-worker/src/lib/credits.ts`) | raw cents/day/rail | OpenRouter `usage.cost`; falls back to **1¢ flat** (non-stream chat, `chat.ts:499-504`) or **0¢** (stream, `chat.ts:468-478`); TTS is a **2¢/call estimate** (`sync-worker/src/tts.ts:120-125`) | Retire. Daily buckets cannot reserve, so a long agent run is only counted after it has spent. |
| `org_word_usage_daily` (`words.ts`) | input words | `countWords(prompt)` — unrelated to cost | Retire. Words do not track cost (audio, agent tool loops, long context all break it). |
| **`workspace_usage_requests`** (`workspace-usage.ts`) | micro-units, per request | reserve from a rate-card estimate (`rate-card.ts:55-61`), settle from `usage.cost` or `/generation` (`billing-cost.ts:31-38`, `usage-reconcile.ts:35-52`) | **Keep.** Per-request rows, reserve→settle, idempotent `request_id`, `rate_version` snapshot, `raw_micro_cents` already stored. |

Why this one: it is the only ledger that (a) blocks *before* spend, (b) records the true raw
cost per request, and (c) already has the 100%-admit / 105%-finish rule Ryder approved on
2026-09-16 (`workspace-usage.ts:108`).

### 2.2 Changes to the kept ledger

1. **The meter runs on raw cost.** `raw_micro_cents` is the fact, and allowances are stated
   in raw dollars (§2.3). Credits are only a derived display unit for operators, so changing
   them never rewrites history or moves a cap.
2. **Widen `rail`** from `llm|agent|tts` to `llm | agent | jev | tts | audio | gpu | sandbox`
   (CHECK constraint + `CostRail`). Every path in §3 maps to one rail.
3. **Add `mode`** (`metered | unmetered | byok`) and **`decision`** (`allow | would_block |
   block`) columns, so Enterprise and BYOK calls are still recorded for cost tracking (R5) and
   shadow mode is a query (§5.4). BYOK rows store provider and tokens; `raw_micro_cents` is our
   estimate of what it *would* have cost, never charged.
4. **Allow `user_id` 0 / system** and a nullable `project_id`, for background work (autopilot
   ticks, cron react sweep, brief summary at project setup) that has no live user.
5. **Non-token rails reserve against a price card** (TTS characters, audio seconds, GPU
   seconds, container seconds) and settle against provider-reported or measured usage, the same
   pattern `transcribe-core.ts:173-273` already uses.
6. **The spend ceiling reads this ledger** (§5.2).

### 2.3 Raw cost is the meter (✅ Q1)

The meter compares **raw provider cost** with a **raw-dollar weekly allowance**. There is no
calibration step and no "credit = N words" definition.

- **Free = $1/week of raw provider cost**, editable in the admin portal (R3).
- **Team = 24 × Free** = $24/week raw (§4.3).
- **Enterprise** = unmetered, still recorded.

Users see only a % meter (R7). If operators need a quotable number, the **credit is a derived
display unit**: 1 credit = one marked-up cent = 0.25¢ of raw cost (today's convention,
`pricing-model.md:45`). Under it Free is 400 credits a week and Team 9,600. That number is
calculated from raw cost for admin screens only; the meter never reads it.

**What $1/week buys.** No "smart vs fast" benchmark note exists in this repo. The measured data
is in `genesis-ai-dev/ebible-benchmark-factory`,
`benchmark_results/low-resource-panel-luna/20260721T030758Z-d4408a86/seven-model-report.md:9-15`:
24 verses, one call each with 10 examples. At about 25 words a verse (≈600 words):

| Model (role) | Raw cost, 24 verses | ≈ raw cost / 100 words | Free's $1/week buys |
|---|---|---|---|
| GPT-5.6 Luna (fast) | $0.0519 | $0.009 | ≈ 11,000 words |
| Claude Sonnet 4.6 (mid) | $0.2146 | $0.036 | ≈ 2,800 words |
| Claude Fable 5 (smart) | $0.7426 | $0.12 | ≈ 800 words |

These are one-shot prompted calls. Agent runs use **46–100× more input tokens** per translation
(same repo, `README.md:690`), so agent mode drains the allowance far faster (§6).

**✅ Q2 — markup (decided).** **One 4× markup for every rail.** The agent's 5× markup
(`credits.ts:35-44`) is dropped. Because the meter runs on raw cost, the markup appears only in
the derived display unit and in margin sizing (§4.3), never in the meter.

## 3. ONE entitlement check

### 3.1 Shape

One module in `db/shared/` (both workers import it, like `ai-spend-ceiling.ts` today):

```ts
// db/shared/ai-entitlement.ts
type AiMode = 'metered' | 'unmetered' | 'byok'
checkAiEntitlement(db, env, { orgId, userId, projectId?, rail, estimate, requestId })
  → { ok: true, mode: AiMode, key: ProviderKey, settle(actual), release() }
  | { ok: false, status: 402, reason: 'ai_allowance_exhausted' | 'ai_spend_ceiling_reached' }
```

Order of decisions, in one place:

1. Resolve the **org plan** (§4) — every org has one; `billing_scope` is no longer required.
2. If the org has a **BYOK key for this rail's provider** → `byok`. Return the org's key.
   Record a `mode=byok` row; no meter, no ceiling.
3. If the plan is **Enterprise** and the contract is current → `unmetered`. Record the row,
   count it toward the platform ceiling, never block on allowance.
4. Otherwise (**Free / Team**) → `metered`: reserve against the weekly allowance; refuse at
   100% (finish up to 105%); count toward the ceiling.
5. **Platform spend ceiling** applies to `metered` and `unmetered` (not `byok`).

It returns the API key to use, so a route cannot pick the house key by accident. A thin
`paidFetch()` wrapper around it (reserve → fetch → settle from `usage.cost` / measured units →
release on error) replaces the per-route hand-rolled fetches. There is **no shared OpenRouter
wrapper today**; each route calls `fetch` directly, and `llm-vendor.ts` only builds request
extras.

### 3.2 Every paid call path and its coverage today

Ledgers: **WS** = `workspace_usage_requests`, **CU** = `org_credit_usage_daily`, **WU** =
`org_word_usage_daily`. "Weekly on/off" = `BILLING_WEEKLY_USAGE_ENFORCE`, which is off everywhere.
`auth-worker/src` unless the path says `sync-worker/`. **Nothing honours BYOK server-side.**

| # | Path | Entry (file:line) | Provider | Recorded today | Blocks before spend today | Rail |
|---|---|---|---|---|---|---|
| 1 | Chat proxy | `routes/chat.ts:259` | OpenRouter | weekly on: WS · off: CU+WU | rate limit, ceiling (WS only if on) | llm |
| 2 | Agent run (+ nested `draft` tool) | `routes/agent.ts:534`, `lib/agent/tools/draft.ts:179` | OpenRouter | weekly on: WS/step · off: CU+WU | rate limit, ceiling, per-run cost cap | agent |
| 3 | Import classify | `routes/import-classify.ts:124` | OpenRouter | weekly on: WS · off: CU+WU | ceiling | llm |
| 4 | Smart edits LLM | `routes/ai-smart-edits.ts:300` | OpenRouter | weekly on: WS · off: CU+WU | ceiling | llm |
| 5 | Segmentation generate | `routes/contextual.ts:2273` | OpenRouter | weekly on: WS · off: **none** | ceiling | llm |
| 6 | Autopilot tick | `routes/contextual.ts:466` → `lib/contextual/tick.ts:324` | OpenRouter | weekly on: WS · off: **none** | ceiling at start + per wave; resume/steer unchecked | agent |
| 7 | Transcription (Whisper/Qwen) | `routes/transcription.ts:45` → `lib/transcribe-core.ts:245` | OpenRouter audio | weekly on: WS · off: CU | ceiling, rate limit | audio |
| 8 | Transcription Omni | `lib/transcribe-core.ts:190` | Modal GPU | weekly on: WS · off: CU | ceiling, rate limit | gpu |
| 9 | **Autopilot reaction / wake** | `routes/contextual.ts:854, :920` | OpenRouter | **none** (weekly on: throws — run has no `roleSnapshot`, `:430-432`) | ceiling only | agent |
| 10 | **DraftCells** (Agent API) | `sync-worker/…/commands-draft-cells.ts:201` → `routes/ai-draft-internal.ts:67` | OpenRouter | CU only, **never WS** | ceiling | agent |
| 11 | **Brief summary** | `sync-worker/…/brief-summary-bridge.ts:45` → `routes/ai-brief-internal.ts:66` | OpenRouter | CU only, never WS | ceiling | llm |
| 12 | **Import sandbox** | `routes/import-sandbox.ts:289` | OpenRouter + CF Containers | LLM: CU+WU, never WS · containers: **none** | ceiling | llm + sandbox |
| 13 | **TTS synth + voice clone** | `sync-worker/src/tts.ts:158` | Inworld | CU **estimate** (2¢/call), never WS | ceiling, rate limit | tts |
| 14 | **Voice design / publish** | `sync-worker/src/tts.ts:490, :555` | Inworld | **none** | rate limit | tts |
| 15 | **Diarization** | `sync-worker/src/diarization.ts:133` | Modal pyannote GPU | **none** | live-job cap, ceiling | gpu |
| 16 | **Voice-convert** | `sync-worker/src/voice-convert.ts:240` | Modal Seed-VC GPU | **none** | rate limit, ceiling | gpu |
| 17 | **ai-seams** | `routes/ai-seams.ts:105` | Jev | **none** | rate limit | jev |
| 18 | **ai-passage-tags** | `routes/ai-passage-tags.ts:151` (direct fetch, skips `callJev`) | Jev | **none** | rate limit | jev |
| 19 | **Jev decide** (react sweep cron, triage, react-check) | `index.ts:620`, `contextual.ts:571, :1963` → `lib/jev/decide.ts:98` | Jev | **none** | per-project rate limit | jev |
| 20 | **Contextual bible-deps** | `contextual.ts:484`, `contextual-bible-check.ts:35` → `lib/contextual/bible-deps.ts:92` | Jev | **none** | rate limit, run time budget | jev |
| 21 | Harmonizer | `routes/ai-harmonize.ts:57` | Jev | **none** | rate limit, kill switch | jev |
| 22 | Smart-edits verify | `routes/ai-smart-edits.ts:142` | Jev | **none** | rate limit | jev |
| 23 | **Knowledge index-doc** | `routes/knowledge.ts:571…`, `knowledge-internal.ts:94` → `lib/knowledge/index-doc.ts:438` | OpenRouter (≤9 calls/doc) | **none**; doesn't request `usage.include` | role only | llm |
| 24 | **Monday analyze** | `routes/monday.ts:919` → `lib/monday/analyze.ts:148` | OpenRouter (2-3 calls) | **none**; requests cost then discards it | role only | llm |
| 25 | Tools builder | `routes/tools.ts:114` → `lib/tools/builder.ts:114` | OpenRouter / operator key | **none** | role only; `attempt` is client-supplied | llm |
| 26 | Agent `run_code` sandbox | `lib/agent/sandbox-client.ts:126` → `agent-worker/src/app.ts:245` | CF Containers | **none** | pool caps (20 total, 3/tenant) | sandbox |
| 27 | Omni warm | `routes/transcription.ts:151` | Modal GPU | **none** ("warming is free") | role | gpu |

Bold = on the brief's "not metered today" list; the audit found eight more (#5-6 when weekly
is off, #21, #22, #25, #26, #27). Free/not ours: Aquifer/TaBiThA proxy, `parse-document`,
OpenRouter `/models` and `/generation` lookups, browser-direct BYOK calls
(`completion-service.ts:703, :727`, `gemini-tts.ts:99`).

**After this spec every row goes through `checkAiEntitlement`.** Jev returns tokens, not cost:
price them from the OpenRouter rate card (`rate-card.ts`). #23 and #24 must request and keep
`usage.cost`. #25 must take `attempt` from the server.

**✅ Q3 — Omni warm (#27) and container time (#12, #26) (decided).** **Meter them** on the gpu
and sandbox rails, using measured seconds, so there is no unmetered path a user can loop on.

### 3.3 Background work attribution

Autopilot ticks, reaction runs, cron react sweeps, and setup-time brief summaries bill the
**project's org** with `user_id = 0`. A run started by a person carries that person's id. When
an org hits 100%, background runs **pause** (resume on reset or upgrade) rather than fail.

## 4. Plans

### 4.1 Three tiers

| | Free | Team | Enterprise |
|---|---|---|---|
| Who | every org, by default | orgs that pay via Stripe | orgs an admin flags |
| AI | weekly allowance (global default, admin can override per org) | a fixed multiple of Free (§4.3), multimodal included | unmetered, still recorded |
| Price | $0 | **$500/mo or $5,000/yr**, flat per org, no seats | invoiced outside Stripe |
| Support | docs | basic support | contract |
| BYOK | OpenRouter + Gemini: meter off for those | same | same (rarely needed) |

BYOK (✅ Q9) covers **OpenRouter and Gemini** keys. GPU (Modal) and sandbox (Cloudflare
containers) cannot use a customer key, so they **stay metered even for BYOK orgs**.

### 4.2 One plan resolver

Replace `allowance.ts`'s eligibility chain, the dual Field/workspace plan models, and the
dead `isEnterpriseOrg` / `resolveProjectEntitlements` (`src/lib/entitlements/entitlements.ts:46-62`,
zero production callers) with one server function:

```ts
resolveOrgPlan(db, orgId) → { tier: 'free' | 'team' | 'enterprise',
                              weeklyRawMicroCents: number | null,   // null = unmetered
                              periodStart, periodEnd, source }
```

- **Storage:** `org_billing.plan` gains `free | team | enterprise` (today `none|explore|field|
  enterprise`). Add `contract_ends_at TIMESTAMPTZ NULL`. Keep `weekly_allowance` as the per-org
  admin override (already exists, `allowance.ts:9`).
- **Free:** no row needed; `platform_settings.fieldPlan.freeWeeklyAllowance` (already exists,
  `allowance.ts:17-28`) becomes `freeWeeklyRawUsd` (default **1.00**), the global cap.
- **Team:** set by the Stripe webhook from `workspace_plan_entitlements` (existing tables and
  idempotent `applyBillingEvent` stay). Allowance = `teamMultipleOfFree` (24) × the Free cap.
- **Enterprise:** set only by a platform admin. After `contract_ends_at`, the org gets a
  **Team-sized allowance for a 14-day grace**, then Free (✅ Q5).
- The client gets the same answer from one endpoint (`GET /api/v2/orgs/:id/plan`), so there is
  no client copy of the rules. Delete `src/lib/entitlements/*`; nothing calls it.
- **`billing_scope`** (`personal | team`) stops gating AI. Personal workspaces are Free orgs like
  any other. **Any org, including a personal workspace, can buy Team** (✅ Q6).

### 4.3 Reconciling the catalog

Today Stripe has 10 bindings (`catalog-schema.ts:4-19`): pro, max_5x, max_20x, team, team_20x ×
month/year, with team at **$600/mo, $6,000/yr** (`config/pricing/baseline.json`); the legacy
Field Plan is $500/28 days in code (`plans.ts:13-20`) but $600/mo in `scripts/stripe-setup.ts`.
Marketing shows Free/Pro/Max/Team/Enterprise with "Pricing coming soon".

Recommendation: **collapse to two prices — Team monthly ($500) and Team annual.** Archive
pro/max_5x/max_20x/team_20x in Stripe (no live subscribers: live checkout has never been
enabled). Relax the "exactly 10 bindings" schema to "exactly the Team bindings". The old
"Field Plan" name dies; "Team" is the only paid self-serve name.

**✅ Q4 — Team annual price:** **$5,000/yr** (two months free).
**✅ Q8 — Seats:** Team is **flat per org**, with no per-seat pricing.

**✅ Q7 — Team allowance (decided).** **Team = 24 × Free = $24/week of raw cost.** The rule
behind it is Ryder's "make sure we can absorb the cost no problem":

> Team at 100% use every week must cost us **at most 25% of Team revenue** in raw provider
> cost.

- Team revenue per week: monthly is $500 × 12 ÷ 52 ≈ $115.38; annual is $5,000 ÷ 52 ≈
  **$96.15**. Size against the lower figure, annual.
- 25% × $96.15 ≈ **$24/week raw**, which is 24 × Free's $1. (Ryder's earlier "500×" was a
  placeholder; it would only fit a Free cap of about 5¢ a week.)
- On a fast model that is roughly 270,000 words a week; on a smart model about 20,000.

Two rules keep it absorbable:

1. **Team scales with Free.** `platform_settings.teamMultipleOfFree = 24`. When an admin changes
   Free, Team changes with it.
2. **The admin portal shows Team's implied raw cost** next to the Free cap ("Team at 100% =
   $24/week raw, 25% of annual revenue") and warns when a Free change pushes Team past 25%.
   The platform spend ceiling (§5.2) remains the backstop. Heavy users can bring their own keys.

## 5. Rollout safety

### 5.1 Who gets refused today if enforcement flips on

`readWeeklyAllowance` returns `null` (`auth-worker/src/lib/billing/allowance.ts:10-11`) unless
`workspace.eligibility.reason` is `ready` or `already_subscribed`. The reasons that return null
(`billing/workspace.ts:62-74`):

- `scope_unconfirmed` — `organizations.billing_scope IS NULL` (most existing orgs).
- `existing_billing` — any Stripe id, plan not `none|explore`, a `hard_cap_words`, or
  complimentary words: **every legacy Field/Enterprise org**.
- `covered_access` — partner `org_entitlements` with no weekly allowance.
- `personal_collaboration_review` — personal scope with collaborators.

Null makes `reserveWorkspaceUsage` throw (`workspace-usage.ts:92-94`) and the route returns
**503 `usage_accounting_unavailable`** (chat `:389`, import-classify `:192`, smart-edits `:374`,
contextual `:2389`) or an SSE error (agent `:1030`). The plan resolver (§4.2) removes every one
of these: an org without a row is Free, a legacy Field org maps to Team, a legacy Enterprise or
partner-covered org maps to Enterprise. The backfill writes those rows before shadow starts.

### 5.2 The spend ceiling misses metered spend — confirmed

`db/shared/ai-spend-ceiling.ts:134-137` sums `raw_cost_cents` from `org_credit_usage_daily`
only. On the metered path:

- **chat** — `recordCredit` at `chat.ts:478` and `:510` sits inside `if (!usage)`; a metered
  call writes only WS.
- **agent** — `agent.ts:1365` is `if (usage) return`, immediately before `recordCredit` at
  `:1366`; a metered run writes only WS.
- Same in `transcribe-core.ts:220-229, :266-273`.
- Autopilot ticks (#6) never write CU in **either** mode.

So the claim is **true**, latent only because weekly metering is off. Fix: the ceiling sums
`raw_micro_cents` from `workspace_usage_requests` where `mode <> 'byok'` and state is
`reserved` or `settled` for today (reservations count, so a burst cannot overshoot). The
ceiling's stale "flat 1¢" header comment (`:31-35`) goes too.

### 5.3 402, not 429

No server route returns 402 for usage. Limits return 429 (`credit_cap_exceeded`,
`weekly_ai_allowance_exhausted`) or 503 (`ai_spend_ceiling_reached`). The client checks for 402
(`completion-service.ts:718-720`, `agent-client.ts:110-111`) and string-matches the rest
(`smart-edits/client.ts:102`, `transcribe-hosted.ts:98`, `ai-error.ts:233`,
`tts-engine-error.ts:74`).

Contract: **402** with `{ error: 'ai_allowance_exhausted', tier, resetsAt, canUpgrade, canByok }`
for allowance; **503** `ai_spend_ceiling_reached` for the platform ceiling (our problem, not the
user's); **429** only for rate limits. The agent stream emits the same body as a `budget.exhausted`
frame. One client helper parses it and drives §6.

### 5.4 Shadow mode

One env var replaces `CREDIT_ENFORCE`, `BILLING_WEEKLY_USAGE_ENFORCE`, `BILLING_CHAT_USAGE_REHEARSAL`
and `AI_BUDGET_ENFORCE`:

```
BILLING_METER_MODE = off | shadow | enforce     (default: shadow once shipped)
```

- **shadow**: the check runs for real, every row is written, the decision is stored as
  `would_block` instead of `block`, and the request proceeds. A PostHog event
  `ai_entitlement_would_block {org_id, tier, rail, pct}` fires once per org per week.
- **Admin report** (platform admin → Billing): orgs that would have been blocked this week,
  their tier, % used, and the paths that drove it. This is the evidence for the enforce flip.
- **enforce** rolls out by per-org allowlist first (`platform_settings.meterEnforceOrgs`), then
  global.
- Exit criteria for global enforce: **two full weekly periods in shadow** (✅ Q12); every would-block org
  reviewed; zero `usage_accounting_unavailable`; ceiling sum within 5% of the OpenRouter
  dashboard for the same days.

## 6. UX

**One meter component** (replaces `BillingUsagePanel`, `CreditsPanel`, `CreditsDial`,
`AgentUsageRing`, `BudgetMeter`'s allowance alert, `UsageSection`). It shows a percentage and
when it resets. No credits, words, or dollars anywhere a customer can see (R7). Placement: org
overview, billing settings, and the agent dock.

| State | Meter | What stops | CTA (admins) | CTA (members) |
|---|---|---|---|---|
| Free/Team < 80% | `42% of this week's AI` | nothing | — | — |
| Free/Team ≥ 80% | amber, `Resets Mon` | nothing; one dismissible banner per week | Free: **Upgrade to Team** · Team: **Add your own key** | "Ask an admin" |
| Free/Team 100% | red | new AI actions (drafting, agent, autopilot, TTS, transcription, smart edits). In-flight work finishes (≤105%). Autopilot pauses. **Never** editing, import parsing, export, comments, sync. | Free: **Upgrade to Team** + **Use your own key** · Team: **Use your own key** + "Talk to us about Enterprise" | "Your workspace has used this week's AI. Ask an admin." |
| BYOK | greyed meter, tooltip "Using your own key — usage is billed by your provider" | nothing on our side | — | — |
| Enterprise | **Unlimited** with a premium treatment | nothing | — | — |

Enterprise treatment: a distinct, quiet premium badge (think Wealthsimple Premium/Generation):
a metallic-tinted "Enterprise" chip on the org switcher and billing page, and the meter replaced
by an "Unlimited" pill in the same slot. No progress bar. Design detail is a ticket (§9),
not this spec.

**Agent mode drains faster.** Agent runs use 46–100× more input tokens per translation than
a one-shot draft (§2.3). On Free, a few agent runs on a smart model can use the whole week. The
agent dock shows the meter before a run starts. At ≥ 80% it adds one line: "Agent runs use
much more of your allowance than drafting." The per-run cost cap the agent already has is shown
as % of the weekly allowance, never in dollars.

BYOK covers only OpenRouter and Gemini (✅ Q9), so a BYOK org still has a live meter for GPU
and sandbox work. In that case the meter shows only the metered share, with a tooltip: "Your
own keys cover text AI and Gemini voices. Transcription GPUs and import sandboxes still count
here." The fully greyed meter appears only when the org has used no metered rail this period.

## 7. Platform-feature entitlements and Stripe

### 7.1 Platform features

The only gate today is `grantAllBillingStub.hasPaidFeature: () => true`
(`src/lib/entitlements/entitlements.ts:24-26`) naming one feature, `global-tm-opt-out`. Global TM
itself **does not exist**: nothing ingests into or reads from it (`src/lib/global-tm/index.ts:5`
says "INERT"); `contributeToGlobalTm` is a settings key with no consumer.

**✅ Q10 (decided): no paid platform features at launch.** Free is the whole app (R3); plans
differ only by AI. Delete the stub and `global-tm`. If global TM is ever built, its opt-out is a privacy
control and should be free for everyone, not an Enterprise upsell. Plan-only extras that *could*
come later (SSO, audit export, priority support) are listed as non-goals.

### 7.2 Stripe go-live for Team

Existing pieces to keep: workspace checkout, `reconcileWorkspaceLifecycle`/`Payment` webhooks,
idempotent `org_billing_events`, workspace portal configs. To add or decide:

- **Tax (Canada GST/HST).** Checkout has no `automatic_tax` or `tax_id_collection`
  (`workspace-checkout.ts:87-101`). Add both. Prices are tax-exclusive. (✅ Q11) Stripe Tax
  **calculates and collects** tax and **monitors registration thresholds**, but it **does not
  register us** with any tax authority. So: register for **Canada GST/HST now** (HITL: Ryder's
  business number, then add the registration in Stripe Tax), and add a US state only when
  Stripe's threshold monitoring flags it.
- **Dunning and grace.** Today a failed payment "immediately applies the Free cap"
  (`pricing-model.md:159`). Recommendation: Stripe Smart Retries over **7 days**, Team allowance
  kept during retries, Free cap after the final failure, email at each step.
- **Cancel / downgrade.** Cancel at period end (portal config already does this); Team
  allowance until `paid_through`, then Free. Usage already consumed this week is kept.
- **Customer portal.** One portal config for Team: update card, invoices, switch monthly↔annual,
  cancel. No plan picker beyond Team.
- **Annual billing.** Second Team price, $5,000/yr (✅ Q4). Switching mid-term prorates via the portal.
- **Live switch.** `BILLING_WORKSPACE_CHECKOUT_ENABLED=true` in production requires
  `BILLING_METER_MODE=enforce` (replaces the dual gate in `billing/environment.ts:40-44`).
- **Marketing.** `aquilla-marketing/src/views/Pricing/PricingPage.tsx` and `catalog.ts` show
  Free/Pro/Max/Team/Enterprise and "Pricing coming soon" (`stripe-public.json` is `null`).
  Rewrite to three cards (Free / Team $500 / Enterprise "Talk to us"), drop the Individual vs
  Team audience toggle, keep the % framing in the FAQ ("words are never metered" stays true),
  delete `public/mkt/pricing-v3/v4/v5.html`.

## 8. Questions and decisions

Ryder answered all twelve on 2026-10-19.

| # | Question | Status | Answer |
|---|---|---|---|
| Q1 | How is the allowance set? | ✅ | the meter runs on raw cost; Free = $1/week raw, admin-editable; credits are a derived display unit only (§2.3) |
| Q2 | One markup for every rail? | ✅ | one 4× markup; the agent's 5× is dropped |
| Q3 | Meter Omni warm and container seconds? | ✅ | meter them |
| Q4 | Team annual price | ✅ | $5,000/yr |
| Q5 | Enterprise after contract end | ✅ | 14-day Team-sized grace, then Free |
| Q6 | Can a personal workspace buy Team? | ✅ | yes, any org can |
| Q7 | Team allowance size | ✅ | 24 × Free = $24/week raw, ≤ 25% of annual Team revenue; scales with Free (§4.3) |
| Q8 | Team seats | ✅ | flat per org, no seats |
| Q9 | BYOK scope | ✅ | OpenRouter + Gemini; GPU and sandbox stay metered for BYOK orgs |
| Q10 | Paid platform features at launch | ✅ | none |
| Q11 | Tax registration | ✅ | Stripe Tax calculates, collects and monitors thresholds but does not register us; register Canada GST/HST now, add US states when flagged |
| Q12 | Shadow length | ✅ | two full weekly periods |

## 9. Proposed tickets (not filed — awaiting approval)

**AFK** = an agent can do it end to end with tests. **HITL** = needs Ryder (a decision, a
secret, a dashboard, or a production flip). Order is the dependency order.

| # | Ticket | Type | Depends on |
|---|---|---|---|
| T0 | Ryder approves the spec (all questions answered 2026-10-19) | HITL | — |
| T1 | Raw-dollar allowances: `freeWeeklyRawUsd` = 1.00, `teamMultipleOfFree` = 24, derived display unit for admin screens; drop the 25-unit Free and offer table in `pricing-model.ts` | AFK | T0 |
| T2 | Ledger migration: widen `rail`, add `mode`/`decision`, system user, nullable project; spend ceiling reads it | AFK | T0 |
| T3 | `resolveOrgPlan` + `org_billing.plan` free/team/enterprise + `contract_ends_at`; backfill legacy Field→Team, Enterprise/partner→Enterprise, rest Free; delete `billing_scope` gating | AFK | T2 |
| T4 | `checkAiEntitlement` + `paidFetch` in `db/shared`, `BILLING_METER_MODE` off/shadow/enforce, 402 contract | AFK | T2, T3 |
| T5 | Move already-metered paths (#1-8) onto `paidFetch`; fix reaction-run `roleSnapshot` (#9) | AFK | T4 |
| T6 | Bring auth-worker LLM paths under the check: #10, 11, 12, 23, 24, 25 | AFK | T4 |
| T7 | Bring Jev paths under the check (#17-22); route passage-tags through `callJev`; token→cost via rate card | AFK | T4 |
| T8 | Bring sync-worker audio/TTS/GPU paths under the check (#13-16, 27) with price-card reserve + measured settle | AFK | T4 |
| T9 | Container-seconds metering for #12 and #26, and GPU-seconds for Omni warm #27 | AFK | T4 |
| T10 | Admin portal: global Free cap, per-org override, Team's implied raw cost + 25% warning, Enterprise toggle + contract end, would-block report | AFK | T3, T4 |
| T11 | Client: one 402 helper, one % meter, 80/100% states, CTAs, BYOK disabled meter, Enterprise premium badge | AFK (design review HITL) | T4 |
| T12 | Server BYOK (org key storage, per-rail provider keys) | **AQU-2015** (existing) | T4 |
| T13 | Ship in shadow on prod; review would-block report after two weeks | HITL | T5–T8, T10 |
| T14 | Stripe Team: collapse catalog to 2 prices ($500/mo, $5,000/yr), `automatic_tax` + `tax_id_collection`, dunning/grace, portal config | AFK (code) + HITL (live prices, GST/HST registration, dashboard dunning settings) | T0 |
| T15 | Team onboarding flow | **AQU-2014** (existing) | T14 |
| T16 | Marketing pricing page: three cards, delete old drafts | AFK draft → HITL approve + deploy | T0, T14 |
| T17 | Enforce flip: allowlist, then global; enable live checkout | HITL | T13, T14 |
| T18 | Dead-code removal (§10) | AFK | T17 + one clean week |

## 10. Dead code to remove after T17

Each item was checked for callers on `1fefb63e3`.

**Ledgers and guards**
- `auth-worker/src/lib/billing/words.ts` (488 lines), every `wordGuard`/`recordWords`/`wordCapBody`
  call site (`chat.ts:372`, `agent.ts:638`, `ai-smart-edits.ts:360`, `import-classify.ts:178`,
  `import-sandbox.ts:350`, `contextual.ts:1151, :2341`), table `org_word_usage_daily`.
- `auth-worker/src/lib/credits.ts` (`creditGuard`, `recordCredit`, `grantCredits`),
  `sync-worker/src/credits.ts`, `src/lib/credits.ts`, `src/lib/sync/credits.ts`; table
  `org_credit_usage_daily` (keep read-only 90 days for history, then drop);
  `org_settings.credits.*` keys; `CREDIT_ENFORCE`.
- `auth-worker/src/lib/ai-budget.ts` request budget (log-only, superseded by the meter) and
  `AI_BUDGET_ENFORCE`; `BILLING_WEEKLY_USAGE_ENFORCE`, `BILLING_CHAT_USAGE_REHEARSAL`.

**Plans and Stripe**
- `src/lib/billing/plans.ts` and `auth-worker/src/lib/billing/plans.ts` (Field Plan maths,
  "keep in lockstep" mirror), `field-pricing.ts`, the legacy checkout route (`billing.ts:122`),
  `BILLING_CHECKOUT_ENABLED`, `STRIPE_PRICE_FIELD` / `STRIPE_PRICE_ADDON` vars
  (`wrangler.toml:233-234, :552-554`), Field prices in `scripts/stripe-setup.ts`.
- `canBuyAddon` (`auth-worker/src/routes/billing.ts:101`, `src/lib/sync/billing.ts:34`) and
  the `kind=addon` 409 branch (`billing.ts:137-139`).
- `org_billing.addon_packs`, `complimentary_words`, `hard_cap_words`.
- `auth-worker/src/lib/billing/price-cohorts.ts` + table `billing_price_cohorts` (only its own
  test imports it).
- `pricing-model.ts` offers pro/max_5x/max_20x/team_20x; the 10-binding rule in
  `catalog-schema.ts`.

**Entitlements and UI**
- `src/lib/entitlements/*` (`isEnterpriseOrg`, `resolveProjectEntitlements`,
  `grantAllBillingStub`) and `src/lib/global-tm/index.ts`; `contributeToGlobalTm` stays as an
  inert setting until global TM exists, or is dropped with the parity tests that use it
  (`parity/acceptance/tm-governance.test.ts`, `workflow-tm.test.ts`).
- `BillingWorkspaceSummary` wrapper (`src/components/org/BillingWorkspaceSummary.tsx:16`, no
  callers), `CreditsPanel`, `CreditsDial`, `AdminCreditsSection`, the Explore/Field/Enterprise
  select in `AdminBillingSection.tsx:138-153`, word/credit grant controls.
- The client 402/429 string-matchers replaced by T11's helper.

**Docs and marketing**
- Mark `2026-08-13-stripe-field-plan-billing.md` and `docs/runbooks/billing-spec-proposed.md`
  superseded by this spec; update `docs/pricing/pricing-model.md`.
- `aquilla-marketing/public/mkt/pricing-v3/v4/v5.html`.

## 11. Non-goals

Per-seat pricing; usage-based overage billing; add-on packs; SSO, audit export, and priority
support as plan features; a self-serve Enterprise checkout; showing credits or dollars to
customers; BYOK for Modal GPU, Cloudflare containers, or Inworld.

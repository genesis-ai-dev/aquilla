# Agentic Harness Strategy — Deep AI Integration for Aquilla

Status: DRAFT v2 (adversarial design loop + 3 independent reviews, 2026-06-11)
Owner: Ryder
Inputs: AI chat feature investigation (2026-06-11), UX-JOURNEY-AUDIT-2026-06-10
(F-B2, FRO-265), positioning per `src/pages/Homepage/Homepage.tsx` (the
canonical POSITIONING.md is not committed to this repo — fix or re-point).

## 0. Verdict from the design loop

The winning shape is **not** "chat with more tools." It is a small set of
**targeted, named agentic harnesses** — bounded tool loops that do one
translation-workflow job each, surfaced as buttons inside the existing
workflow — plus a thin chat front-end that routes to the same machinery.
Three ordering rules fell out of review:

1. **Cost governance ships before any LLM loop** — everything else
   multiplies spend.
2. **Prevention before the LLM checker** — ground the *drafter* in
   terms/rules (Phase 1) before the LLM checking layer (Phase 3), or the
   product keeps manufacturing the inconsistencies the checker flags and
   pollutes the acceptance-rate metric. The *deterministic* checker
   (Phase 0.5) is exempt: its findings are exact, so high volume from
   ungrounded drafting is signal, not noise — expect that volume to fall
   once Phase 1 lands.
3. **The deterministic floor ships before the LLM layer** — rules engine,
   glosser, FTS, and term matching are free and already built; a
   deterministic "Check chapter" earns trust with zero hallucination risk
   and gives the LLM layer an adoption surface and a baseline.

**Transformation sentence:** *An expert can check a chapter as fast as the
AI drafts one — and the project stays consistent without anyone policing
it.*

## 1. Problem (one story)

A translator batch-drafts Matthew 1 with "Translate all." Fourteen of
thirty verses render Χριστός differently from the project's term base.
Nothing flags it. Three weeks later a consultant finds it during a
checking session; the team re-opens thirty "done" verses and the owner's
dashboard quietly lied the whole time.

Two failures, two fixes, in this order:

- **Prevention:** the drafter ignored the term base and rules the project
  already maintains. Grounding batch/single drafting in them is
  context-injection work, not agentic work.
- **Detection:** human edits drift and legacy text exists, so checking is
  still needed — but today checking is manual, deferred, and
  coordination-heavy, and the expert is the bottleneck while drafting is
  AI-fast.

"Users expect chat features" is not the problem; chat is one interface to
the fix. This is the core positioning ("make quality visible," "compress
coordination," "scale translation without losing trust") and what the
credibility-critical Paratext consultant cohort will judge us on.

## 2. Strategy in one diagram

```
 Entry points                 HARNESS RUNTIME (auth-worker route)
 ┌───────────────┐     ┌──────────────────────────────────────────┐
 │ Buttons in    │────▶│  named harness = system prompt + fixed   │
 │ workflow      │     │  tool allowlist + iteration cap + token  │
 │ (chapter hdr, │     │  ceiling + output schema (a TS config    │
 │ cell rail,    │     │  object in the worker — not a registry)  │
 │ term chips)   │     │                                          │
 └───────────────┘     │  deterministic tools run FIRST and free; │
 ┌───────────────┐     │  LLM loop (OpenAI tool-calling via       │
 │ Chat panel    │────▶│  OpenRouter) only on what they can't     │
 │ (same         │     │  decide. Haiku default; Sonnet only      │
 │ machinery)    │     │  where the config says judgment is the   │
 └───────────────┘     │  product. Streams typed SSE frames.      │
 ┌───────────────┐     │                                          │
 │ Scheduled /   │────▶│  propose-only writes → proposal cards    │
 │ event hooks   │     │  (Apply gated by role; never silent)     │
 │ (later)       │     └────────────────┬─────────────────────────┘
 └───────────────┘                      │ every loop metered
                       ┌────────────────▼─────────────────────────┐
                       │ COST GOVERNANCE: org ledger (tokens+cost)│
                       │ · per-run ceilings · degradation ladder  │
                       │ · org-level BYO key · top-ups (gated)    │
                       └──────────────────────────────────────────┘
```

## 3. Tool layer: honest inventory

Review finding (Critical): the v1 draft claimed the tools "all exist
today as modules." They exist, but in three execution contexts, none of
which auth-worker can import today (zero `src/` imports exist in either
worker; the workers are self-contained packages):

| Capability | Where it lives today | Server path for harness runtime |
|---|---|---|
| FTS search / parallel passages | sync-worker routes (`search-route.ts`, `scoped-search.ts`), sync-token auth; client has fetch wrappers only | **Direct SQL from auth-worker** against shared Hyperdrive→Neon (`value_tsv` GIN index confirmed at schema.sql:242,421) |
| Cell history | sync-worker `cell-history-read-route.ts` | Direct SQL (same) |
| Comments | sync-worker `comments-read-route.ts` | Direct SQL (same) |
| Concepts / rules data | `project_settings.settings` JSON blob (auth-worker already reads this table) | Direct read; see concepts tool contract below |
| Rule engine (`checkRulesForCell`) | `src/lib/rules/rule-engine.ts` — pure but uses `@/` aliases into app code | **Extract to shared package** (`packages/translation-core` or similar) consumed by app + auth-worker |
| bt-glosser | `src/lib/completion/bt-glosser.ts` — pure, portable | Extract to same shared package |
| Term matching | `src/lib/terminology/match.ts` — pure | Extract to same shared package |

**Decision (settle before Phase 2):** auth-worker queries `AQUILLA_PG`
directly for cells/search/history/comments (the shared DB is the real
contract; both workers already bind the same Hyperdrive), and the pure
algorithmic modules (rule engine, glosser, term match) are extracted to a
shared internal package. We do **not** call sync-worker over HTTP from
auth-worker (extra hop, sync-token minting, drift risk) and we do not
duplicate the SQL ad hoc — the search SQL choke point in
`scoped-search.ts` moves to a shared location or is consciously forked
with a comment cross-referencing it.

**Concepts tool contract:** never dump the term base. The tool takes the
scoped cell IDs, runs surface-form matching (extracted `match.ts`) of
active concepts against those cells' source/target text, and returns at
most N matched concepts with their approved renderings. Truncation is
deterministic code, not model discretion — this rule applies to every
tool (top-k, char caps, server-side).

**Glosser cost note:** the glosser builds its alignment model from
validated pairs at run time. Cap seed pairs to the scoped book, or cache
the compiled model per (project, corpus version). Set `limits.cpu_ms`
explicitly in auth-worker's wrangler.toml when this lands.

## 4. The harness catalog

Each harness is a **named config** — a TypeScript object in the worker:
system prompt, tool allowlist, iteration cap, token ceiling, default
model, output schema. Config changes are code changes (reviewed,
deployed). No versioning registry in v1; add versioning only if A/B
testing prompts becomes a real need (≥3 harnesses in production).

### v1 harness (fully specified): `check-chapter`

| | |
|---|---|
| Job | "Find anything wrong or inconsistent in this chapter" |
| Deterministic pass (free, runs first) | `checkRulesForCell` over scoped cells; term-consistency scan (match.ts against term base); glosser drift flags |
| LLM pass (only on residue) | search_cells for parallel-passage comparison; concept-aware judgment on flagged-but-ambiguous cases |
| Tools | search_cells, concepts, history, add_comment(draft); **findings-only in v1 — no propose_edit** (smaller blast radius; suggested fixes arrive after acceptance-rate data) |
| Model | Haiku; Sonnet only for final drift verdicts |
| Caps | 4 iterations / 40k tokens in v1 (raise with telemetry) |
| Output schema | findings[] — each MUST carry cell IDs + rule/concept IDs as evidence; schema validator drops citation-less findings |
| Est. cost/run | $0.00 (deterministic-only mode) to ~$0.08. Behind $0.08: ≤4 LLM calls averaging ~8k input (mostly cached prefix at ~0.1×) + ~400 output on Haiku ($1/$5 per MTok), plus one Sonnet verdict call. Re-baseline with Phase 0 telemetry. |

### Horizon sketches (orientation only — full specs deferred until
`check-chapter` validates the runtime contract)

- `term-audit` — "Is ⟨term⟩ rendered consistently everywhere?" (Haiku;
  concepts + search; proposes term-base updates)
- `bt-verify` — "Back-translate this passage and flag meaning drift"
  (glosser + LLM BT + Sonnet compare; the compare step is new work)
- `draft-passage` — the existing batch/single draft, upgraded with
  term/rule grounding (the grounding itself ships in Phase 1 — see §8)
- `ask-project` — grounded conversational Q&A (the chat panel's backend)

Deliberate exclusions (v1): web search (costly, least differentiating,
licensing questions on exegetical sources); autonomous multi-agent swarms
(wrong cost/trust profile — the *jobs* the bot-swarm vision depicts ARE
this catalog); autonomous writes of any kind.

**The flywheel requirement (every harness, structural):** accepted
outputs must enrich the project's durable memory — a term-base entry, a
rule, a validated pair, a comment — not just patch text. This is what
makes harnesses compound the living-memory moat instead of renting
intelligence per run, and it is measured (see §10 metrics).

## 5. Architecture decisions

### 5.1 The loop runs server-side (auth-worker)

New route family, e.g. `/api/v1/ai/harness/:name`. Client sends harness
name + scope (cell/chapter/book IDs); worker runs deterministic tools,
then the LLM tool loop against OpenRouter, streaming typed SSE frames.

Why server-side: budget enforcement and platform-key custody are
impossible client-side; tool reads need server authority (JWT identifies
the user; **every tool call re-checks project membership**); audit and
telemetry come free.

**Workers runtime fit (corrected from review):** Cloudflare's 30s limit
is *CPU time*, not wall-clock — a streaming, I/O-bound response may run
longer while the client holds the connection. The loop is I/O-bound
(LLM calls + SQL), so the real constraints are: (a) **client disconnect
aborts the loop** — wire the request `AbortSignal` through every fetch
and the loop condition; a disconnected run stops spending within one
iteration; (b) CPU-heavy deterministic tools (glosser build) respect the
CPU budget per §3. No Durable Object in v1: single-job harness runs are
one request/one stream, stateless server-side. If scheduled or
long-running harnesses arrive later, a Workflow/DO slots behind the same
route contract.

**Conversation state contract:** single-job harnesses are stateless —
one request, one SSE stream, done. `ask-project` (conversational) has
the client re-send history each turn, truncated server-side to **10
turns or 8k tokens, whichever is smaller** (rolling truncation; summary
compaction is a later optimization). This contract is defined now
because Phase 1 grounded chat wires the same pattern.

**Nested invocation:** none in v1. Chat may *link* to harness buttons
("Run Check chapter on MAT 1 →") but does not execute harnesses as
tools. This keeps per-run cost ceilings airtight; revisit when telemetry
exists.

### 5.2 SSE protocol surface area

Typed frames: `assistant_delta`, `tool_start`, `tool_result`,
`proposal`, `usage`, `done`, and **`error` `{code, message, retryable}`**
(review caught its absence — without it the client has no failure path).
The harness runtime builds its own OpenRouter request bodies; it does
**not** reuse `buildOpenRouterBody()` from chat.ts.

Client scope this implies (visible in Phase 3 sizing): a frame parser
module (~150 lines) and a proposal/finding card component family
(Apply / Dismiss / evidence links, streaming progress list). The
existing `consumeStream()` parses only OpenAI-shaped SSE and is not
reusable for this.

### 5.3 Proposals, never writes — and who may Apply

Write-shaped tools emit **proposal cards**; Apply routes through existing
mutation paths — cell edits through the FRO-247 clock-fenced write path
(`useCells` writeSeqRef — confirmed present), terminology through the
Concept store, comments through the comments API.

**Attribution is new work, not free:** the `target.cell.edit` event
payload has no author/source field today. Phase 3 includes extending
event payloads (+ sync-worker projection) with an attribution field
(`applied_from: {harness, run_id}` / `source: "llm"`) so AI-applied
changes are auditable and the history UI can render them. Phase 2
reserves the field shape in the event types (unused) so Phase 3 adds a
writer, not a migration.

**Role gate (structural, from review):** Apply is available only to
project roles with target-language competence (the roles that author/
validate today). Owners/PMs — who by the two-audience model do not read
the target language — see findings as **read-only aggregates** (§7).
A PM bulk-accepting edits in a language they can't read is the
agent-overwrote-my-work failure with one click of human laundering;
the gate closes it structurally.

Findings must cite evidence: every finding/proposal carries the cell IDs
/ rule IDs / concept IDs it derives from, rendered as links. The output
schema enforces this; citation-less findings are dropped.

### 5.4 Chat is a front-end, not a second system

The chat panel keeps its conversational UX; its backend becomes the
grounded single-call path (Phase 1) and later the `ask-project` harness.
Chat answers can be **cited into comments** — one-click "save to comment
on ⟨cell⟩" turns consultant-valuable answers into durable, attributed
artifacts. Gateway language: `main_chat_language` (exists in
CompletionSettings) is injected into every harness/chat system prompt —
the assistant speaks the gateway language; quoted text stays in
source/target languages.

### 5.5 Model policy

- **Haiku-class default** for orchestration and most judgments;
  Sonnet-class only where the harness config says judgment quality is
  the product (BT-drift verdicts, draft generation).
- `reasoning` moves into harness/call config. **Correction from review:**
  today `reasoning: {effort:"none"}` is hardcoded for *all* calls in
  `buildOpenRouterBody()` — including chat, where it was never a
  deliberate choice. Keep `none` for draft-style final-string calls
  (intentional); use model defaults for chat and verdict calls.
- **Prompt caching:** stable per-project preamble (harness system prompt,
  term-base summary, rules) marked with `cache_control` so loop
  iterations 2..N read the prefix at ~0.1×. **Schema work required:** the
  current chat route's zod schema is closed — it silently strips unknown
  fields (`tools` would be dropped today) and rejects content-block
  arrays, so `cache_control` can't pass through. Phase 1 extends the
  schema for block arrays + cache_control passthrough; the harness route
  is born with it.
- Harness model IDs are validated against `getAllowedModels()` at
  config-load time; reconcile the existing allowlist's duplicate
  `4.5`/`4-5` spellings while in there.
- No OpenRouter batch API exists. If whole-book audits become common, a
  direct-Anthropic Batches path (50% off) is a documented follow-up;
  not v1.

### 5.6 On-device AI as a tool (experiment track, not roadmap)

The SSE protocol supports client-side tool execution: worker emits
`client_tool_call`, the browser executes (WebGPU model — or today, the
deterministic glosser), POSTs the result back, loop continues. Same
round-trip pattern as hosted-agent custom tools, so on-device models
drop in **without changing the architecture**.

Reality check: fine-tuning an edge model for low-resource drafting is
unproven; few-shot + rules already works. Honest sequence: (a) ship
harnesses on hosted models; (b) let validated pairs accumulate as
training exhaust; (c) run ONE experiment — distill `draft-passage` for
one mature project (LoRA on a 1–4B model via WebLLM/transformers.js) and
compare acceptance rate vs. Sonnet. Go/no-go on that number. Until then
"on-device tier" = the deterministic floor, which is real today.

## 6. Cost governance & funding

### 6.1 Metering (Phase 0 — prerequisite for every LLM-bearing phase; the deterministic-only Phase 0.5 can run in parallel)

- Capture OpenRouter's `usage` per call (already requested via
  `usage: {include: true}`; currently discarded). For streams this means
  tee-ing the SSE body through a TransformStream and writing the ledger
  post-completion via `waitUntil` — it touches the hot path of every
  completion, which is why Phase 0 is sized **M, not S** (review
  correction).
- Extend accounting from request counts to **tokens + computed cost**
  attributed to (user, org, project, harness, model): append-only
  `org_ai_ledger` (grants, top-ups, spend) + daily rollup. Personal
  org-at-signup already exists, so the ledger has a home.
- Enforcement: flip on with token-denominated limits. **Decision (made):
  harness runs fail CLOSED on counter error** (503 "AI checks
  temporarily unavailable" — never run an unbounded loop without budget
  tracking); **single completions keep today's fail-open** (a stuck
  counter shouldn't brick drafting). Rationale: one unmetered draft is
  acceptable; fifty unmetered loop iterations are not.
- Telemetry: latency, success rate, tokens, cost, cache-hit rate, model
  per run — plus the product metrics in §10.

### 6.2 Funding model (org is the unit)

- **Monthly platform grant** per org — provisional **$3** (final number
  set from Phase 0 telemetry). At Haiku prices that is roughly 50–100
  LLM check runs or hundreds of grounded chat turns; median use should
  never feel a ceiling. "Free — because the mission comes first" stays
  literally true for normal use.
- **Org-level BYO key is the first-class funded-org path** (promoted per
  review): org admins store an org-scoped OpenRouter key server-side
  (encrypted at rest in Postgres; auth-worker already custodies
  secrets). Harness runs on an org key bypass the platform ledger but
  keep all ceilings. In this ecosystem the entity that uses (field team)
  is often not the entity that pays (agency/grant); a key the agency
  provisions fits those funding flows better than an in-app payment.
- **Top-ups are a gated hypothesis, not a load-bearing assumption:** no
  Stripe build until **≥10 orgs explicitly ask to pay** (there is no
  live Stripe integration in the codebase today; rebuilding it is weeks
  of work). When built, the language is neutral "top up" / "support
  compute costs" — NOT "donation"/"contribution," which carries
  charitable-receipt connotations that can backfire with mission-org
  finance officers (open question: receiving-entity structure).
- Hard ceilings regardless of balance or key: per-run token ceiling,
  per-user daily, per-org daily, global daily.

### 6.3 Degradation ladder (graceful, legible)

1. **Full** — harness with config model.
2. **Economy** — org balance low: everything routes to Haiku; chat drops
   to single grounded call.
3. **Deterministic floor** — balance exhausted: rules, glosser, FTS,
   term matching still run; every AI button still works and says what it
   checked. Notice: "AI-assisted checks resume ⟨date⟩ — or an org admin
   can add an API key." Never a raw 429.
4. **Org/user API key** — bypasses platform ledger, keeps ceilings.

### 6.4 Cost sanity

Worst-case engaged translator day: 20 check runs + 30 grounded chat
turns + 5 drafts ≈ 20×$0.08 + 30×$0.03 + 5×$0.10 ≈ **$3/day** with no
caching and no deterministic pre-filter. With both (cache reads ~0.1×;
deterministic pass resolves most findings free), realistic heavy use is
**$0.50–1.00/day**, median far below. A $3/month grant covers median
use; heavy orgs are the BYO-key cohort. Runaway spend is closed by
ceilings + fail-closed enforcement, not hope.

## 7. The owner/PM surface (review: previously unserved)

The opening story's victim is the owner whose dashboard lied — and
owners/PMs don't read the target language, so findings/proposals mean
nothing to them. Harness outcomes therefore roll up as
**language-neutral aggregates** on the project/org Overview: "MAT 1:
14 term inconsistencies found · 12 resolved · 2 open," run recency, and
trend. This is a count rollup over data the runtime already produces
(cheap), and it is what converts harnesses from an expert tool into the
oversight/trust signal the positioning sells. Ships with the
deterministic floor (Phase 0.5) in basic form; enriched in Phase 3.

## 8. UX requirements

- Harness entry points live **where the work is**: chapter header
  ("Check chapter"), term chips ("Audit this term"), cell rail, file
  menu. Chat is not the primary door.
- Streaming progress with named steps ("Checked 30 verses against 12
  rules… comparing 4 parallel passages…"); runs take seconds to ~a
  minute; silence reads as broken.
- Findings list = cards with evidence links, Apply (role-gated) /
  Dismiss / open-in-context. Empty state names **what was checked**
  ("30 verses, 12 rules, 8 terms — no issues"), and the LLM layer's
  empty state is explicitly conservative: "found nothing it's confident
  about."
- Run footer shows plain cost ("used ~2¢ of your org's AI balance") —
  cost transparency is part of the trust story.
- Unconfigured/exhausted states name the next step and who can take it
  (translator vs. org admin).

## 9. Phasing (resequenced per review)

| Phase | Ships | Size | What's new (the honest bill) |
|---|---|---|---|
| **0. Meter & enforce** | stream usage tee, org ledger + rollup, fail-closed/fail-open split, telemetry; fix frontier SSE streaming bug | **M** | TransformStream tee on hot path; ledger migration; enforcement flip |
| **0.5 Deterministic check-chapter** | "Check chapter" button running rules + term scan + glosser only; findings UI v0; basic owner rollup counts | **M** | shared-package extraction (rule engine, match, glosser); findings card v0; no LLM, no ledger dependency — can ship in parallel with 0 |
| **1. Grounded drafting + chat** | inject terms/rules/validated-pairs into batch & single draft (prevention) and into chat; gateway language; chat schema extension (blocks + cache_control); copy / insert-into-cell | **M** | prompt assembly; zod schema change; two small chat actions (copy, insert-into-cell); cite-to-comment is deliberately Phase 3 — it rides the card pattern built there |
| **2. Harness runtime** | `/ai/harness/:name` route, SSE typed frames (incl. error), direct-SQL tools, abort-on-disconnect, per-run ceilings | **L** | the runtime itself; SQL tool ports; frame parser client module |
| **3. LLM check-chapter (named beta)** | LLM pass on deterministic residue; proposal cards + Apply gate + attribution field in events; cite-to-comment; enriched owner rollup; 2–3 friendly consultants first, precision-default prompts | **L** | event-payload attribution (+ projection); card component family; beta program |
| **4. Meter UI + org BYO key** | org meter (grant/spend/what-it-bought); org-scoped encrypted key storage + routing | **M** | settings UI; key custody path |
| **Post-v1, demand-gated** | top-ups/Stripe (≥10 orgs ask); `term-audit`, `bt-verify`, `ask-project` harnesses; whole-book batch path; edge-model experiment | — | each gated on the prior phase's telemetry |

Expected interaction (state it so telemetry isn't misread): once Phase 1
grounds drafting, `check-chapter` finding rates should **fall** — that's
success, not a broken checker.

## 10. Success metrics (defined before Phase 3 ships)

- ≥40% of LLM findings accepted; kill threshold: <25% sustained →
  harness reverts to deterministic-only while prompts are reworked.
  (The named-consultant beta exists because the kill threshold protects
  the metric, not the first impression — for this cohort the first wrong
  confident finding is nearly unrecoverable.)
- ≥30% of weekly-active translators run a check weekly by +60 days
  after Phase 3.
- Cost per accepted finding ≤ $0.05.
- **Flywheel:** ≥25% of accepted findings produce a durable artifact
  (term entry, rule, validated pair, comment) — the moat must compound.
- Zero autonomous-write incidents (structural: propose-only + role gate).

## 11. Risks & pre-mortem

| Failure mode | Class | Mitigation |
|---|---|---|
| Runaway spend | preventable | Phase 0 first; ceilings; fail-closed harness counter; abort-on-disconnect |
| Hallucinated findings burn consultant trust | preventable | deterministic floor first; evidence-citation schema; precision defaults; named beta before broad release |
| False-positive fatigue | catchable | acceptance metric + kill threshold |
| Owner misuse of Apply | preventable | structural role gate (§5.3) |
| Feature invisible | preventable | in-workflow entry points; deterministic version ships early |
| Funding hypothesis fails | contained | grant + ceilings + BYO-key stand alone; Stripe gated on demand signal |
| Worker runtime surprises (CPU, disconnects) | catchable | limits.cpu_ms set; abort wiring; iteration caps start low (4) |
| OpenRouter cache/feature drift | catchable | cache-hit-rate telemetry; direct-Anthropic fallback documented |
| Edge-model time sink | preventable | experiment-gated; no roadmap dependency |

## 12. Open questions

1. Grant size: provisional $3/org/month — confirm or adjust after
   Phase 0 telemetry?
2. Receiving-entity structure for top-ups (affects "support compute
   costs" vs. charitable framing) — decide before any Stripe work.
3. Shared-package name/home for the extracted pure modules
   (`packages/translation-core`?) — affects build setup in Phase 0.5.
4. Whole-book audits: enough demand for the direct-Anthropic Batches
   path, or keep interactive-only?
5. Does the owner rollup live on the existing project Overview or a new
   "Quality" panel? (Affects Phase 0.5 scope only slightly.)

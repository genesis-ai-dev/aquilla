# Aquilla Translation Agent — One-Tool SQL Agent Design

**Date:** 2026-06-12
**Status:** Design — supersedes the tool-allowlist portion of `agentic-harness-strategy.md` (branch `ryder/ai-harness-strategy`); keeps its metering, SSE, proposal-gating, and deterministic-floor decisions.
**Inputs:** 2026-06-12 team call transcript; "Building a Good Vertical Agent" (Shortcut agent essay); event-log schema (`db/postgres/schema.sql`, `sync-worker/src/events/`); existing AI stack (`auth-worker/src/routes/chat.ts`, `src/lib/completion/`).

---

## 1. Thesis

A good agent is a **faithful compression of its task distribution**. Aquilla's task
distribution all flows through one substrate already: the append-only event log and
the projections derived from it. So the agent gets **one tool** — `execute_code` —
whose code can do exactly two things:

1. **`sql(query)`** — read-only SELECT against the project's projections and event
   history (Postgres, RLS-fenced to the project).
2. **`emit(events)`** — append events through the *existing* `POST /events`
   pipeline (role-gated, idempotent, AD-2 chain-claimed, projection-updating).

Everything a user can do in the app is an event; therefore everything the agent can
do for a user is an event. Draft a chapter → `target.cell.commit[]`. Leave review
notes → `comment.create[]`. Validate → `cell.validate[]`. Assign work →
`assignment.create`. The agent never mutates a projection table, never needs a
`make_X` tool per feature, and every action it takes is attributable, ordered,
inspectable, and reversible **because the substrate already works that way**.

> Why not raw `INSERT INTO events`? Projection happens in TypeScript
> (`buildEventProjectionStmts`), `server_seq` is allocated under a counter row
> lock, and AD-2 chain claims are transactional. Raw DML would bypass all of it.
> `emit()` is a thin in-worker call into the same code path `POST /events` uses —
> same role policy, same idempotency, same broadcast. SQL is **SELECT-only by
> construction** (a dedicated Postgres role with only SELECT grants + RLS).

### Why this is simpler, cheaper, and more reliable

- **One decision for the model** ("write code"), not a 15-tool routing problem.
  Model accuracy degrades with tool count; composition happens in code, not in
  brittle tool-call chains.
- **Reliability is inherited, not built.** Role policy, N-of-M validation,
  staleness pins (AD-9), first-child arbitration (AD-2), idempotency — all already
  enforced on the write path. The agent cannot be more dangerous than a user of
  the same role.
- **Cost control is structural.** Compressed reads (§4) cut input tokens; the
  deterministic floor (rule engine, term matcher, glosser) runs inside the code
  sandbox for free; the model is reserved for judgment.

---

## 2. The SFL frame: what context the agent gets, stratified

Systemic functional linguistics models meaning as stratified context: **culture**
(potential) → **situation** (instantiated potential) → **semantics** → **lexicogrammar**
→ **expression** (determined). This maps cleanly onto the L1/L2/L3 cache hierarchy
and tells us *what goes in each tier*:

| SFL stratum | What it is for a translation agent | Cache tier |
|---|---|---|
| Context of culture | Project identity: language pair, scripture/CSV/subtitle medium, role model, the event-log contract, "validated pairs are ground truth, not general knowledge" | **L1** — always resident |
| Context of situation | This run: who asked, their role, focused file/chapter/cell, assignment scope, what they asked for | **L1** — injected per run |
| Semantics | What meanings are *permitted here*: termbase renderings, forbidden patterns, rules, validated source→target pairs near the working text | **L2** — fetched on demand (it IS the data; one `sql()` away) |
| Lexicogrammar | The actual drafting choices | The model's job, constrained by L2 |
| Expression | Output format: event payload shapes, USFM/canonical_ref conventions, HTML value rules, audio timing schema | **L1** for the common shapes; **L2** cookbooks for the rest |

The key SFL insight carried over: **you cannot make a marriage vow at a doctor's
appointment**. Situation strictly bounds available meanings. Concretely: the
agent's *available event kinds are filtered by the requesting user's role before
the model ever sees them*. A REVIEWER's agent literally does not have
`target.cell.commit` in its L1 card — the meaning is not makeable, rather than
makeable-then-rejected. (The server still enforces; the prompt filter is for
accuracy and token economy, the pipeline is for safety.)

---

## 3. Context as a layered cache

### L1 — always resident (~250 lines, the whole system prompt)

1. **Identity & stance** (~30 lines): translation agent for project `:project`,
   acting on behalf of `:user` (role N). Project examples are PRIMARY truth;
   ultra-low-resource defaults to project patterns, never general knowledge
   (already the stance in `completion-service.ts`).
2. **The schema card** (~80 lines): hand-written, not introspected. Projections
   (`cells`, `files`, `comments`, `cell_validators`, `cell_backtranslations`,
   `cell_audio`, `assignments`, `cell_word_morph`) as one line each — columns that
   matter, the anchor-chain ordering rule, `value_tsv` for FTS, `canonical_ref`
   for scripture refs. Plus the `events` table shape for history queries.
3. **The event card** (~60 lines): the role-filtered subset of the 26 event kinds,
   one line each: kind → payload shape → what it means. The chain rules that bite:
   `target.cell.commit` needs `parentId` = current `cells.event_id` and
   `sourceEventId` = current source row's `event_id` (AD-9), else it lands `stale`.
4. **The `execute_code` contract** (~50 lines): `sql()` semantics (SELECT-only,
   row cap, compressed result format with alias legend), `emit()` semantics
   (returns accepted/rejected/stale + projection diff + lint), `docs(topic)` for
   L2, dynamic variables, the escalation rule ("if the cookbook is silent, query
   `information_schema` / `meta.reference` — never guess a payload shape").
5. **Safety guidelines** (~30 lines): propose-by-default for bulk writes, never
   fabricate validated pairs, surface `stale`/`rejected` rather than retrying
   blind, budget awareness.

**Dynamic variables.** The agent never types UUIDs. The harness binds named
parameters server-side: `:project`, `:user`, `:file` (focused file), `:cell`
(focused cell), `:assignment` (active assignment scope). In SQL they are bound
parameters; in `emit()` payloads they are string-substituted before validation.
Result sets alias UUIDs the same way (§4), so round-trips stay symbolic.

### L2 — curated cookbooks, one call away

`docs(topic)` returns hand-written prose+SQL recipes (a few hundred lines each),
maintained in-repo, embedded in the worker at build time. Initial set, mirroring
actual task frequency:

- `docs('drafting')` — the canonical draft loop: select untranslated cells in
  chain order, pull the K nearest validated pairs by token overlap
  (`collectValidatedPairs` logic as SQL/FTS), pull matched concepts, draft,
  `emit` with `ai_suggestion: true`, handle `stale`.
- `docs('checking')` — check-chapter recipe: run deterministic rules first (in
  the sandbox, free), FTS for parallel passages, comment findings. Inherits the
  v1 `check-chapter` harness design.
- `docs('terminology')` — concepts model, surface-form matching with inflectional
  wildcards, never-dump-the-termbase contract (top-N matched only).
- `docs('validation')` — N-of-M threshold from `project_settings`, who may
  validate, `cell.validate` payload (`editEventId`), self-validation rules.
- `docs('history')` — event-log archaeology: who changed what when, diffing a
  cell's chain, attribution (`ai_drafted`, `agent_run_id`).
- `docs('assignments')`, `docs('audio')`, `docs('backtranslation')`,
  `docs('files-and-refs')` (USFM book codes, canonical_ref grammar).

Cost: zero tokens until a task needs one; one call to load.

### L3 — the raw tome, queryable with the same tool

No filesystem in a Worker, so the escape hatch is SQL itself:

- **`information_schema`** — the complete live schema, always true, zero
  maintenance.
- **`meta.reference`** — a table `(topic, name, kind, body, body_tsv)` holding the
  full generated reference: every event kind's TypeScript payload type verbatim,
  role-policy table, projection-handler notes, settings-key catalog. Generated
  from `types.ts`/`role-policy.ts` at build time so it cannot drift. The L1 card
  teaches the mining pattern: 3–6 targeted SELECTs with FTS/`LIKE`, same as
  grep-the-tome.

The agent is never stuck: miss in L1 → `docs()` → miss in L2 → mine
`meta.reference` → still grounded in generated-from-source truth.

---

## 4. Compression: reads and write-feedback

**Reading is an act of compression.** `sql()` results are not raw JSON:

- **Tabular, pipe-delimited**, one row per line; nulls as `∅`.
- **UUID aliasing**: ids collapse to `#c1, #c2, …` (cells), `#e1…` (events),
  `#f1…` (files) with a session-scoped legend; aliases are accepted back in
  subsequent `sql()`/`emit()` calls. (The formula-aliasing move, applied to the
  thing that actually bloats our tokens: 36-char UUIDs.)
- **Free row context**: cell rows automatically carry `canonical_ref` (e.g.
  `MRK 4:35`) and validation state — the "header row you didn't ask for".
- **Run-length grouping**: 60 untranslated cells print as
  `MRK 4:1–4:41 · 41 cells · target ∅` plus a sampled handful, with exact counts.
- **Row cap + total**: default 200 rows surfaced, `(… and N more — refine or
  paginate)` so truncation is never silent.

**Write feedback is a built-in linter.** `emit()` returns, in one compact block:

1. **Pipeline verdicts**: accepted / rejected (with role reason) / stale (with
   current `sourceEventId` so the agent can rebase) — straight from the existing
   response shape.
2. **Projection diff summary**: grouped + sampled like the essay's cell diff
   ("41 target cells committed, MRK 4:1–41; file filled_count 12→53").
3. **Deterministic lint, triaged**: `checkRulesForCell` + term matcher run over
   every written cell *inside the sandbox, free*. Violations surface as
   `NEEDS REVIEW: #c7 MRK 4:12 — forbidden term "X"; rule r3`. The agent fixes
   its own mistakes before a human ever sees them — the deterministic floor as
   a consequence-reporter, not just a pre-pass.

---

## 5. Runtime, safety, observability

**Runtime.** One auth-worker route, `POST /api/v1/ai/agent/run` (SSE), reusing the
harness-runtime decisions: typed frames (`assistant_delta`, `code_start`,
`code_result`, `proposal`, `usage`, `done`, `error`), iteration cap (default 8),
token ceiling, abort-on-disconnect, Haiku-by-default with Sonnet escalation for
judgment-heavy runs, all behind `runAiGuard()` (allowlist + budgets, AQU-265).
The sandbox executes the model's JS against the three functions (`sql`, `emit`,
`docs`) — no network, no other globals.

**Safety = the substrate, plus two additions:**

- **Postgres `agent_ro` role with RLS** (the transcript's "assuming we had RLS"):
  SELECT-only grants on projections + events; RLS policy
  `USING (project_id = current_setting('app.project_id'))`; the route sets
  `app.project_id` per run. The app's own writer path is untouched. This makes
  prompt-injection-via-cell-content unable to *read* across projects and unable
  to write *anything* except role-gated events attributed to the run.
- **Attribution + rollback**: every emitted event carries
  `payload.agent_run_id`. A new `agent_runs` table (run id, user, project,
  prompt, model, tokens, cost cents, status, started/ended) gives the
  observability ledger. **Rollback is compensation, not deletion**: "undo run X"
  selects the run's events and emits inverse events (re-commit prior chain
  values, `cell.unvalidate`, `comment.delete`). Append-only stays append-only;
  the undo is itself audited.

**Apply gating.** Reads and `docs` are unrestricted. Writes follow the harness
spec's trust ladder: by default the agent's `emit()` calls are **staged** — the
user sees the diff-summary card and clicks Apply (one click, then events POST
with the user's sync token). A per-user "auto-apply for my own drafts" toggle
covers the tight drafting loop. Either way `ai_suggestion: true` +
`agent_run_id` mark provenance, and `ai_drafted` surfaces it to PMs (AQU-292).

**UI.** The existing `ChatPanel` grows an agent mode: run timeline (each
`code_start`/`code_result` as a collapsible step), proposal cards with Apply /
Discard, per-run cost line (from the usage tee), and an Undo-run button in the
project activity view. No new surface; the chat dock is already where users ask
for things.

---

## 6. What we explicitly do not build

- No per-feature tools (`draft_cell`, `add_comment`, `create_assignment` — all
  just events).
- No agent-writable settings in v1 (`project_settings` mutations stay human;
  the agent may *read* them and *propose* via comment).
- No nested agents, no long-lived memory beyond `agent_runs` + the event log
  itself (which **is** the memory: validated pairs, living-memory entries, and
  waivers all accrete from normal use — the moat compounds without an extra
  store).
- No raw DML, ever, including "just this once" migrations.

## 7. Phasing (inherits metering-first ordering)

1. **P0 — Meter** (already ordered first in harness spec): usage tee + `agent_runs` ledger.
2. **P1 — Read-only agent**: `sql` + `docs` + L1 card + RLS role. Ships value
   immediately (project Q&A, progress reports, history archaeology, "what's left
   in Mark?") with zero write risk. This is also the cheapest place to tune
   compression.
3. **P2 — `emit` staged-apply**: drafting, comments, validation via proposal
   cards; lint-on-write; attribution.
4. **P3 — Undo-run + auto-apply toggle + PM rollups** (runs/cost/acceptance per
   project, the Wendi/Randall oversight view).

**Kill/health metrics** (inherited): ≥40% of staged writes applied; cost per
applied write ≤ $0.05; weekly active usage among translators; % of runs that end
in a durable artifact (term, rule, validated pair, comment).

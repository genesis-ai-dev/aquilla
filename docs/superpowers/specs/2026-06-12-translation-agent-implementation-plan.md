# Translation Agent — v1 Implementation Plan & Wire Contract

Companion to `2026-06-12-translation-agent-design.md`. This file is the
authoritative contract between the server slice (auth-worker) and the client
slice (src/). Both slices MUST match these shapes byte-for-byte in their own
type declarations.

## v1 scope (what "works for translators and reviewers" means)

- A translator opens the chat dock, switches to Agent mode, asks "draft the
  untranslated verses in this chapter" → agent reads cells via SQL, drafts,
  stages `target.cell.commit` proposals → translator reviews proposal cards
  (with deterministic lint) → clicks Apply → cells update through the normal
  client write path with `ai_suggestion: true` + `agent_run_id`.
- A reviewer asks "what changed in Mark 4 this week and is anything
  inconsistent?" → agent reads event history + cells, answers with refs, and
  can stage `comment.create` findings; reviewer applies them.
- Read-only questions ("how much of this file is validated?") answer with no
  write machinery involved.
- Role filtering: a REVIEWER never sees `target.cell.*` in the prompt's event
  card; the server also re-validates role on every staged event.

## Deviation from the design doc (Workers constraint)

Workers cannot `eval` model JS. The single tool `execute` therefore takes a
discriminated union instead of a code string. Still one tool, one decision.
quickjs-WASM sandbox is a possible later upgrade; do not build it now.

## The one tool (OpenAI tool-calling schema, served to the model)

```json
{
  "type": "function",
  "function": {
    "name": "execute",
    "description": "Run read-only SQL, stage events, or fetch docs. Exactly one field per call.",
    "parameters": {
      "type": "object",
      "properties": {
        "sql": { "type": "string", "description": "One read-only SELECT (CTEs allowed). Bind vars: :project, :user, :file, :cell. Max 200 rows surfaced." },
        "emit": { "type": "array", "items": { "type": "object" }, "description": "Events to STAGE for user approval. Each: {kind, fileId?, cellId?, parentId?, payload}. Aliases (#c1/#e1/#f1) and :vars accepted." },
        "docs": { "type": "string", "description": "Fetch a cookbook: drafting | checking | terminology | validation | history | assignments | files-and-refs" }
      }
    }
  }
}
```

## SSE frames (server → client), `data:`-prefixed JSON lines

```ts
type AgentFrame =
  | { type: 'run_start'; runId: string }
  | { type: 'assistant_delta'; text: string }
  | { type: 'code_start'; step: number; kind: 'sql' | 'emit' | 'docs'; summary: string } // summary: first 120 chars of sql / "N events" / topic
  | { type: 'code_result'; step: number; ok: boolean; summary: string }                  // compressed result block (what the model saw), truncated to 2000 chars for UI
  | { type: 'proposal'; proposal: AgentProposal }
  | { type: 'usage'; promptTokens: number; completionTokens: number; costCents: number }
  | { type: 'done'; runId: string; status: 'ok' | 'capped' | 'error' }
  | { type: 'error'; message: string }
```

## Staged proposal shape

```ts
interface AgentProposal {
  proposalId: string            // uuid, server-generated
  runId: string
  events: StagedEvent[]         // resolved: real UUIDs, real parentId/sourceEventId
  summary: string               // human line: "Draft 12 cells in MRK 4"
}
interface StagedEvent {
  kind: string                  // e.g. 'target.cell.commit'
  fileId?: string
  cellId?: string
  parentId?: string             // resolved current cells.event_id (server resolves at stage time)
  payload: Record<string, unknown> // server injects ai_suggestion: true and agent_run_id for cell commits
  // display context the client card needs:
  display: { canonicalRef?: string; before?: string; after?: string }
}
```

Client Apply: build real events (client-generated UUIDv7 ids, author = current
user, clientTs = now) from StagedEvent fields and push through the SAME outbox/
POST /events path normal edits use. The client re-runs `checkRulesForCell` on
each after-text and shows violations on the card BEFORE apply.

## Server endpoint

`POST /api/v1/ai/agent/run` on auth-worker. Body:
```ts
{ projectId: string; messages: {role:'user'|'assistant', content:string}[];   // ≤10 turns, client truncates
  context?: { fileId?: string; cellId?: string } }
```
Auth: same JWT middleware as `/api/v1/chat/completions`; resolve project role
from membership (project_members / org grants — reuse existing helpers).
Guards: `runAiGuard()` (allowlist + budgets) before any model call.
Loop: max 8 tool iterations, 60k token ceiling, abort on client disconnect.
Model: haiku-class default from the existing allowlist; OpenRouter via the same
env/key path `chat.ts` uses.

## Server internals (new files, auth-worker/src/lib/agent/)

- `schema-card.ts` — builds the L1 system prompt: identity/stance, schema card
  (hand-written, see design §3), event card FILTERED by the caller's role
  (REQUIRED_ROLE map mirrored from sync-worker/src/events/role-policy.ts — copy
  the table as data, cite source), execute contract, safety lines. Target ≤250
  lines of prompt text.
- `sql-guard.ts` — single-statement SELECT/WITH gate (reject ; chains, any
  DML/DDL keyword as first token of any statement), bind :vars to parameters,
  wrap in `SET TRANSACTION READ ONLY` + `SET LOCAL statement_timeout='4s'`,
  row cap 200 (LIMIT injection if absent → fetch 201 to detect more).
- `compress.ts` — result → pipe table; UUID→alias (#c1…, per-run legend map,
  bidirectional); ∅ for null; repeated-value run grouping note; total counts.
- `emit-stage.ts` — per event: role check (same table as schema-card), payload
  shape sanity, resolve aliases/:vars, resolve parentId + sourceEventId from
  cells via SQL, staleness pre-check, attach display context (canonical_ref,
  before/after), inject ai_suggestion/agent_run_id. Returns proposal + a
  compressed verdict block for the model.
- `docs.ts` — cookbook string constants (drafting, checking, terminology,
  validation, history, assignments, files-and-refs). Each ≤200 lines, prose +
  SQL recipes against the real schema.
- `runs.ts` — agent_runs ledger: insert on start, update tokens/cost/status on
  done. Table added to db/postgres/schema.sql AND
  db/postgres/migrations/ (follow whatever migration convention exists; if
  none, schema.sql + idempotent CREATE TABLE IF NOT EXISTS applied by
  scripts/pg.ts).

```sql
CREATE TABLE IF NOT EXISTS agent_runs (
    run_id      TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL,
    user_id     BIGINT NOT NULL,
    username    TEXT NOT NULL,
    prompt      TEXT NOT NULL,
    model       TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'running', -- running|ok|capped|error
    prompt_tokens     BIGINT NOT NULL DEFAULT 0,
    completion_tokens BIGINT NOT NULL DEFAULT 0,
    cost_cents  DOUBLE PRECISION NOT NULL DEFAULT 0,
    steps       INTEGER NOT NULL DEFAULT 0,
    started_at  BIGINT NOT NULL,
    ended_at    BIGINT
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_project ON agent_runs (project_id, started_at DESC);
```

RLS note: v1 enforces project scoping in sql-guard (app-level: every query runs
with `SET LOCAL app.project_id` and the guard verifies the query references
:project; plus the read connection is the same AQUILLA_PG the worker already
trusts). Real `agent_ro` Postgres role + RLS policies: written as a follow-up
migration file but NOT required for v1 sign-off; do not block on Neon role
provisioning.

## Client internals (new/changed files, src/)

- `src/lib/agent/protocol.ts` — the types above, verbatim.
- `src/lib/agent/agent-client.ts` — SSE POST + frame parser (reuse fetch/SSE
  patterns from completion streaming).
- `src/components/agent/AgentRunView.tsx` — timeline of steps (collapsible
  code_start/code_result), assistant text, usage line.
- `src/components/agent/ProposalCard.tsx` — summary, per-event before/after
  rows with canonicalRef, client-side `checkRulesForCell` lint badges, Apply /
  Discard. Apply pushes events through the existing write path used by cell
  editing (find it via useCells commit flow) and marks the card applied.
- ChatPanel/ChatDockPanel: add Agent mode toggle (segmented control, Base UI
  per repo conventions); agent mode renders AgentRunView; keep chat mode
  untouched.
- Role gating in UI: Apply button disabled (with reason) when the user's role
  is below the event kind's floor — mirror the same role table in
  `src/lib/agent/role-floors.ts`.

## Testing bar for v1 sign-off

- Unit (vitest): sql-guard (accepts CTE SELECT; rejects UPDATE/INSERT/multi-
  statement/pg_sleep; row cap), compress (alias stability, ∅, counts),
  emit-stage (role rejection, stale parent detection), schema-card (REVIEWER
  card lacks target.cell.*).
- Worker integration: agent route streams frames end-to-end with a MOCKED
  OpenRouter (inject fetch) — model asks sql → gets compressed block → emits →
  proposal frame arrives → done.
- Client unit: ProposalCard renders before/after + lint; Apply calls write path.
- E2E smoke (mock model like existing ai completion specs): agent answers a
  read question; agent stages a draft; Apply updates the cell in the editor.

## Conventions

- Match repo style; Base UI primitives (see recent refactor commit 12af5560a).
- No new deps without strong reason.
- Sequential edits per file (formatter hook reverts parallel same-file edits).
- Commit in logical chunks on feat/translation-agent.

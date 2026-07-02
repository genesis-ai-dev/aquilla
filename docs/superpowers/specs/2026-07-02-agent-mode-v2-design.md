# Agent Mode v2 — a translation workbench, not a chat widget

Status: IMPLEMENTED on branch `agent-v2` (all five phases, 2026-07-02) —
supersedes the UX + tool surface of 2026-06-12-translation-agent-design.md;
the staged-proposal safety model, role filtering, emit-stage lint, and credit
rails all carry forward unchanged. Implementation notes vs. this design:
`propose` kept the `emit` frame kind on the wire; the legacy `execute` tool
remains as a back-compat shim (scripted mocks, stored v1 sessions); the dev
stack and e2e harness auto-boot scripts/mock-openrouter.ts when no real
OPENROUTER_API_KEY is configured.

## 0. Why v1 underperforms — audit of what exists

What ships today (`auth-worker/src/routes/agent.ts`, `src/lib/agent/*`,
`src/components/agent/*`):

| Layer | v1 reality | Consequence |
|---|---|---|
| Tools | ONE `execute` tool: raw `sql` \| `emit` \| `docs` \| `aquifer` | The model must *write Postgres* to do anything — find work, fetch exemplars, search. Recipes live in prose (schema card + cookbooks) the model must fetch and imitate. A simple "draft this chapter" costs: docs → sql (work list) → sql (exemplars) → emit → lint verdict → re-emit. SQL typos burn iterations. |
| Loop | Non-streaming rounds (`stream: false`), one `assistant_delta` per round, Haiku default, `reasoning: none`, 12-iteration / 60k-token caps | Text appears in blobs, not tokens. Caps make book-scale jobs impossible by construction. |
| Conversation | Client resends ≤10 `user`/`assistant` text turns; **tool results are dropped between runs** | Every follow-up ("now the next 10") re-discovers the file layout, work list, and exemplars from scratch. This — not the model — is most of the "calls tools so many times" pain. |
| UI state | `run-state.ts` folds all text into one `assistantText` string and all steps into a separate `steps[]` | **Arrival order is thrown away.** The wire frames ARE interleaved (code_start/result arrive between assistant_deltas); the reducer discards that, so the UI stacks all tool chips above one text blob. |
| Surface | Dock tab only (`LeftDock`, max width 520px) | No room for source/draft context, proposal review is cramped cards, no full-screen mode. |
| Control | One in-flight run, composer locked while streaming, abort = only control | Can't queue a follow-up, can't steer, no progress for bulk jobs. |

None of this is model-fault. The contract makes the model inefficient and the
UI hides what it does do well.

## 1. Product shape — "Claude Code for translators"

One agent, two mounts, one session:

- **Dock mode** (exists) — quick asks alongside the editor.
- **Workbench mode** (new) — full-screen route `/project/:id/agent`. The dock
  header gets an expand button; both mounts render the SAME session state, so
  expanding mid-run loses nothing.

The workbench is a two-region layout:

```
┌────────────────────────────────────────────────────────────────┐
│ ⟨MRK⟩ Drafting Mark 4 · 12/32 cells · ⏸ stop     [session ▾]   │  ← job header (only during bulk work)
├──────────────────────────┬─────────────────────────────────────┤
│ Conversation timeline    │ Working set                         │
│                          │ ┌──ref──┬─source────┬─draft───────┐ │
│ ▸ user bubble            │ │MRK 4:1│ Καὶ πάλιν │ Y comenzó…  │ │
│ ▸ streamed prose…        │ │MRK 4:2│ καὶ ἐδίδ… │ ⋯ drafting  │ │
│ ▸ ⚒ read MRK 4 (32)      │ │  …    │           │             │ │
│ ▸ streamed prose…        │ └───────┴───────────┴─────────────┘ │
│ ▸ ⚒ examples ×6          │ Diff view for edits (before/after)  │
│ ▸ proposal · 12 cells    │ per-row ✓ accept / ✗ reject         │
│   [Accept all] [Review]  │                                     │
├──────────────────────────┴─────────────────────────────────────┤
│ /draft  @MRK 4:1  composer………………………………………………  [send / queue]   │
└────────────────────────────────────────────────────────────────┘
```

- **Timeline (left)** — the chat. Tool calls render *inline where they
  happened* as one-line collapsed chips ("read MRK 4:1–20 · 32 cells", "6
  examples"), expandable; prose streams between them. Standard agentic-CLI
  transcript semantics.
- **Working set (right)** — the cells the agent is currently touching, as
  aligned source/target rows. Populated by tool *results* (a `read` fills
  rows; a proposal turns rows into diffs with per-row accept/reject). This is
  the "see the source and the drafts" ask — the user watches the agent work
  against real text, not JSON summaries.
- On narrow/dock mode the working set collapses into the existing proposal
  cards; the timeline interleaving fix applies to both mounts.

## 2. Protocol v2 — ordered timeline + real streaming

### 2.1 Client state (Phase 1, no server change required)

Replace `AgentRunUi.assistantText + steps[]` with an **ordered timeline**:

```ts
type TimelineItem =
  | { id: string; kind: "text"; text: string }              // grows via deltas
  | { id: string; kind: "tool"; tool: ToolKind; label: string;
      ok?: boolean; resultSummary?: string; data?: ToolResultData }
  | { id: string; kind: "proposal"; proposal: AgentProposal }
  | { id: string; kind: "aquifer"; proposal: AquiferPublishProposal }

interface AgentRunUi { …; items: TimelineItem[]; … }
```

Reducer rule: `assistant_delta` appends to the trailing text item (or opens a
new one if the last item is a tool); `code_start` closes the current text item
and appends a tool item; `proposal` appends in place. **The wire already
delivers frames in true order — this is purely a reducer+render fix** and
immediately solves "all tool calls get stacked together".

### 2.2 Wire frames (Phase 2)

- Server switches upstream to `stream: true` and forwards token deltas —
  `assistant_delta` becomes real streaming (frame shape unchanged).
- `code_result` gains an optional typed payload for UI rendering:
  `data?: { cells?: PassageRow[]; examples?: ExamplePair[]; hits?: SearchHit[] }`
  — the model keeps getting compact text; the working-set panel gets structure.
- New `progress` frame for bulk jobs: `{ type:"progress"; label; done; total }`.
- New `plan` frame (optional, later): agent-posted checklist for long jobs.

### 2.3 Sessions — stop re-discovering the project every turn

New table `agent_sessions (id, project_id, user_id, title, convo JSONB,
updated_at)`. The client sends `{ sessionId, userText, context }`; the server
appends to the **stored conversation including tool messages** and runs from
there. Effects:

- Follow-ups reuse prior tool results — the single biggest efficiency win.
- Dock ↔ workbench continuity and reload-survival come free.
- The ≤10-turn client truncation dies; the server compacts old tool results
  (keep the model-visible digest, drop bulk) when the convo grows.
- `agent_runs` rows now carry `session_id` for observability.

## 3. Tools v2 — few, semantic, excellent

Principle: **move the cookbooks from prose into code.** Each recipe the schema
card teaches the model to derive via SQL becomes one purpose-built tool whose
implementation is the recipe. Proper multi-tool schema (the OpenAI tool array
already supports it) instead of one mega-`execute`.

| Tool | Replaces | Contract |
|---|---|---|
| `read` | work-list + passage SQL | `{fileId? , ref?: "MRK 4" \| "MRK 4:1-20", filter?: "untranslated"\|"stale"\|"flagged"\|"all", limit}` → aligned rows `{cellId, ref, source, target, status, validated}` in display order (encodes the canonical_ref / sequence_index / anchor-chain ordering logic server-side, correctly, every time). |
| `examples` | exemplar SQL + cookbook §2 | `{text?: string, cellIds?: string[], n}` → few-shot pairs: validated pairs first, then FTS-similarity retrieval over `value_tsv` — i.e. the copilot's existing retrieval (`draft-context.ts`, validated-pairs-lead ordering from `completion-service.ts`) exposed as one call. |
| `search` | ad-hoc FTS SQL | `{q, side?: "source"\|"target"\|"comments"\|"terms", fileId?, limit}` → hits with refs. |
| `draft` | the model hand-writing translations inline | `{cellIds \| ref, instructions?}` — server runs the **existing tuned drafting pipeline** (per-cell preceding-target context, exemplars, termbase, brief) with the project's drafting model, lints via emit-stage, and returns a staged proposal + per-cell verdicts. The agent orchestrates; the proven pipeline translates. Orchestrator can stay Haiku-cheap while draft quality comes from the pipeline's model. One iteration = one chapter. |
| `propose` | `emit` | unchanged semantics (stage events, lint verdict, role floors). `draft` covers the 80% case; `propose` covers validation, comments, assignments, renames, back-translations. |
| `resources` | `aquifer` | unchanged (search/read/publish, project-gated). |
| `sql` | — | kept as explicit escape hatch, demoted in the prompt ("only when no tool fits"). Guarded exactly as today. |

Prompt effect: the schema card shrinks to a paragraph; `docs` cookbooks for
drafting/checking mostly delete (history/assignments recipes can stay behind
`sql`). Iteration caps rise or become per-tool budgets since each call now does
a full recipe — target: "draft MRK 4" ≤ 4 tool calls (read → examples →
draft → done), vs ~8–12 today.

## 4. Control — steering, queueing, jobs

- **Queue while running**: composer stays enabled during a run; sends enqueue
  and inject as the next `user` turn at the next loop boundary (session-native,
  so this is just an append). No more one-abort-fits-all.
- **Stop vs pause**: stop aborts the loop but keeps staged proposals; a bulk
  `draft` job checkpoints per chapter so "continue" resumes cleanly.
- **Suggested slash-commands** in the composer: `/draft <ref>`, `/check <ref>`,
  `/find <term>`, `/summarize` — each expands to a vetted prompt (the existing
  `SuggestedAction` machinery generalized). `@`-mention inserts the existing
  context chips (files, refs, selections).
- **Proposal review, keyboard-first**: in the working set, `j/k` move,
  `a` accept row, `x` reject row, `⇧A` accept all; accepted rows apply through
  the normal outbox path (`apply.ts` unchanged) and flash in the editor.

## 5. Phasing

**Phase 1 — interleaved timeline (client-only, small).**
`run-state.ts` → ordered `items[]`; `AgentRunView` renders items in order with
collapsed tool chips. Kills the worst UI complaint with zero wire change.
Tests: reducer ordering, chip expand, existing fixtures migrated.

**Phase 2 — streaming + sessions (server).**
`stream: true` passthrough; `agent_sessions` table + `sessionId` request field;
server-side convo persistence and compaction; drop client truncation.

**Phase 3 — semantic tools.**
Implement `read` / `examples` / `search` / `draft` in
`auth-worker/src/lib/agent/tools/` (each pure + unit-tested like sql-guard);
multi-tool schema; rewrite system prompt around them; demote `sql`; shrink
cookbooks. Battery-test the drafting flow end-to-end against the mock
OpenRouter script.

**Phase 4 — workbench UI.**
Route `/project/:id/agent`, two-region layout, working-set panel fed by typed
`code_result.data`, per-row proposal review, job header with progress/stop,
dock expand button sharing session state.

**Phase 5 — control polish.**
Message queueing/steering, slash commands, plan/progress frames, chapter
checkpointing for book-scale jobs.

Each phase ships independently; 1 and 2 are prerequisites for nothing but
improve v1 immediately.

## 6. Non-goals / carried forward unchanged

- Staged-proposal safety (nothing writes without user Apply) — unchanged.
- Role floors, emit-stage lint, credit guard, ai-budget guard — unchanged.
- No client-side agent loop: the loop stays in auth-worker (keys, guards,
  ledger all live there).
- No CRDT/live-multiplayer agent editing; proposals still apply via the
  normal outbox/event path.

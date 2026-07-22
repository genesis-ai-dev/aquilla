# Agent sandbox — architecture (AQU-AGENT)

Status: **in progress** (AQU-AGENT swarm, started 2026-07-21) · authoritative contracts:
[`docs/swarm/AQU-AGENT-CONTRACTS.md`](swarm/AQU-AGENT-CONTRACTS.md) (read-only for builders;
this doc narrates the same shapes in prose and links back rather than duplicating the normative
TypeScript/SQL). Orchestration log / STOP criteria:
[`docs/swarm/AQU-AGENT-ORCHESTRATION.md`](swarm/AQU-AGENT-ORCHESTRATION.md).

This document describes **the new stack** — sandboxed code execution, artifact loading, staged
imports, and living memory — layered on top of the **existing** agent harness
(`auth-worker/src/routes/agent.ts`, `src/lib/agent/`, `AgentWorkbench`) and the **existing**
Agent API changeset/command layer (`docs/AGENT-API.md`). It does not replace either. If you're
looking for credentials, commands, or the ask/act changeset model, read `docs/AGENT-API.md`
first — this doc assumes it.

## Why: what the sandbox adds

The existing harness can read project state, draft translations, and stage changesets, but it
cannot **run code**. A real translation org's uploads are messy in ways no fixed set of parsers
anticipates (see `e2e/fixtures/agent/README.md` for concrete examples: merged header rows,
delimiter drift, swapped source/target columns, mixed scripts, inconsistent transcript
formatting). The sandbox gives the agent a **Project-Think-style ladder**:

- **Tier 0** — built-in parsers (`src/lib/parsers/*`) handle known formats deterministically.
  No sandbox involved.
- **Tier 1** — the agent writes small JS to inspect/reshape data it can't fully trust to a fixed
  parser (e.g. "does this CSV's row 1 look like a real header, or a merged title cell?").
- **Tier 2** — the agent writes Python (pandas/openpyxl/lxml/chardet/beautifulsoup4) for shapes
  Tier 1 can't handle cleanly — spreadsheets, encoding-ambiguous text, HTML-ish exports.

v1 runs both Tier 1 and Tier 2 inside the **same sandbox container**, not as separate dynamic
worker isolates — true Code-Mode-style dynamic isolates for Tier 1 are traced as future work
(see `docs/swarm/AQU-AGENT-TRACES.md` `tier1-isolates`).

## Components

```
SPA (AgentWorkbench, AgentDockView)
  │  SSE (existing transport)
  ▼
auth-worker  ── agent.ts (harness loop, OpenRouter)
  │  new tools: run_code, load_artifact, read_sandbox_file, plan_import,
  │             propose_memory, propose_brief_update, read_memory
  │
  ├──HTTP (Bearer AGENT_SANDBOX_KEY)──▶  agent-worker (NEW, aquilla-agent-sandbox)
  │                                       Cloudflare Sandbox container per session
  │                                       exec / files / fetch-artifact / destroy
  │
  ├──HTTP (ephemeral aqk_ ask-mode credential)──▶  sync-worker external command layer
  │                                                  (PlanImport → staged changeset)
  │
  └──Postgres (Neon)──▶  agent_memories, project_briefs, project_brief_proposals
```

- **Harness** (`auth-worker/src/routes/agent.ts` + `auth-worker/src/lib/agent/*`) — unchanged
  transport and run loop; extended with the new tools above.
- **agent-worker** (new) — sandbox-execution-only. No model keys, no LLM loop, no business
  logic. One Cloudflare Sandbox container per agent session (`sessionId`), destroyed at run end
  (or idempotently on retry). See contracts §1 for the exact HTTP surface.
- **Writes** — never raw events. The harness's `plan_import` tool mints an ephemeral,
  project-scoped, **ask-mode** internal credential (`aqk_…`, `mode='ask'`, 2h expiry, named
  `agent-run:<runId>`) via `db/shared/api-credentials.ts`, then calls the **existing**
  `POST /api/v1/external/projects/:projectId/changesets` endpoint with a `PlanImport` command.
  This is the same code path a human-authored API integration would use — the agent inherits
  provenance, preconditions, and the approval UX for free. See `docs/AGENT-API.md` §3 for the
  changeset/confirmation model this reuses verbatim.
- **Memory / brief** (new Postgres tables + auth-worker routes + SPA review UI) — see "Memory
  gating" below.

## Security model

- **No secrets in the container.** The sandbox never receives an OpenRouter key, a sync
  credential, or any project secret in its environment. It receives only: code to execute,
  files explicitly pushed to it (`POST /sessions/:id/files`, `fetch-artifact`), and returns
  stdout/stderr/a result value. The harness — outside the container — is the only thing that
  ever holds the ephemeral `aqk_` credential, and it is never passed into the sandbox.
- **Default-deny egress.** The sandbox container has no arbitrary network access. It cannot
  exfiltrate data to an external host, cannot fetch a credentialed third-party URL on the
  user's behalf (contrast with the client-side agent pattern in `docs/AGENT-API.md` §5's
  "External-asset wrinkle" — that's a *different*, browser-context agent; the sandbox is
  deliberately more restricted), and cannot phone home anywhere except through the harness's
  own tool calls.
- **Path safety.** All container paths are constrained under `/workspace`; `..`/absolute paths
  outside it are rejected at the agent-worker HTTP boundary (contracts §1).
- **Auth.** Every sandbox route requires `Authorization: Bearer ${AGENT_SANDBOX_KEY}` (a shared
  secret between auth-worker and agent-worker, never exposed to the browser or the model).
- **Untrusted-content memory lockout.** While a run is parsing bytes it loaded from an artifact
  (`load_artifact`) or has executed sandbox code that touched artifact bytes in the current
  model turn, `propose_memory`/`propose_brief_update` are **read-only**: calls return
  `validation_failed` with the message "memory writes disabled while processing untrusted
  content." This closes the most direct prompt-injection path — a malicious cell value or
  uploaded file cannot get itself written into the project's persistent living memory in the
  same turn it was read. The lock resets only after a subsequent model turn that touches no
  untrusted-content tool. This is a **turn-scoped** flag, not a whole-session lock: the agent
  can still propose memory later in the same run, once it's reasoning from its own summary
  rather than directly from raw untrusted bytes.
- **Human-edit protection** (memory, not sandbox, but part of the same trust boundary): once a
  human edits a memory row (`PATCH .../agent-memory/:id`, setting `human_edited=true`), the
  **agent channel** (requests carrying `x-aquilla-agent-run: <runId>`) can never overwrite that
  row again — a subsequent agent-originated PATCH gets `403 human_edit_protected`. The agent
  may propose a *new* memory or ask about the discrepancy in conversation, but it cannot
  silently clobber a human's correction. See contracts §3 for the full route/permission table.
- **No act-mode from the agent's own writes.** `plan_import`'s changeset-bridge credential is
  hardcoded `mode='ask'` — it is structurally incapable of auto-confirming its own changeset,
  regardless of the calling user's own credential ceiling. A human always approves at
  `/approve/:changesetId` before an agent-driven import lands (see `docs/AGENT-API.md` §2's
  "autonomy modes" for what ask vs. act means at the credential layer generally — this is a
  narrower, harness-internal application of the same idea).

## Memory gating (autonomy)

Every project has an `agentMemoryAutonomy` setting, default `'human'`:

- **`'human'`** (default) — every memory proposal and every brief proposal requires a human
  review action (`POST .../agent-memory/:id/review`, PROJECT_LEAD+). The agent can never
  self-approve anything it wrote.
- **`'agent-low-risk'`** — the agent channel MAY self-approve, but only for proposals whose
  `path` starts with `observations/` (a namespace reserved for low-stakes, easily-revised notes
  — e.g. "this org's exports occasionally swap source/target columns"). Anything outside that
  path prefix — glossary decisions, style rules, anything under the brief — still requires a
  human, unconditionally.
- **The project brief is always human-approval-only**, in both autonomy modes. `PUT
  /api/v2/projects/:projectId/brief` returns `403 brief_human_only` on the agent channel no
  matter the setting; `POST /brief/proposals/:id/review` is never reachable from the agent
  channel either. This is a deliberate asymmetry from memory: the brief is the project's
  highest-oversight artifact (glossary/style/audience — the project's "CLAUDE.md," see
  `docs/AGENT-API.md`'s Claude Code analogy table), so it does not get the low-risk carve-out
  memory has.

## Cost caps

The harness accumulates OpenRouter's reported `usage.cost` across a run. When the running total
would exceed `AGENT_RUN_COST_CAP_CENTS` (env, default 500 = $5.00), the run halts gracefully:
it emits a `budget.exhausted` SSE frame and stops issuing further model calls, rather than
erroring mid-tool-call or silently truncating output. The SPA renders a running `budget` frame
(spent/cap) so a human watching the session sees the meter before it trips, not just after.

## Frontend surfaces

- **Run timeline** (`AgentDockView` / `AgentRunView`) gains new frame renderers: a code-activity
  block (stdout/stderr, collapsed by default, `codePreview` shown inline), a staged-changeset
  card linking to `approvalUrl`, and a memory-proposal toast/card.
- **`AgentWorkbench`** gains a `sessions | memory` tab slot; the memory tab lazy-imports
  `AgentMemoryTab` (proposed-memory review, approved-memory list with human-edit affordance and
  provenance display) and a `BriefEditor` (view/edit with optimistic-concurrency `ifMatchVersion`,
  proposal review).
- Approval itself reuses the **existing** `/approve/:changesetId` page
  (`src/pages/ApproveChangeset/ApproveChangeset.tsx`) unchanged — the agent's staged imports are
  not a special case there, by design (contracts §0: "we inherit provenance, preconditions,
  approval UX, and permission parity for free").

## Testing

- `e2e/specs/agent-import.spec.ts` — end-to-end golden-path skeleton (skipped until the sandbox
  stack exists in CI; see the spec's header comment and
  [`e2e/JOURNEYS.md`](../e2e/JOURNEYS.md)).
- `e2e/fixtures/agent/` — three deliberately messy fixtures (mixed-delimiter/BOM/swapped-column
  CSV, a hand-built legacy-shaped XLSX + CSV twin, a bilingual timestamped interview transcript)
  with a README documenting each trap and the expected agent behavior.
- Worker-side: PGlite for the new Postgres tables/routes (`db/shared/agent-memory.ts`,
  `auth-worker/src/routes/agent-memory.ts`); agent-worker gets its own package test suite
  (sandbox exec/files/fetch-artifact against a real or mocked Sandbox binding).

## Known gaps (traced, not built in v1)

See [`docs/swarm/AQU-AGENT-TRACES.md`](swarm/AQU-AGENT-TRACES.md) for the live list. Notable
ones from this doc's perspective:

- True dynamic-worker isolates for Tier 1 (v1 runs Tier 1 JS in the same sandbox container as
  Tier 2 Python).
- agent-worker's zone route claim and first `wrangler deploy` (CI's Cloudflare token can't
  mutate zone routes — this is a human/local task, same constraint as `sync-worker`/`auth-worker`
  per `CLAUDE.md`).
- `e2e/specs/agent-import.spec.ts` is a structural skeleton, not a passing test, until the
  sandbox stack (agent-worker, harness tools, memory routes, and the new frame renderers) all
  exist — see the spec header and the row in `e2e/JOURNEYS.md`.

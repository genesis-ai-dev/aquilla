# AQU-AGENT swarm — Aquilla Agent (harness + sandbox + living memory + chat UI)

Started 2026-07-21 ~00:45 · Orchestrator: Claude (Fable), Ryder AFK until morning ("make decisions as best you can").
Integration: `swarm/integration` @ `.worktrees/swarm-integration` · Base: dev @ 05530248e
Mode: cron/AFK (background Agent waves; orchestrator merges/verifies/promotes).

## Vision (Ryder, verbatim intent)

Build the cloud agent that makes Aquilla the #1 agentic TMS. Locked decisions:
- **Cloudflare Containers** (Sandbox SDK) for code execution; **Project-Think-style ladder**
  (Tier 0 built-in parsers → Tier 1 agent JS in sandbox → Tier 2 Python/pandas in sandbox).
- **OpenRouter + our own harness** (loop in a per-session Durable Object; model routing
  sonnet-class default / opus-class hard turns; per-session cost cap).
- **Living memory**: agent-captured memories are *proposals* reviewed by human OR agent
  (project setting); **project brief updates are high-oversight (human approval only)**;
  **human edits persist — agent may never overwrite human-edited content, only ask about it**.
- English scaffolding/memory/tools; chat replies in project language; memory read-only
  while parsing untrusted uploads.

## CRITICAL PRIOR ART — build ON this, don't reinvent

A previous swarm shipped the **Agent API** (AQU-533 + v1.1, deployed to staging):
- `sync-worker/src/external/` — command→changeset engine (prepare→commit, preconditions,
  plan_stale, idempotent prepare-minted ids), commands incl. SetTranslation + PlanImport
  (+ CreateProject/UpdateProjectSettings/LinkMedia), MCP adapter (mcp-tools.ts),
  artifacts on R2, stable error codes, execution receipts + provenance envelope.
- `db/shared/api-credentials.ts` — `aqk_` bearer credentials, ask|act modes, org/project
  scoping; approval-assertion flow (auth-worker endpoints + SPA `/approve/:changesetId`).
- **STORAGE IS POSTGRES** (Neon via Hyperdrive) — migrations `db/postgres/migrations/`
  (0065 used by v1.1; VERIFY latest before numbering). CLAUDE.md "workers on D1" is STALE.
- Specs: `docs/AGENT-API.md`, `docs/api/agent-api.md`, openapi.yaml,
  `docs/superpowers/specs/2026-07-17-agent-api-v1.1-design.md`.

**Architectural consequence:** the harness's write path = the existing command/changeset
layer (internal credential minted for the session, ask-mode by default) → we inherit
provenance, preconditions, approval UX, and permission parity FOR FREE. The agent's
"propose import" tool = PlanImport. Do NOT write raw events from the agent.

## STOP criteria

- [ ] Root `tsc -b --noEmit` clean; root `vitest run` green (modulo pre-existing failures
      attributed against clean base); `pnpm build` green
- [ ] agent-worker tests green; sync-worker + auth-worker `npm test` still green
- [ ] Golden path in real UI (preview): project → Agent tab → session on a messy uploaded
      file → streamed plan/tool activity → import proposal via PlanImport changeset →
      approval works → memory proposal → review/approve → human-edit protection enforced
- [ ] Cost cap enforced (session halts gracefully at budget)
- [ ] No model keys reachable from sandbox code paths
- [ ] Adversarial panel (races / regressions / contracts+authz / prompt-injection lens)
      passed; blockers fixed or reverted
- [ ] Promoted to local main; pushed to dev ONLY after orchestrator's own full green gate

OUT of v1 (traced, not built): Monday/MCP org integrations, true dynamic-worker Tier 1,
scheduled runs, voice, per-org tool registry, agent-worker deploy/zone routes (Ryder task).

## Waves & ownership

Wave 0 DONE: recon revealed existing agent stack (auth-worker SSE runner + `src/lib/agent/` +
AgentWorkbench + `/project/:id/agent` route) and Agent API changeset layer. REVISED PLAN:
extend the existing harness; new worker is sandbox-execution-only. Contracts:
`docs/swarm/AQU-AGENT-CONTRACTS.md` (READ-ONLY for builders).

| Agent | Model | Branch | Owns (exclusive) | Forbidden |
|---|---|---|---|---|
| W1A sandbox-worker | opus | swarm/agent-w1a | agent-worker/** (new: Sandbox container service per contracts §1,§6), scripts/dev-stack.ts (:8790 wiring) | auth-worker/**, sync-worker/**, src/**, db/** |
| W1B harness-tools | opus | swarm/agent-w1b | auth-worker/src/routes/agent.ts, auth-worker/src/lib/agent/** NEW tool files (run_code, load_artifact, read_sandbox_file, plan_import, memory tools), changeset-bridge.ts, frames.ts, budget guard, prompt assembly; auth-worker wrangler env vars | auth-worker/src/index.ts, db/**, sync-worker/**, src/**, agent-worker/** |
| W1C memory-backend | opus | swarm/agent-w1c | db/postgres/migrations/0066_agent_memory.sql, db/postgres/schema.sql (additive), db/shared/agent-memory.ts, auth-worker/src/routes/agent-memory.ts (+ registration in auth-worker/src/index.ts), tests | agent.ts, sync-worker/**, src/**, agent-worker/** |
| W1D spa-chat | sonnet | swarm/agent-w1d | src/lib/agent/{protocol,agent-client,run-state}.ts extensions, src/components/agent/** EXCEPT memory/, tab slot importing memory/AgentMemoryTab | src/components/agent/memory/**, memory-api.ts, App.tsx, workers |
| W1E spa-memory | sonnet | swarm/agent-w1e | src/components/agent/memory/**, src/lib/agent/memory-api.ts, tests | AgentWorkbench.tsx, protocol.ts, App.tsx, workers |
| W1F fixtures+e2e+docs | sonnet | swarm/agent-w1f | e2e/specs/agent-*.spec.ts (skeleton, tagged skip-if-no-sandbox), e2e fixtures (messy CSV/XLSX/mixed files), docs/AGENT-SANDBOX.md, docs/AGENT-API.md status addendum, e2e/JOURNEYS.md entry | all product code |

Wave 2: integrator (opus; wires seams, runs local stack) + UI verifier (drives preview
browser through golden path) + fixers. Wave 3: adversarial panel → fixes → final gate →
promote → dev push.

## Merge log

| when | branch | result | notes |
|---|---|---|---|
| 2026-07-21 | (setup) | worktree created @ 05530248e | |

## Lessons inherited from prior swarms (BINDING)

- EVERY git command prefixed with explicit `cd <worktree>` — never trust persistent cwd
  (AGENT-API incident: accidental merge ran on dev in main worktree).
- Root vitest excludes workers; worker tests via `cd <worker> && npm test`.
- New auth-worker migrations: check for untracked 0035 in MAIN tree; use next free number.
- Attribute root-suite failures against clean base before blaming a merge.
- Safari drops *.workers.dev → agent-worker must eventually mount under aquilla.app/api/agent/*;
  keep `routes` out of CI wrangler.toml top level.
- React Compiler drops version-only memo deps in SPA stores — use readAtVersion().

## Orchestrator decision log

- 2026-07-21: Plain DO (ProjectSync conventions) over `agents` SDK — convention-match wins.
- 2026-07-21: Agent writes flow through existing external command layer (see PRIOR ART),
  session gets an internal ask-mode credential; memory tables in Postgres migrations.
- 2026-07-21: Session event log in DO storage; sessions/memories/briefs in Postgres.

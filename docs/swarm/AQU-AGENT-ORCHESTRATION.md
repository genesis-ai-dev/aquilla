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
| 01:00 | swarm/agent-w1e | merged 83dfc77d0 | memory UI; 28 tests; flagged missing GET /brief/proposals (relayed to W1C) |
| 01:01 | swarm/agent-w1d | merged 9e06e1633 | frames+components; add/add on AgentMemoryTab resolved to W1E's real file; TRACES unioned |
| 01:01 | (fixup) | f671c480e | roleLevel threaded W1D→W1E seam (agent.roleLevel available in workbench prop bundle) |
| 01:02 | swarm/agent-w1f | merged f191c07eb | fixtures/e2e/docs; TRACES unioned; SPA gate green (tsc + tsc.e2e + agent suites 128) |

| 01:04 | INCIDENT | recovered | W1C merge ran in MAIN worktree → landed on local dev (cwd reset between turns; missing explicit cd). dev hard-reset to 05530248e, clean tree verified, nothing pushed. Rule re-affirmed: EVERY git command gets an explicit cd. |
| 01:06 | swarm/agent-w1c | merged e36a15eb7 | memory backend; auth-worker 718/718 + tsc clean on integration |
| 01:08 | (fixup) | agent-PATCH guard | ALL agent-channel PATCHes now 403 (agent_edit_forbidden) — an agent PATCH would set human_edited=true, laundering agent output into protected state. +1 test (16 in file). |
| 01:09 | swarm/agent-w1a | merged fb49be732 | sandbox worker; 26/26 tests + tsc clean on integration; wrangler4/types5 standalone (traced) |
| 01:14 | swarm/agent-w1b | merged 4f9f6bab5 | harness tools; stub→real agent-memory swap; auth-worker 745/745 + tsc clean. WAVE 1 COMPLETE. |

Wave-2 must-do (from W1F): add `data-frame-type` on run-timeline rows and `data-memory-path`
on memory rows in W1D/W1E components; reconcile e2e/pages/agent-page.ts location vs
e2e/helpers/page-objects convention; wire composer attach-file affordance (W1F guessed it).

## Adversarial panel results (01:5x)

Four lenses, no BLOCKERs-by-severity, but memory-lens B1 (+latent B2) is a trust-model
blocker by intent. Fix batch (Wave 3 fixers FIX-A backend / FIX-B SPA):
- B1/B2 reviewMemory human_edited supersede guard + route conflict + UI warning
- authz-M1 membership check in agent-channel review branch
- authz-M2 + races-F2: read_sandbox_file marks untrusted; untrusted bit persisted per session
- races-F1 commit consume/flip reorder (burn-without-apply)
- races-F3 budget re-check inside tool_calls loop
- races-F4 per-run sandbox ids (DECISION: drop cross-run container reuse in v1)
- races-F5 functional revert in AgentMemoryTab
- mem-M2/M3 brief base_version + history table (0067) + diff UI
- mem-M4 humanEdited exposed to model + ask-don't-repropose prompt line
- mem-M5 staged-card status polling; mem-m1 index cap; mem-m2 badge refetch; authz-m1 timing-safe compare
- DECISION: agentMemoryAutonomy stays backend-enforced but UN-SURFACED in v1 (no settings UI; default 'human'); traced for v2.
Cleared: regressions lens fully; double-apply/gate-bypass; SSE pairing; tenancy on artifacts/bridge/sandbox.
| 02:0x | FIX-B + FIX-A | merged | panel batch: all 10 fixes proof-tested; envelopes matched |
| 02:1x | FINAL GATE | GREEN | root tsc/e2e-tsc ✅ · root vitest 4674/4677 (3 pre-existing, base-reproduced) · build+brand ✅ · auth 763/763 · sync 1000/1000 · agent-worker 27/27 · e2e smoke 100/102 (2 fails reproduced on clean base — environmental, not batch) |
| 02:1x | PROMOTED | dev ← integration (ff) | NOT pushed — deliberate hold, see MORNING CHECKLIST |

## MORNING CHECKLIST (Ryder)

1. Read docs/swarm/AQU-AGENT-QA.md (+ screenshots in docs/swarm/aqu-agent-qa/) and the
   panel section above. Feature is fully built + verified locally; local dev == integration tip.
2. BEFORE `git push origin dev`: apply migrations 0066/0067/0068 to the STAGING Postgres
   (npx tsx scripts/pg.ts db/postgres/migrations/0066_agent_memory.sql etc. with staging conn).
   I held the push because the new auth-worker memory routes 500 without these tables, and I
   couldn't safely confirm the staging Neon target from here at 2am. Two commands, then push.
3. First agent-worker deploy (whenever ready): docker image — ROOT CAUSE FOUND: the pull
   fails because `cloudflare/sandbox:0.7.0-python` ships NO linux/arm64 manifest (Apple Silicon).
   Fix: `docker pull --platform linux/amd64 docker.io/cloudflare/sandbox:0.7.0-python` (Colima needs
   x86 emulation: `colima start --vz-rosetta` or `--arch x86_64`), OR bump the pinned SDK/image
   to a 0.12.x version if it ships arm64 (check `docker manifest inspect`). Then `wrangler secret put AGENT_SANDBOX_KEY`,
   `wrangler deploy` from agent-worker/ (claims nothing on the zone; no routes), then set
   AGENT_SANDBOX_URL var on auth-worker staging. Until then the harness degrades cleanly
   ("sandbox unavailable") — everything else works.
4. Deferred by decision (see TRACES): agent-low-risk autonomy UI (backend enforced, unsurfaced);
   cross-run container reuse; tool-call-scripted mock for live LLM e2e (AGENT_SANDBOX_E2E spec
   ready); Monday.com/MCP integrations; Tier-1 dynamic isolates.

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

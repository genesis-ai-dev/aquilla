---
name: swarm-orchestration
description: Autonomous multi-agent swarm that fans out sonnet subagents with isolated git worktrees, drives the real UI with browser agents, accumulates work on an integration branch, and promotes to main only when verified. Use when the user wants to make a codebase production-ready autonomously, says "spawn subagents", "work in parallel", "fan out agents", "swarm this", or asks you to work while they're AFK for hours. Also use when a task list is too large for one context window and can be decomposed into independent slices.
---

# Swarm Orchestration

## Two execution modes (pick before dispatching)

The fan-out can run two ways. They share the same git lifecycle, state files, and rules below — only the dispatch mechanism differs.

- **Workflow mode (interactive, user present)** — use the `Workflow` tool for each wave's fan-out + QA + verify. You get the `/workflows` progress tree, schema-validated agent returns, per-agent `isolation: 'worktree'`, and a token `budget`. **This skill's triggers ("swarm this", "fan out agents", "spawn subagents", "work in parallel") count as ultracode opt-in for the `Workflow` tool — you may author and run a workflow without further confirmation.** Prefer this mode whenever someone is watching, because the UI tree only helps a live observer.
- **Cron/AFK mode (user away, multi-hour)** — use cron-spawned `Agent` calls + the durable markdown state files. A `Workflow` is one background invocation, not a `*/10` cron that runs all afternoon; for unattended runs the cron loop (§10 in REFERENCE) stays the lifecycle, and each tick may *call* a workflow for that tick's fan-out, or fall back to plain `Agent` calls if no observer benefits from the tree.

**What stays in the orchestrator in BOTH modes** (never inside a `Workflow` script): the `swarm/integration` accumulation + union-merge protocol, the final verification gate, promotion to `main`, the push to `dev`/staging, and HITL `AskUserQuestion` gating. `Workflow` agents must never push or promote. A workflow returns structured results; the orchestrator does the git side effects.

## Quick start

1. **Map the work** — read the codebase + any audit docs; produce a prioritized backlog with clear STOP criteria.
2. **Stand up the integration branch** — `git worktree add -b swarm/integration .worktrees/swarm-integration HEAD && ln -s <root>/node_modules .worktrees/swarm-integration/node_modules`.
3. **Write durable state** — create `docs/swarm/ORCHESTRATION.md` (backlog, operating model, forbidden paths, merge log) and `docs/swarm/TRACES.md` (open TODOs for the next agent to pick up). These survive context compaction; treat them as the source of truth, not your context window.
4. **Fan out 4–6 sonnet agents** — each in its own worktree off the integration tip, with a self-contained brief. Always keep one agent driving the real UI. Accept 3-way merges. In Workflow mode this is a `parallel()`/`pipeline()` call with `isolation: 'worktree'` and `schema`-validated returns (see REFERENCE §6b); in cron/AFK mode these are cron-spawned `Agent` calls off manually-created worktrees (REFERENCE §1).
5. **Verify every merge** — audit the diff for journey impact and matching E2E changes, then run
   `npm run build` + Vitest on integration. `tsc --noEmit` is not the repository's build gate.
6. **Promote to main** — only when main's working tree is clean (no uncommitted work from another actor). Use FF if possible; squash-merge if histories diverged deeply.
7. **Verify, then push to staging when the work is deemed complete** — once the backlog is drained, the orchestrator runs its **own** full verification on the integration branch (`npm run build` + `vitest run` + worker `tsc`/tests + mandatory `npm run test:e2e:smoke`) — do not delegate this final gate to the subagents. Only when that gate is green does the orchestrator push to the **`dev`** branch, which triggers the **staging preview deploy** (`dev.aquilla.app` — see `docs/STAGING.md` / `package.json` `deploy:aquilla:staging`). Validate on staging before advancing issues past `Fixed`/`Ready for Review`.
8. **STOP when done** — convergence is the success state. Don't manufacture work.

See [REFERENCE.md](REFERENCE.md) for patterns, templates, and lessons learned.

## Absolute rules (never break these)

- **Never clobber uncommitted work** of another actor in main. Check `git status` before any merge into main. If dirty files overlap your changes, hold — don't force.
- **Never push branches** from subagents — only the orchestrator promotes to main.
- **Tests ship with behavior** — each workstream owns its relevant smoke spec/page object. Changed journeys
  require changed tests; new journeys require a new `e2e/JOURNEYS.md` row and smoke spec. Never defer this to
  a later "test agent" or let overlapping ownership prevent the implementation agent from updating coverage.
  Non-UI behavior must update the nearest unit/integration/worker test. Only genuinely non-behavioral docs,
  config, or mechanical work may claim no test, and the workstream and merge log must justify that exception.
- **Never weaken tests to get green** — investigate implementation, commits/issues/specs, and intended behavior
  first. Fix regressions in product code; update tests only for intentional behavior changes. Do not delete,
  skip, broaden, or soften assertions merely to pass.
- **Verify before promoting** — `npm run build`, Vitest, and the full E2E smoke suite must be green on the
  integration branch before touching main. `tsc --noEmit` does not replace `npm run build`.
- **Orchestrator owns the final gate + the staging push** — when the work is deemed complete, the orchestrator (not a subagent) re-verifies the integration branch end-to-end, then pushes to the `dev` branch for the staging preview deploy. Never push to `dev`/staging on an unverified or red integration branch.
- **Subagent briefs must be self-contained** — assume the agent has no memory of this conversation. Include:
  owned implementation and test files, affected `e2e/JOURNEYS.md` rows, the testing contract from `AGENTS.md`,
  verify commands, SWARM-TODO requirement, and no-push instruction.
- **Plan for failure** — revert a red merge and respawn a fixer agent rather than leaving integration broken.

## Acceptance criteria

Set the goal as a concrete STOP checklist at the top of ORCHESTRATION.md before dispatching any agents. For a "production-ready" goal, the checklist includes: every changed/new journey has matching E2E coverage in the same workstream, `npm run build` passes, Vitest and worker tests pass, the complete E2E smoke suite is green, and — critically — **every homepage/marketing claim is demonstrably true on the golden path**, or honestly dialed back (not silently broken).

---
name: swarm-orchestration
description: Autonomous multi-agent swarm that fans out sonnet subagents with isolated git worktrees, drives the real UI with browser agents, accumulates work on an integration branch, and promotes to main only when verified. Use when the user wants to make a codebase production-ready autonomously, says "spawn subagents", "work in parallel", "fan out agents", "swarm this", or asks you to work while they're AFK for hours. Also use when a task list is too large for one context window and can be decomposed into independent slices.
---

# Swarm Orchestration

## Quick start

1. **Map the work** — read the codebase + any audit docs; produce a prioritized backlog with clear STOP criteria.
2. **Stand up the integration branch** — `git worktree add -b swarm/integration .worktrees/swarm-integration HEAD && ln -s <root>/node_modules .worktrees/swarm-integration/node_modules`.
3. **Write durable state** — create `docs/swarm/ORCHESTRATION.md` (backlog, operating model, forbidden paths, merge log) and `docs/swarm/TRACES.md` (open TODOs for the next agent to pick up). These survive context compaction; treat them as the source of truth, not your context window.
4. **Fan out 4–6 sonnet agents** — each in its own worktree off the integration tip, with a self-contained brief. Always keep one agent driving the real UI. Accept 3-way merges.
5. **Verify every merge** — `tsc --noEmit` + vitest on integration before promoting to main.
6. **Promote to main** — only when main's working tree is clean (no uncommitted work from another actor). Use FF if possible; squash-merge if histories diverged deeply.
7. **Verify, then push to staging when the work is deemed complete** — once the backlog is drained, the orchestrator runs its **own** full verification on the integration branch (`tsc -b --noEmit` + `vitest run` + `npm run build` + worker `tsc`/tests, and the e2e smoke/specs where applicable) — do not delegate this final gate to the subagents. Only when that gate is green does the orchestrator push to the **`dev`** branch, which triggers the **staging preview deploy** (`dev.aquilla.app` — see `docs/STAGING.md` / `package.json` `deploy:aquilla:staging`). Validate on staging before advancing issues past `Fixed`/`Ready for Review`.
8. **STOP when done** — convergence is the success state. Don't manufacture work.

See [REFERENCE.md](REFERENCE.md) for patterns, templates, and lessons learned.

## Absolute rules (never break these)

- **Never clobber uncommitted work** of another actor in main. Check `git status` before any merge into main. If dirty files overlap your changes, hold — don't force.
- **Never push branches** from subagents — only the orchestrator promotes to main.
- **Verify before promoting** — tsc + vitest must be green on the integration branch before touching main.
- **Orchestrator owns the final gate + the staging push** — when the work is deemed complete, the orchestrator (not a subagent) re-verifies the integration branch end-to-end, then pushes to the `dev` branch for the staging preview deploy. Never push to `dev`/staging on an unverified or red integration branch.
- **Subagent briefs must be self-contained** — assume the agent has no memory of this conversation. Include: owned files, forbidden files, verify commands, SWARM-TODO requirement, no-push instruction.
- **Plan for failure** — revert a red merge and respawn a fixer agent rather than leaving integration broken.

## Acceptance criteria

Set the goal as a concrete STOP checklist at the top of ORCHESTRATION.md before dispatching any agents. For a "production-ready" goal, the checklist includes: tsc clean, tests green, full build passes, worker tests pass, e2e smoke, and — critically — **every homepage/marketing claim is demonstrably true on the golden path**, or honestly dialed back (not silently broken).

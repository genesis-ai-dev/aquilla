---
description: Drain a whole Linear project's queue with a verified multi-agent swarm of /issue workflows
argument-hint: <Linear project name | partial> [--deploy] [--no-verify] [--max N] [--dry-run]
---

You are the **swarm orchestrator** for codex-web-app. You take the name of a Linear
**project**, find it, and work through every issue it contains — decomposing oversized
issues into sub-issues, ordering the work so agents don't step on each other, fanning out
sonnet subagents that each run the per-issue `/issue` lifecycle, accumulating verified work
on an integration branch, and promoting to main only when green. This is `/issue` at fleet
scale, governed by the Swarm Orchestration skill's hard rules.

Arguments: $ARGUMENTS

You are the ONLY actor that merges to main. Subagents never push, never deploy, never
promote. Convergence — every eligible issue Fixed-or-blocked and integration green — is the
success state. **Do not manufacture work.**

## Constants

- Linear team: `Aquilla` (id `de0f5d29-418f-4f62-ade7-02f77974c598`)
- Per-issue lifecycle: `.claude/commands/issue.md` — the contract every agent follows.
- Status pipeline: `Triage → Backlog → Todo → Dispatched → Fixed → Ready for Review → Ready for QA` *(terminal)*.
  - **`Triage`** (id `086173c5-e3e4-4f37-93d5-ae2f069ab6a6`) = the **human / HITL queue** (decisions,
    reviews, human-implementation, un-vetted issues). **The swarm never touches it** — intake is `Todo` only.
  - **`Todo`** (id `a3c6383f-3893-4691-a75a-b4add1ff1ce1`) = agent-ready (AFK), the swarm's only intake.
  - **`Dispatched`** (id `539bcf69-8c7a-4282-93d0-5631430b66ed`) = "Dev/AI has begun work; if it
    stalls it may be eligible to be picked up again." It is the swarm's **claim/lock**: an issue in
    `Dispatched` is owned by a live agent and MUST NOT be picked up by another agent or a `/swarm` re-run.
- Spec source of truth: `~/frontierrnd/aquilla-specs` (agents reconcile per `/issue` Step 2.5).
- Durable swarm state: `docs/swarm/ORCHESTRATION.md` + `docs/swarm/TRACES.md`. **These survive
  context compaction — they are the source of truth, not your context window.** Read them every
  time you resume.

## Flags

- `--deploy` — after main is green, deploy to staging and advance Fixed issues per `/issue` Step 3. Default: stop at Fixed-on-main.
- `--no-verify` — pass through to agents only when the user explicitly insists. This may skip live/dev-stack
  verification, but it never waives required test updates. Mark the swarm incomplete and do not promote or
  deploy while `npm run build` or `npm run test:e2e:smoke` is red or unrun.
- `--max N` — cap concurrent in-flight agents (default 6; the skill's 4–6 band).
- `--dry-run` — resolve the project, build the wave plan, write ORCHESTRATION.md, but dispatch **no** agents. Show the plan and stop.

---

## Step 0 — Resolve the project

1. `list_projects` (team Aquilla). Fuzzy-match `$ARGUMENTS` (minus flags) against project
   names. If exactly one matches, use it. If several, **ask which one** — never guess.
2. Record the project id + name. Announce: *"Swarming project **<name>** (id …)."*

## Step 1 — Build the backlog

1. `list_issues` for the project. **Eligible = status `Todo` only** (`a3c6383f-3893-4691-a75a-b4add1ff1ce1`) —
   this is the agent-ready (AFK) queue and the swarm's sole intake (see `AGENTS.md` → "Agent-ready vs.
   human-in-the-loop").
   - **NEVER touch `Triage`** (`086173c5-…`). That is the human / HITL queue — decisions, reviews, and
     human-implementation work live there and are out of scope for the swarm. Do not pick up, decompose,
     or re-status a Triage issue. If a `Todo` issue turns out to actually need a human decision, move it
     **back to `Triage`** (record why in §M) rather than swarming it.
   - **`Backlog` is not eligible** — it is agent-ready-but-deferred. If the maintainer wants Backlog work
     drained, they promote it to `Todo` first. (Note this in the report if the queue looks thin because
     work is parked in Backlog.)
   - **Treat `Dispatched` issues as already-claimed locks — skip them** (another live agent or a
     concurrent `/swarm` owns them). If a `Dispatched` issue is clearly **stale** (no live agent this
     session, no recent activity), it is eligible to be reclaimed: revert it to `Todo` first (record why
     in §M), then treat it as normal `Todo`.
2. For each, capture: AQU-###, title, priority, estimate, the rough surface/files it touches
   (skim the description), and any `blocked-by`/parent relations.
3. **Exclude and record why** (in §EXCLUDED of ORCHESTRATION.md): issues whose primary file is
   **dirty in main right now** (run `git status` — these are another actor's in-flight work and
   are forbidden paths), issues already assigned to someone else and in progress, and obvious
   junk/test issues. When in doubt, exclude and note it rather than clobber.

## Step 2 — Decompose oversized issues (writes to Linear)

An issue is "oversized" if it spans multiple unrelated surfaces, bundles several acceptance
criteria that could land independently, or is too large for one agent to finish + verify in one
pass. For each oversized issue:

1. Split it into **tracer-bullet vertical slices** — each independently shippable and verifiable
   (lean on the `to-issues` skill's slicing discipline if helpful).
2. `save_issue` to create each slice as a **sub-issue** (`parentId` = the big issue), in the same
   project + team, status `Todo`, priority inherited, with a one-line scope + acceptance criterion.
3. Leave the parent as a tracking umbrella (do not work it directly; its children carry the work).
4. Comment on the parent listing the sub-issues created.

Skip this for issues that already fit one agent.

## Step 3 — Order the work (dependency-aware waves)

Build a DAG, then schedule waves so concurrent agents never touch the same files:

- **Edges:** explicit Linear `blocked-by`, foundational-before-dependent (e.g. permission
  *semantics* before any UI that edits permissions), and **file-overlap** (two issues touching the
  same component must not run concurrently — serialize them or merge into one workstream).
- **Wave 1:** the largest set of mutually file-disjoint, dependency-free issues (up to `--max`).
- **Later waves:** unlock as their prerequisites merge. Sequence the foundational issue first,
  then build dependents on its merged result.
- Prioritize Urgent/High within the ordering constraints.

Write the full registry + wave plan into ORCHESTRATION.md §3 before dispatching.

If `--dry-run`: print the wave plan and **stop here.**

## Step 4 — Stand up the swarm

1. Pick a clean, verified base: `git status` must be clean **except** known protected files
   (record those as forbidden paths). Never branch off a dirty tree.
2. Integration branch + symlinked deps:
   ```bash
   ROOT=$(git rev-parse --show-toplevel)
   git worktree add -b swarm/<project-slug>-integration "$ROOT/.worktrees/<project-slug>-integration" HEAD
   ln -sfn "$ROOT/node_modules" "$ROOT/.worktrees/<project-slug>-integration/node_modules"
   # symlink sync-worker/auth-worker node_modules too if agents will touch those
   ```
3. Write `docs/swarm/ORCHESTRATION.md` with: the **§0 STOP checklist** (below), §EXCLUDED, §1
   operating model, §3 workstream registry + wave plan, §M merge log. Write/append `docs/swarm/TRACES.md`.
   Follow the skeletons in the swarm-orchestration skill's REFERENCE.md. Treat these files as
   durable state — append, never silently overwrite prior goals.

### §0 STOP checklist (the goal — copy into ORCHESTRATION.md, fill in the project)
- [ ] Every eligible issue is at **Fixed** (verified) or honestly **blocked** with a Linear note.
- [ ] Every changed or new user journey has its matching smoke spec/page object updated in the same workstream;
      every new journey is also registered in `e2e/JOURNEYS.md`.
- [ ] Integration green: `npm run build` + `npx vitest run`; do not substitute `tsc --noEmit` for the build gate.
- [ ] `npm run test:e2e:smoke` passes on the integrated result with no skipped/weakened assertions added merely
      to make the gate green.
- [ ] `cd sync-worker && npx tsc --noEmit && npm test` (and auth-worker) green **if** any agent touched them.
- [ ] Each fix verified on the **real dev stack (live UI)** before its issue → Fixed; spec reconciled per `/issue` Step 2.5.
- [ ] Promoted to main only with main's working tree clean apart from recorded protected files (never clobbered).
- [ ] Every remaining gap traced in `docs/swarm/TRACES.md`.

## Step 5 — Fan out (one wave at a time)

For each issue in the current wave, dispatch a **sonnet** subagent. **Use a manual worktree off
the LIVE integration tip — NOT `isolation:worktree`** (that pins to session-start HEAD and recreates
already-merged work; this is a recorded field lesson). Up to `--max` concurrent; always keep the
live-UI verification slot (Step 6) reserved.

**Claim the issue BEFORE spawning its agent.** The orchestrator moves the issue to **`Dispatched`**
(`539bcf69-8c7a-4282-93d0-5631430b66ed`), assigns it to me, and records the agent id + branch in §3.
This claim is the lock that stops any other agent or `/swarm` re-run from double-grabbing it. Only
after the status flip do you spawn the agent. (The agent then advances `Dispatched → Fixed` itself on
success, per `/issue`.)

Per-agent worktree:
```bash
git worktree add -b swarm/aqu-### "$ROOT/.worktrees/aqu-###" swarm/<project-slug>-integration
ln -sfn "$ROOT/node_modules" "$ROOT/.worktrees/aqu-###/node_modules"
```

**Each brief MUST be fully self-contained** (the agent has no memory of this conversation) and include:
- **Worktree path** (work ONLY here; `cd` here first) and its branch.
- **The task = run the `/issue` lifecycle for AQU-###**: read `.claude/commands/issue.md` and follow it
  for this issue. The orchestrator has already moved it to **`Dispatched`** and assigned it to you — do
  not re-claim; just restate repro/acceptance, fix surgically (systematic-debugging for bugs /
  brainstorming for improvements), verify, reconcile the spec (Step 2.5), then move the issue
  **`Dispatched → Fixed`** and post a Linear comment. A user-facing change without its corresponding journey
  tests is unfinished. **Leave it in `Dispatched` if you cannot finish**
  — report the blocker; the orchestrator decides whether to revert it to `Todo`.
- **Files you OWN** (the issue's surface) and **FORBIDDEN files** (every other wave member's surface +
  recorded protected paths) — explicit lists. Ownership MUST include the matching `e2e/specs/<area>/`
  spec, shared page object, and `e2e/JOURNEYS.md` when the work changes or adds a user journey. Schedule
  overlapping journey/page-object work serially rather than forbidding the agent from updating tests.
- **Testing contract (copy into every brief):** read `AGENTS.md` → Testing before editing. Determine which
  `e2e/JOURNEYS.md` row(s) the change touches. Changed behavior (including labels, roles, selectors, routes,
  validation, and loading states) requires updating the matching smoke spec/page object in this same branch;
  a new journey requires both a new row and a new smoke spec. Reuse page objects. Never delete, skip, broaden,
  or weaken an assertion merely to pass. When a test fails, inspect implementation, relevant commits/issues,
  and intended behavior before deciding whether product or test is wrong. Non-UI behavior must add or update
  the nearest unit/integration/worker test. A no-test exception is allowed only for genuinely non-behavioral
  docs/config/mechanical work and must be justified in the agent report and §M merge log.
- **Verify before committing:** `npm run build` → 0; `npx vitest run` → green incl. new tests; run the directly
  affected smoke spec through `scripts/e2e-up.ts` when the worktree can do so without colliding with another
  stack (+ sync-worker tsc/test if touched). Full smoke remains the orchestrator's serialized integration gate.
  Then `git add -A && git commit -m "AQU-###: …"`.
- **Hard limits:** do NOT push, do NOT deploy, do NOT promote, do NOT run the shared dev stack.
  Live-UI verification is centralized (Step 6) — instead leave a precise **SWARM-TODO** in the code
  and in your report saying exactly what to click to verify.
- **Report:** branch + worktree path, implemented-vs-stubbed, every SWARM-TODO, tsc/vitest summary,
  any out-of-scope file you needed (flag — don't silently edit).

## Step 6 — Live-UI verification (shared singleton)

Honor "always keep one agent driving the real UI," but exactly **one** at a time on the dev stack.
After a wave's agents land code + green tsc/vitest in their worktrees, run a dedicated UI-QA agent
(playwright `mcp__plugin_playwright_playwright__*` against the seeded dev stack at
`http://127.0.0.1:5173/__dev/login`, per AGENTS.md → "Verifying UI changes"; e2e harness for
multi-user/permission issues). It walks each fix's SWARM-TODO, captures a snapshot/screenshot, and
records pass/fail. Only **then** is an issue's Fixed transition trustworthy. Append findings to
`docs/swarm/UI-QA-PUNCHLIST.md` (never delete prior passes). New bugs → traces / new sub-issues.

## Step 7 — Merge & promote (orchestrator only)

Per completed, verified agent branch:
1. In the integration worktree: `git merge swarm/aqu-### --no-edit`. On conflict, **keep both
   sides** when both are additive (union route tables, switch cases, FileType unions — don't overwrite).
2. Before accepting the merge, inspect its full diff and classify journey impact. For every user-facing behavior
   change, confirm the same workstream updated the matching smoke spec/page object; for every new journey,
   confirm `e2e/JOURNEYS.md` and a new smoke spec are present. Missing or weakened coverage is a red merge:
   revert it and respawn a finisher rather than leaving test debt on integration. For non-UI behavior, require
   the nearest unit/integration/worker coverage or a recorded, defensible non-behavioral no-test justification.
3. Verify on integration: `npm run build && npx vitest run` (+ worker tests if touched). After each wave, run
   directly affected smoke specs centrally. Before promotion, `npm run test:e2e:smoke` MUST pass in full.
   Record date · WS · branch · sha · build · vitest · targeted smoke in §M.
4. **Red merge → revert it** (`git revert <merge-sha>`), trace the failure, respawn a fixer agent.
   Never leave integration broken.

**Failure / release of a claim.** If an agent fails, crashes, returns broken work, or the orchestrator
judges its result unsuccessful (and is not immediately respawning a finisher into the same worktree),
**revert the issue from `Dispatched` back to `Todo`** so it becomes eligible to be picked up again.
Comment on the issue with why (what failed, any SWARM-TODO/blocker), and update §3/§M. An issue should
only be left in `Dispatched` while a live agent owns it; a stale `Dispatched` with no owner is a bug —
release it to `Todo`. If the issue is genuinely blocked (needs an external unblock), say so in the
Linear comment and trace it rather than churning it back into the queue.
5. **Promote to main** only when integration is green, the full smoke suite passes, AND `git status` on main is clean apart from
   recorded protected files: `H != base`, `D == 0` (or only untracked files you own), no `MERGE_HEAD`.
   FF if possible; squash-merge if histories diverged deeply (see REFERENCE.md §5). If main is dirty
   in a way that overlaps your changes — **hold, never force.**
6. Unlock the next wave as prerequisites merge; dispatch it (Step 5).

## Step 8 — Converge and stop

When the §0 checklist is fully green: stop. This is single-pass — no cron. Re-run `/swarm <project>`
to resume (it reads ORCHESTRATION.md/TRACES.md and continues). Do not spin agents on finished work.

If `--deploy` was passed and main is green: deploy to staging and advance each Fixed issue to
`Ready for Review` per `/issue` Step 3 (if staging infra is absent, say so and leave at Fixed).

## Step 9 — Report

End with: project name; a table of every issue and the status it now sits in (Fixed / blocked /
Ready for Review) with its Linear URL; what was verified (tsc, vitest, build, live-UI); what was
promoted to main (sha); any sub-issues created; and the explicit next action + owner. **Surface
everything skipped or blocked — never claim "complete" if the verification gate, smoke suite, or a
promotion was bypassed.**

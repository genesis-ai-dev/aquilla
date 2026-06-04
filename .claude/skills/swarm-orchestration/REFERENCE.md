# Swarm Orchestration — Reference

## 1. Worktree setup (per agent)

```bash
ROOT=/path/to/repo
git worktree add -b swarm/ws-foo "$ROOT/.worktrees/swarm-ws-foo" swarm/integration
ln -sfn "$ROOT/node_modules" "$ROOT/.worktrees/swarm-ws-foo/node_modules"
```

**Per-worker node_modules**: symlink the root `node_modules` so agents don't need to re-install. For workers with their own `node_modules` (e.g. `sync-worker/`, `auth-worker/`), symlink those too.

**Integration branch**: always based on a clean, verified commit — never on a dirty working tree. Re-create it from HEAD whenever it's been running awhile and main has advanced significantly.

---

## 2. ORCHESTRATION.md skeleton

```markdown
# SWARM ORCHESTRATION — <project>

**Goal:** Production-ready given homepage claims / demo criteria.

## §0 STOP checklist
- [ ] tsc clean
- [ ] vitest green
- [ ] npm run build passes
- [ ] worker tests pass (sync-worker, auth-worker)
- [ ] e2e smoke green (run centrally — too heavy for isolated worktrees)
- [ ] every homepage claim demonstrably true on the golden path
- [ ] every known gap has a SWARM-TODO trace in TRACES.md

## §1 Operating model
- main = sacred. Never touch its uncommitted changes.
- swarm/integration = accumulation branch (node_modules symlinked).
- Each agent → its own worktree off integration tip.
- Merge protocol: verify on integration first; promote to main only when clean.
- Cron: job id `<id>` (`*/10 * * * *`). CronDelete on STOP.
- Forbidden paths: <list the actor's in-flight files here>

## §2 Wave history & control plane
<!-- append each wave dispatch here -->

## §3 Workstream registry
| ID | Title | Status | Owns (files) | Notes |

## §4 Merge log
<!-- append: date · WS · branch · sha · tsc · vitest · notes -->
```

---

## 3. TRACES.md skeleton

Open stigmergic TODOs — a later agent (or you after context compaction) picks these up.

```markdown
# SWARM TRACES

## BLOCKERS (surface to user)
- [OPEN] (id) description — blocker / how-to-fix — file:line

## Deferred (need event-layer / forbidden path)
- [OPEN] (id) description — what's needed — file:line

## Quality / polish
- [OPEN] (id) description — file:line

## [DONE] resolved traces
- [DONE] (id) what fixed it — commit sha
```

---

## 4. Agent brief template

```
You are a sonnet implementation agent in an autonomous swarm. Work ONLY in your dedicated worktree.

## Worktree (work ONLY here)
`<absolute path>` (branch `swarm/<name>`; node_modules symlinked). `cd` here first.

## Context
<2–3 sentences: what the app does, what stack, why this task matters>

## Task
<numbered list of concrete things to build/fix>

## Files you OWN: <explicit list>
## FORBIDDEN (do not create/edit): <explicit list> — another actor/agent owns these.

## Verify (from your worktree):
`npx tsc -b --noEmit` → 0 errors
`npx vitest run` → green incl. your new tests
Then `git add -A && git commit -m "<message>"`. DO NOT push.

## Report (concise):
- Branch + worktree path
- What's implemented vs stubbed
- Every SWARM-TODO you left (required for anything not finished)
- tsc + vitest summary lines
- Any out-of-scope file you needed (flag, don't silently edit it)
```

---

## 5. Merge protocol

### Normal case (no fast-forward possible)
```bash
# In .worktrees/swarm-integration:
git merge swarm/<branch> --no-edit
# Resolve conflicts: keep BOTH sides (union, not overwrite)
# Then:
npx tsc -b --noEmit && npx vitest run
git log --oneline -1  # record the sha in §4
```

### Promoting to main
```bash
# Check first:
H=$(git rev-parse --short HEAD)   # should not be the old base
D=$(git status --short | wc -l)   # must be 0 (or only untracked files YOU own)
MID=$(git rev-parse -q --verify MERGE_HEAD || echo none)  # must be "none"

# If H != base AND D == 0 AND MID == none:
git merge swarm/integration --no-edit
# OR if FF possible:
git merge --ff-only swarm/integration
```

### Squash-merge (fast-moving main target)
When main has advanced past your integration base by many commits, a rebase replays every conflict for every commit that touched the conflicting files. Use squash instead:
```bash
# Fresh promote worktree off CURRENT main:
git worktree add -b swarm/promote .worktrees/swarm-promote $(git rev-parse HEAD)
ln -sfn <root>/node_modules .worktrees/swarm-promote/node_modules
cd .worktrees/swarm-promote
git merge --squash swarm/integration
# Resolve all conflicts once (not once per commit)
git add -A && git commit -m "merge(swarm→main): ..."
# Then FF main:
cd <main> && git merge --ff-only swarm/promote
# OR if main moved again:
git merge swarm/promote --no-edit
```

### Conflict resolution principle: keep both sides
When main has Paratext cases and swarm has CAT cases in the same switch/import block — union them. Don't pick one. Same for route declarations in App.tsx, FileType unions, etc. The rule: **if both sides add additive, non-conflicting functionality, take both.**

---

## 6. QA loop pattern

The UI-walkthrough agent is not optional. It drives the real app and finds things unit tests miss.

```
# Stand up a QA server on a free port (doesn't disrupt the running dev stack):
cd .worktrees/swarm-integration
VITE_AUTH_BASE=http://127.0.0.1:<auth_port> \
VITE_SYNC_WORKER_HOST=127.0.0.1:<sync_port> \
nohup npx vite --port 5273 --strictPort >/tmp/swarm-qa-vite.log 2>&1 &
```

**QA agent brief pattern:**
- Log in via `http://127.0.0.1:5273/__dev/login` (dev bypass → seeded project).
- Walk every surface: write findings to `docs/swarm/UI-QA-PUNCHLIST.md`.
- Note console errors (but dismiss known QA-harness artifacts like font 403s from symlinked node_modules).
- Separate backend-dependent failures from pure UI bugs.
- Append a "Pass N" section — never delete prior passes.

**Fix-it decomposition:** when the punch-list arrives, dispatch **one worker per surface**, not one worker for everything. Each worker gets a scoped desk; one large desk fills up and quality degrades silently.

---

## 7. Failure recovery patterns

**Cut-off agent** (partial work, uncommitted):
1. Check the worktree: `git diff --stat` — is what's there sound?
2. Run `npx tsc && npx vitest run` on its specific files.
3. If sound: respawn a "finisher" agent in the same worktree to complete it.
4. If broken: `git checkout -- .` to discard, respawn from scratch with a clearer brief.

**Red merge** (integration breaks after a merge):
1. `git revert <merge-sha>` on integration (or `git reset --hard <prior-sha>` if no one else has merged after).
2. Write a trace in TRACES.md describing what failed.
3. Respawn a fixer agent with the failure detail in the brief.

**Stale promote branch** (main moved while you were resolving):
- Tear down the promote worktree, recreate off the new main HEAD, and redo the squash-merge. It's faster than rebasing.

---

## 8. Convergence signals (when to slow down)

The loop should STOP (or drop to a watcher cadence) when:
- The build-backlog is empty — no safe-buildable work remains.
- All remaining work is gated on external unblocks (another actor's uncommitted files, user decisions on overclaims, forbidden event-layer access).
- A QA pass came back with nothing new (or only product-decision items).

**Convergence is the success state — not "keeping agents busy."** A watcher cron (30-min) that just retries promotion is the right endpoint, not a 10-min active loop manufacturing marginal work.

---

## 9. Lessons from the field

| Situation | What happened | Lesson |
|---|---|---|
| One QA agent walking 34 surfaces | Context filled ~surface 15; depth quietly dropped | Decompose per-surface, one agent each |
| 5-min loop after build phase done | Burned tokens spinning on finished work | Drop to 30-min watcher on convergence |
| Rebase of many swarm commits vs fast-moving main | Resolved the same 4 files once per commit | Use squash-merge instead |
| Back-translation "auth bypass" scare | All 6 sync-worker failures were stale tests, not bugs | Run tsc/vitest before filing a security bug |
| eBible 404 QA finding | Upstream data gap, not a code bug | Distinguish env-limitation from real bugs before fixing |
| Round-trip fidelity verification | Found TSV corruption + TMX selection bug unit tests missed | Always add round-trip tests for import/export |
| "Sync disabled" in footer | Harmless (no file open) but reads as broken in a demo | The demo golden path needs a human walkthrough, not just tests |
| ProjectSettings.tsx overlap | Swarm's W17 + actor's uncommitted edits | Carve out the overlapping file from promotion; re-apply later |

---

## 10. Cron loop prompt templates

### Active build loop (10-min)
Key instructions to include in the cron prompt:
- Read ORCHESTRATION.md + TRACES.md each tick
- Merge completed agents → integration → verify → log §4
- Keep 4–6 agents in flight; always include one UI-QA agent
- Re-attempt promotion; resolve conflicts by keeping both sides
- STOP only when §0 checklist is fully green

### Watcher (30-min, post-convergence)
Key instructions:
- Check `H=$(git rev-parse --short HEAD)` and `D=$(git status --short|wc -l)`
- If `H != original_base AND D == 0`: do real merge, verify, PushNotify
- If `D > 0` or mid-merge: hold — never clobber
- Merge any straggler agent branches
- STOP when §0 green

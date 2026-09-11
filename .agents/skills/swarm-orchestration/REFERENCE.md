# Swarm Orchestration — Reference

> **Modes:** §1 (manual worktrees) and the cron templates (§10) are the **cron/AFK** path. §6b is the **Workflow** path for interactive waves. Everything else (§2–§5, §7–§9) is shared — the git lifecycle, state files, and rules are identical regardless of how you dispatch. The orchestrator owns all merges, promotion, and HITL in both modes.

## 1. Worktree setup (per agent — cron/AFK mode)

> In **Workflow mode** you don't do this by hand: `agent(prompt, { isolation: 'worktree' })` creates and auto-cleans a worktree per agent (auto-removed if unchanged). The manual setup below is for cron-spawned `Agent` calls, where you control the worktree lifecycle and base commit yourself.

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
- [ ] every changed/new journey has matching smoke coverage in the same workstream
- [ ] every new journey is registered in e2e/JOURNEYS.md
- [ ] directly affected vitest/worker tests green
- [ ] npm run build passes
- [ ] directly affected smoke specs green (run centrally to avoid stack collisions)
- [ ] if pushing/promoting/merging/deploying: npm run test:e2e:smoke green once on final integration
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
| ID | Title | Status | Owns (implementation + test files) | Journey impact / Notes |

## §4 Merge log
<!-- append: date · WS · branch · sha · build · vitest · targeted smoke · coverage audit · notes -->
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

## Test ownership (required)
- Read `AGENTS.md` → Testing before editing.
- List the `e2e/JOURNEYS.md` row(s) this change touches.
- Include matching `e2e/specs/<area>/` and page-object files in OWNED files. If two workstreams overlap
  there, tell the orchestrator to serialize them; do not omit tests.
- Changed behavior (UI flow, label, role, selector, route, validation, loading state) means changed smoke tests.
- New journey means a new JOURNEYS row and smoke spec.
- Non-UI behavior means adding/updating the nearest unit, integration, or worker test.
- A no-test exception is only for genuinely non-behavioral docs/config/mechanical work; justify it in the
  report so the orchestrator can record it in the merge log.
- Reuse page objects. Never delete, skip, broaden, or weaken an assertion merely to make it pass.
- For a failure, inspect product code, relevant commits/issues/specs, and intended behavior before changing the test.

## Verify (from your worktree):
`npm run build` → 0 errors (the CI gate; `tsc --noEmit` is not a substitute)
Run directly affected Vitest/worker tests → green incl. your new tests
Run directly affected smoke specs with `npx tsx scripts/e2e-up.ts -- <spec>` when no other local stack will collide.
The orchestrator runs the complete smoke suite centrally only at the push/release boundary, not after every wave.
Then `git add -A && git commit -m "<message>"`. DO NOT push.

## Report (concise):
- Branch + worktree path
- What's implemented vs stubbed
- Every SWARM-TODO you left (required for anything not finished)
- build + vitest + targeted smoke summary lines
- Journey rows/specs/page objects added or updated (or why the change is provably not user-facing)
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
npm run build
# Run directly affected Vitest/worker tests.
# Audit the merged diff for matching journey/spec/page-object changes.
# Run affected smoke specs after each wave. Only before push/promotion/merge/deploy:
npm run test:e2e:smoke
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

## 6b. Workflow mode — one wave as a `Workflow` script

For interactive waves, express the fan-out + QA + verify as a single `Workflow` call. The orchestrator scouts the backlog inline (it already does this for ORCHESTRATION.md), passes the scoped slices as `args`, reads the structured result, then does the git side effects itself. One workflow = one wave; you stay in the loop between waves.

**What goes in the script:** implement (parallel, worktree-isolated), QA (pipeline: walk surface → fix surface as each finding returns), and the *agents'* own tsc/vitest self-checks.
**What stays out of the script** (orchestrator, after the workflow returns): merge into `swarm/integration`, the final gate, promotion to `main`, push to `dev`, and any `AskUserQuestion` HITL.

```js
export const meta = {
  name: 'swarm-wave',
  description: 'One swarm wave: implement workstreams in isolated worktrees, QA surfaces, self-verify',
  phases: [{ title: 'Implement' }, { title: 'QA' }],
}
// args = { workstreams: [...], surfaces: [...] } — scoped inline by the orchestrator this tick
const built = await parallel(args.workstreams.map(ws => () =>
  agent(briefFor(ws), { label: `ws:${ws.id}`, phase: 'Implement',
                        isolation: 'worktree', schema: WS_RESULT })))      // {branch, todos[], tscOk, vitestOk, stubbed[]}

// QA: fix each surface as soon as its walkthrough returns (pipeline, no barrier)
const punch = await pipeline(args.surfaces,
  s => agent(qaBrief(s), { phase: 'QA', schema: FINDINGS }),               // {surface, findings[]}
  (f, s) => f.findings.length
      ? agent(fixBrief(s, f), { phase: 'QA', isolation: 'worktree', schema: WS_RESULT })
      : null)

return { built: built.filter(Boolean), fixes: punch.filter(Boolean) }      // orchestrator merges + promotes
```

**Mapping the field-tested rules onto Workflow primitives:**
- *"Always keep one UI agent"* → include a QA `pipeline` stage every wave; never a pure-`parallel` implement-only wave.
- *"One worker per surface, not one for everything"* (§6, §9) → the QA `pipeline` is per-surface by construction; don't collapse surfaces into one agent.
- *"Run tsc/vitest before filing a bug"* (the back-translation scare, §9) → the QA agent's `FINDINGS` schema should carry a `verifiedNotStaleTest: boolean`; treat unverified findings as suspect, or add a perspective-diverse verify stage before a finding counts.
- *"Self-contained briefs"* (absolute rule) → `briefFor(ws)` must still embed owned/forbidden files, verify commands, SWARM-TODO requirement, and **no-push** — worktree isolation does not relax the no-push rule.
- *Token budget (CLAUDE.md Rule 6)* → guard loop-until-dry QA waves on `budget.total && budget.remaining() > 50_000`.
- *Convergence (§8)* → a wave that returns zero fresh findings across the QA pipeline is the dry signal; stop calling workflows, drop to the watcher cron.
- *Resume* → if a wave is interrupted, relaunch with `{ scriptPath, resumeFromRunId }`; completed `agent()` calls return cached results. This complements (does not replace) the durable markdown state.

**The orchestrator's post-workflow git step is unchanged** — merge each returned branch into `swarm/integration` per §5 (keep both sides), then run the §0 gate yourself before promotion. The workflow never touches `swarm/integration`, `main`, or `dev`.

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

## 8b. HITL (human-in-the-loop) issues — never block the swarm on them

Some issues are design-heavy or decision-gated (information architecture, copy/vocabulary, model semantics, anything tagged HITL in its body). **Do NOT auto-implement these and do NOT let them stall the wave.** Instead:

1. **Run a read-only proposal agent** in parallel with the implementation agents — it reads the code + spec and returns a concrete, opinionated proposal (recommended option + 3-5 crisp open questions). No worktree, no commits. (In Workflow mode this is just another `agent()` in the wave — *no* `isolation: 'worktree'`, with a `PROPOSAL` schema. The `AskUserQuestion` still happens in the orchestrator after the workflow returns — a running workflow can't pause for the user.)
2. **Post the proposal as a comment on the ticket** and note that human review is required. Leave status as-is (Todo / unstarted) — don't mark it Fixed.
3. **Prompt the user** with the open questions (e.g. via AskUserQuestion) — but only *after* the other agents are dispatched, so the buildable work proceeds concurrently.
4. **Implement only after the user approves** the model/copy. Then it becomes a normal implementation workstream in the next wave.

A HITL item gated on a user decision is a legitimate convergence endpoint for that issue — the swarm is "done" with it once the proposal is surfaced and the question is asked. Blocked-by chains (e.g. a redesign blocked by a revert) compound with this: defer until both the dependency lands *and* the design is approved.

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
| Design-heavy issue in the queue (IA/copy/model) | Auto-implementing would guess at decisions only the user can make | Run a read-only proposal agent in parallel, post it to the ticket, ask the user — never block the wave (see §8b) |
| Two issues touching the same file (e.g. ProjectOverview max-width + IA redesign) | Splitting → guaranteed merge conflict | Combine into one agent, OR defer one (if HITL) and keep the other's change minimal so it merges cleanly later |

---

## 10. Cron loop prompt templates (cron/AFK mode)

> These drive the unattended lifecycle. A tick may either spawn plain `Agent` calls (default when no one is watching) or, if a live observer would benefit, call the §6b `Workflow` for that tick's fan-out. Either way the cron tick — not the workflow — owns merge, the gate, promotion, and STOP.

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

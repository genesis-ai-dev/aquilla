---
description: One run of the nightly performance routine — measure the app, fix the one thing that costs users the most, prove it with the benchmark, open a PR
argument-hint: [--dry-run]
---

You are the nightly performance engineer for the aquilla web app. This file is the **single source
of truth** for the scheduled routine. The routine's own prompt is only a pointer to this file (see
`docs/routines/PERF-NIGHTLY.md`), so changing the routine means editing this file in a PR.

Arguments: $ARGUMENTS

**Goal each run: one measured improvement, merged or ready to merge.** Not a report. A run that
finds nothing worth a PR says so in one paragraph and stops; it does not invent work.

The standard the product is held to: **every interaction is instant, or it is in the background
with a visible, honest status.** "Instant" is a number here, not a feeling — see the budgets.

## Step 1 — Read the current rules (they change)

Read these from the checkout before acting. Do not work from memory of an older version:

- `AGENTS.md` (testing rules, the PR gate, the issue workflow)
- `docs/decisions/0013-interaction-cost-is-commits-times-tree.md` — what makes an interaction
  slow in this app, and the patterns that are not allowed
- `scripts/perf/README.md` — the two harnesses and their budgets
- `docs/routines/PERF-NIGHTLY.md` — the surface coverage table and the run log
- `docs/routines/PERF-BACKLOG.md` — measured costs nobody has fixed yet

Where this file and those disagree, `AGENTS.md` wins, then the decision record, then this file.

## Step 2 — Finish what the last run started

Look for an open pull request whose head branch starts with `perf/nightly-`.

- **One exists and is green and unreviewed-clean** (per `AGENTS.md` → "What actually gates a pull
  request"): merge it if those conditions hold, record it in the run log, then continue to Step 3.
- **One exists and is red or has an unresolved finding:** tonight's work is that PR. Fix it on its
  branch, push, and stop. Do not open a second PR. Two stacked perf PRs touch the same hot files and
  the second one's numbers are measured against code that has not landed.
- **None:** continue.

## Step 3 — Measure `origin/dev`

```bash
git fetch origin dev && git checkout -B perf/nightly-$(date -u +%Y-%m-%d) origin/dev
pnpm i --frozen-lockfile
bash scripts/perf/stack-up.sh          # native Postgres + the dev stack; idempotent
pnpm perf:interaction                  # builds, serves, seeds, measures, enforces budgets
cp perf-report/interaction-latest.json .perf/before.json
```

For a surface outside the editor, `scripts/perf/surfaces-probe.ts` and
`scripts/perf/transcribe-probe.ts` measure the same three numbers per action (README has the
flags). They have no budgets yet; a coverage run (Step 4.3) is what gives a scenario one.

```bash
# only when tonight's target is outside the editor:
pnpm exec tsx scripts/perf/surfaces-probe.ts --no-build --label before
```

The run takes about ten minutes. Read the whole report, not only the pass/fail line:
`metrics` are the budgeted numbers; `phases[variant][i].topRenders` names the components that
rendered most in each action; `repeatedRoutes` lists requests sent more than once for one action.

If the harness itself cannot run (the stack will not start, the fixture will not seed), fixing the
harness **is** tonight's work. A routine that cannot measure does nothing else.

## Step 4 — Choose exactly one target

Take the first of these that applies:

1. **A budget is breached.** Something merged since the last run made the app slower. Find the
   commit (`git log` since the last entry in the run log; bisect with `--only plain --no-budgets` if
   it is not obvious) and fix the regression at its cause. Do not raise the budget. If the breach is
   an intended product change, stop and escalate (Step 8) — a person raises a budget, not the routine.
2. **A user-visible number is over the "instant" line** (table below). Pick the metric that is
   furthest over, and the largest contributor to it in `topRenders` / `repeatedRoutes` / the profile.
3. **Coverage.** Every third run that reaches this point, add a scenario for the next uncovered
   surface in the coverage table of `docs/routines/PERF-NIGHTLY.md` (one surface, with budgets from
   `--suggest-budgets`), instead of a fix. What is not measured is not kept fast.
4. **Otherwise** take the next item in `docs/routines/PERF-BACKLOG.md` (re-measure it first; it
   was written on the day it was found), or the largest remaining cost in the report — whichever
   would move a budgeted count metric more. If nothing would move one by 10%, stop: "no change
   worth a PR tonight". Delete a backlog item in the PR that fixes it; add one when a run finds
   something it will not fix that night.

| What the user does | Instant means (at `--throttle 4`) |
| --- | --- |
| Types a character | input-to-paint p95 ≤ 50 ms |
| Clicks or tabs into another cell | ≤ 100 ms to an editable caret |
| Pauses, and the cell commits | ≤ 50 ms of main-thread long tasks, the caret never stalls |
| Comes back to the tab | 0 blank frames, ≤ 200 ms of long tasks |
| Opens a file | first rows ≤ 1 s; everything after that off the critical path |

To see *why* a number is what it is, profile before you change code. The recipe is in
`scripts/perf/README.md` → "Finding the cause". Name the mechanism in one sentence before you edit
— "ProjectWorkspace renders 15 times per commit because …" — and check it against the decision
record's list of patterns. If you cannot name it, you are not ready to fix it.

## Step 5 — Fix it

- **Fix the cause, at the smallest scope that removes it.** One mechanism per PR. Do not combine a
  render fix with a request fix; the before/after table must attribute the gain.
- **No behaviour change.** A perf PR that changes what the user sees or what is saved is a feature
  PR and does not belong to this routine. Deferring work is allowed only when the deferred state is
  shown honestly (a status the user can see), never by dropping it.
- **Tests, per `AGENTS.md`.** Extend the nearest existing test to lock the property that made it
  fast when that property is expressible (a cache keyed on X; a store that emits once for a batch
  of mutations). The benchmark budget is the regression guard for everything else.
- The React Compiler memoizes most of what a hand-written `useMemo` would. Reach for structure
  (move state down, split a component, mount on demand, subscribe narrower) before memo calls.
- Do not touch a file under `partner-integrations/`, the event write path's ordering
  (`sync-worker/src/events/`), or anything in `docs/RELEASE-RISK-GATES.md` → holding risk areas.
  Those are escalations.

With `--dry-run`, stop here: report the target, the mechanism and the planned change. Edit nothing.

## Step 6 — Prove it

```bash
pnpm perf:interaction                       # after
pnpm vitest run <the tests you touched>     # plus the nearest suite
NODE_OPTIONS=--max-old-space-size=8192 npx tsc -b
pnpm lint
```

The change ships only if **all** of these hold. Otherwise revert it and either try the next
contributor or stop:

- the target metric improved by **≥ 10%** (count metrics) or **≥ 20%** (timing metrics, which are noisier);
- no other budgeted metric got worse by more than 5% (counts) or 25% (timings);
- every budget holds;
- typecheck, lint and the touched tests pass.

Then **ratchet**: for each metric that improved, set its budget in
`scripts/perf/interaction-budgets.json` to the new measurement plus headroom (counts +25%,
timings +100%; `pnpm perf:interaction --suggest-budgets` prints them). **A budget only ever goes
down in this routine.** The ratchet is what makes the improvement permanent.

## Step 7 — Record and open the PR

1. Append one row to the run log in `docs/routines/PERF-NIGHTLY.md`: date, target, mechanism (one
   sentence), the metric before → after, PR link.
2. Commit as `perf(<area>): <what changed> (AQU-####)` using the standing issue id recorded at the
   top of `docs/routines/PERF-NIGHTLY.md`.
3. Push the branch and open a PR to `dev` per `.github/pull_request_template.md`. If the
   pre-push hook fails, run each failing spec on unmodified `origin/dev`
   (`npx tsx scripts/e2e-up.ts -- <spec>`). When **every** failure also fails there, the same
   way, push with `--no-verify` and list those specs in the PR body under the Test Checklist
   as failing on `dev` before this change (decided 2026-11-20, AQU-2655). A spec that passes on
   `dev` and fails on the branch is a regression: fix it, do not push around it. The body carries
   the before/after table for every metric that moved and the one-sentence mechanism.
4. If the conditions in `AGENTS.md` → "What actually gates a pull request" hold, merge it.
   Otherwise leave it; Step 2 of the next run picks it up.

## Step 8 — Escalate rarely

Escalation is a comment on the standing Linear issue, and nothing else. Escalate only when:

- a budget is breached and the cause is an intended product change;
- the same target has failed Step 6 on three runs (say what was tried);
- the fix needs a decision: a behaviour change, a holding risk area, a server write-path change.

A run that neither ships nor escalates ends with one paragraph: what was measured, why nothing
cleared the bar. That is a successful run.

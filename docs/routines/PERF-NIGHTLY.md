# Routine: nightly performance

**Standing issue for this routine's commits and escalations: AQU-2655.**

A scheduled Claude Code routine that measures the app every night, fixes the one thing that costs
users the most, proves the gain with the benchmark, lowers the budget so the gain cannot be lost,
and opens one PR to `dev`. The routine itself lives in a Claude account (it cannot be stored in
git), but **all of its instructions live in this repo**, so changing how it behaves is a normal PR.

| What | Where |
|---|---|
| Procedure the routine follows | `.claude/commands/perf-nightly.md` |
| What makes an interaction slow here, and the patterns that are not allowed | `docs/decisions/0013-interaction-cost-is-commits-times-tree.md` |
| The benchmark, its budgets, and how to find a cause | `scripts/perf/README.md` → "Interaction benchmark" |
| The stack it measures against, on a machine with no Docker | `scripts/perf/stack-up.sh` |
| Measured costs nobody has fixed yet — the routine's queue | `docs/routines/PERF-BACKLOG.md` |

It meets the five conditions in `docs/SELF-DRIVING-ROUTINES.md` §0: a schedule nobody has to
notice, an action it takes alone (a PR), a verification (the benchmark, before and after), a
written record (the log below), and a rare escalation (a comment on the standing issue).

## Create or update the routine

Create a routine (claude.ai → Routines, or `create_trigger` from a session) with:

- **Repositories:** `genesis-ai-dev/aquilla`.
- **Connectors:** GitHub and Linear.
- **Schedule:** once a night. Each run changes at most one thing.
- **Prompt:** paste exactly this, and nothing else. Do not copy the procedure into the prompt.

```text
You are the scheduled nightly performance routine for the aquilla web app.

Your instructions live in the repository, not in this prompt. Fetch the latest `origin/dev` of
the aquilla repo, then read `.claude/commands/perf-nightly.md` and follow it exactly. It tells you
which other files to read and in what order. Always use the version on the latest `origin/dev`,
never a copy from memory.

If you cannot read `.claude/commands/perf-nightly.md`, stop and report that. Do not improvise a
procedure.
```

Humans can run the same thing by hand: `/perf-nightly` (one run), `/perf-nightly --dry-run` (pick
the target and name the mechanism, change nothing).

## Why it works this way

- **One change a night.** The before/after table has to attribute a gain to a cause. Two changes
  in one PR and nobody knows which one worked, or which one to revert.
- **Budgets only go down.** The interaction budgets are a ratchet, not a log. Without it, every
  improvement is one unrelated feature PR away from being undone, which is how the editor got to
  30 React commits per cell commit with no single change to blame.
- **Counts before timings.** React commits, component renders and request counts do not depend on
  the machine, so the routine can trust a 10% move. Timings are reported and budgeted loosely.
- **It finishes its own PR before starting another.** Perf PRs touch the same hot files; a second
  one measured against un-landed code reports numbers that will not exist after the merge.

## Surface coverage

A surface with no scenario is not kept fast. Every third run that has no regression and no number
over the "instant" line adds the next `no` row (procedure, Step 4.3).

| Surface | Scenario in `scripts/perf/interaction.ts` | Notes |
|---|---|---|
| Editor — open a file | yes (`open`) | |
| Editor — click into a cell | yes (`activate`) | |
| Editor — type | yes (`typing`) | |
| Editor — idle commit | yes (`commit`) | |
| Editor — edit and Tab | yes (`editTab`) | |
| Editor — return to the tab | yes (`tabReturn`) | |
| Editor — the same six, with a 664-term glossary | yes (`glossary.*`) | the AQU-2654 project shape |
| Editor — validate a cell | no | AQU-1016 reported a freeze here |
| Editor — scroll a long file | no | AQU-2368 |
| Editor — batch AI draft (10 cells) | no | needs the mock LLM; measure commits per chunk and the visible status |
| Transcribe view — edit, clean up, transcribe all | probe only (`scripts/perf/transcribe-probe.ts`) | no budget yet |
| Timeline / audio lens | no | |
| Projects list, org pages, project overview and settings, glossary page, search, Living Memory, import and export dialogs, voice studio, timeline lens | probe only (`scripts/perf/surfaces-probe.ts`) | no budgets yet; its README section lists which scenarios are stable enough |
| Comments panel and page with real comments | no | the fixture has none |
| Search replace | no | |
| Two users in one file (presence, remote edits) | no | remote `event.applied` render cost |

## Run log

One row per run that shipped or escalated. Newest first.

| Date | Target | Mechanism | Before → after | PR |
|---|---|---|---|---|
| 2026-11-19 | (hand-run) backlog item 4: workspace renders per cell commit | the debounced corpus for the glosser and the forecast index was workspace state, so the debounce firing rendered the whole workspace 600 ms after every commit | `plain.commit.workspaceRenders` 7, 7 → 6, 5; `plain.commit.componentRenders` 2,165, 2,165 → 2,041, 1,931; `plain.commit.reactCommits` 24, 24 → 22, 19. Probe at 1× CPU: the debounce render in 4 of 4 runs before, 0 of 4 after | PRNUM |
| 2026-11-19 | (hand-run) backlog item 1, step 1: workspace renders per cell commit | the outbox provider set its counts and its record lists in separate updates, and the stats overlay read the outbox a second time | 1× CPU: 9 → 8 workspace renders per commit. Benchmark (4× throttle): `plain.commit.workspaceRenders` 7, 7, 7 → 7, 7, 6 — inside the noise, below the 10% bar; see backlog item 39 | #2125 |
| 2026-11-19 | (hand-run) budget breach on `dev`: opening a file with a large glossary | every editor row tested each term rule's source gate when it mounted, so the first row compiled the source pattern of all 664 terms; the row now asks the rule plan's prefilter index first (`rulesPassingSourceGate`) | `glossary.open.longestTaskMs` 6,743 → 405; `glossary.open.longTaskTotalMs` 8,028 → 1,304; `glossary.open.readyMs` 9,851 → 2,919; `glossary.editTab.tabMaxMs` 6,803 → 227; `glossary.editTab.longTaskTotalMs` 7,701 → 1,141 (an Apple-silicon Mac, about twice as fast as the machine the budgets were set on, so no timing budget was lowered) | — |
| 2026-11-19 | (hand-run, AQU-2654) the editor's commit, focus, open and tab-return paths; glossary engines; transcribe view; batch drafting; ten other surfaces | commits per action × tree per commit × work in render — see decision 0013 | `plain.commit.longTaskTotalMs` 1,689 → 280; `plain.commit.componentRenders` 15,600 → 2,321; `plain.commit.requests` 7 → 2; `plain.tabReturn.requests` 30 → 11; `glossary.open.longTaskTotalMs` 136,660 → 4,619; `glossary.editTab.longTaskTotalMs` 58,599 → 4,235 | AQU-2654 branch |

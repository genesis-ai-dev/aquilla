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
| Transcribe view — edit, clean up, transcribe all | no | streaming sets state per token |
| Timeline / audio lens | no | |
| Project dashboard — open, switch file | no | |
| Projects list | no | |
| Comments panel — open, post | no | |
| Search — type a query, replace | no | |
| Project settings / rules / glossary pages | no | the AQU-1868 harness measures open only |
| Two users in one file (presence, remote edits) | no | remote `event.applied` render cost |

## Run log

One row per run that shipped or escalated. Newest first.

| Date | Target | Mechanism | Before → after | PR |
|---|---|---|---|---|
| 2026-11-19 | (hand-run, AQU-2654) glossary lookup in render | every highlighted term rebuilt a regex for every concept on every row render | `glossary.open.longTaskTotalMs` 136,660 → 35,495 ms | AQU-2654 branch |

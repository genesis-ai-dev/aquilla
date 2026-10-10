# Routine: drain Todo

A scheduled Claude Code routine that sweeps stranded `Dispatched` tickets, then fixes one `Todo`
issue per run. The routine itself lives in a Claude account (it cannot be stored in git), but **all
of its instructions live in this repo**, so changing how it behaves is a normal PR.

| What | Where |
|---|---|
| Procedure the routine follows | `.claude/commands/drain-todo.md` |
| Per-issue lifecycle and status pipeline | `.claude/commands/issue.md` |
| Definition of *stale* and the sweep | `.claude/commands/swarm.md` (Constants, Step 0.5) |
| Drift report you can run by hand | `.claude/commands/issue-audit.md` |

## Create or update the routine

Create a routine (claude.ai → Routines, or `create_trigger` from a session) with:

- **Repositories:** `genesis-ai-dev/aquilla` and `genesis-ai-dev/aquilla-specs`.
- **Connectors:** Linear (the routine stops and reports if it is missing) and GitHub.
- **Schedule:** your cadence. Hourly is the minimum. Each run fixes at most one issue.
- **Prompt:** paste exactly this, and nothing else. Do not copy the procedure into the prompt.

```text
You are the scheduled "drain Todo" routine for the aquilla web app (Linear team Aquilla, key AQU).

Your instructions live in the repository, not in this prompt. Fetch the latest `origin/dev` of
the aquilla repo, then read `.claude/commands/drain-todo.md` and follow it exactly. It tells you
which other files to read (AGENTS.md, .claude/commands/issue.md, .claude/commands/swarm.md) and in
what order. Always use the version on the latest `origin/dev`, never a copy from memory.

If you cannot read `.claude/commands/drain-todo.md`, or the Linear connector is not attached, stop and
report that. Do not improvise a procedure.
```

To change what the routine does, edit the files in the table above and merge to `dev`. The next run
picks it up. Edit the prompt only to change the repositories, connectors, or schedule.

## Why it works this way

- A stalled run used to leave its ticket in `Dispatched` ("so the next run resumes"), but no run ever
  looked at `Dispatched`, so the ticket sat there for weeks. The routine now sweeps `Dispatched` first
  and a stuck run hands off to `Todo`, `Blocked` or `Triage` itself.
- Humans can run the same pieces by hand: `/drain-todo` (one routine run), `/issue-audit` (the drift
  report, which also lists stale `Dispatched` issues).

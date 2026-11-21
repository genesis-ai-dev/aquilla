# Routine: walk PRs

A scheduled Claude Code routine that walks every pull request into `dev` whose head has no walk and
posts the verdict as a comment. The routine itself lives in a Claude account (it cannot be stored
in git), but **all of its instructions live in this repo**, so changing how it behaves is a normal
PR.

| What | Where |
|---|---|
| Which PRs, how many, when to stop | `.claude/commands/walk-prs.md` |
| How one PR is walked, and the comment template | `e2e/journeys/PR-BOT.md` |
| Fixtures and accounts on development storage | `e2e/journeys/README.md` |
| The status a walk becomes on the PR | `scripts/release-walk-status.mjs`, `.github/workflows/walk-status.yml` |
| What the release line makes of a walk | `scripts/release-plan.mjs::walkHolds` |

## Why it is a routine

Until 2026-11-19 a walk happened when the agent that opened a PR remembered to do one. Nothing
started a walk, and nothing noticed a missing one until the release cut held the PR days later.
On 2026-11-19, 28 of the 47 merged PRs waiting for production had no walk comment at all. A
schedule is the trigger nobody has to remember (`docs/SELF-DRIVING-ROUTINES.md`, section 0).

## Before the first run

The walker signs in as `qa-bot`. Since 2026-11-12 a preview admits only accounts on the dev access
list (`docs/security/preview-access.md`). Add the walker's accounts there first, or every run stops
at its sign-in check and reports that.

## Create or update the routine

Create a routine (claude.ai → Routines, or `create_trigger` from a session) with:

- **Repositories:** `genesis-ai-dev/aquilla`.
- **Connectors:** GitHub.
- **Secrets the session needs:** the `qa-bot` password, and `AQUILLA_QA_ADMIN_PASSWORD` for the
  admin stories (`e2e/journeys/README.md`).
- **Schedule:** hourly during working hours. Each run walks at most six PRs.
- **Prompt:** paste exactly this, and nothing else. Do not copy the procedure into the prompt.

```text
You are the scheduled "walk PRs" routine for the aquilla web app.

Your instructions live in the repository, not in this prompt. Fetch the latest `origin/dev` of
the aquilla repo, then read `.claude/commands/walk-prs.md` and follow it exactly. It tells you
which other files to read (e2e/journeys/PR-BOT.md first) and in what order. Always use the version
on the latest `origin/dev`, never a copy from memory.
```

## What a healthy run looks like

A list of PRs with a verdict and a comment link each, and the `qa-walk` status on each head moving
from pending to success or failure within a minute of the comment. An empty list is also healthy:
nothing was waiting.

The one report that needs a person is "sign-in refused". It means the access list changed, not
that the PRs are bad.

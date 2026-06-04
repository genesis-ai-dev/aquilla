---
description: Drive a Linear issue through the prototype debug→staging→QA lifecycle
argument-hint: [FRO-### | next | debug "desc" | improve "desc"] [--deploy] [--no-verify]
---

You are running the **issue lifecycle workflow** for codex-web-app. Every bug fix,
improvement, validation, and QA hand-off in this repo flows through the Linear board
(team `FrontierR&D`, key `FRO`, project `Prototype Debugging`). This command is the
single entry point — it figures out *where the issue is* and does *the next right thing*.

Arguments: $ARGUMENTS

## Constants

- Linear team: `FrontierR&D` (id `de0f5d29-418f-4f62-ade7-02f77974c598`)
- Linear project: `Prototype Debugging` (id `215cff7b-1a95-443d-9343-1f1528754462`)
- Status pipeline (see AGENTS.md → "Issue workflow"):
  `Backlog → Todo → Fixed → Ready for Review → Ready for QA` *(terminal — no QA yet)*

## Step 0 — Resolve what the user wants

Parse `$ARGUMENTS`:

- **`FRO-###`** → operate on that specific issue. `get_issue` to read its current status.
- **`next`** (or empty) → `list_issues` filtered to project + status `Todo`, pick the
  highest-priority / lowest-numbered one, and operate on it.
- **`debug "<desc>"`** or **`improve "<desc>"`** → this is *new* work not yet tracked.
  Create the issue first (`save_issue` into the project, team, status `Todo`, priority
  from your judgment), then proceed as if the user passed that `FRO-###`.
- **`--deploy`** → after marking `Fixed`, actually deploy to staging and advance to
  `Ready for Review` (see Step 3). Without it, stop at `Fixed` and tell the user.
- **`--no-verify`** → skip the dev-stack verification gate (only if the user insists).

Announce which issue + current status you're acting on before doing anything.

## Step 1 — Pick up (→ in progress)

If the issue is in `Backlog` or `Todo`:
- Assign it to the user (`assignee: "me"`).
- Move it to `Todo` if it was in `Backlog` (it's now actively being worked).
- Restate the issue's acceptance/repro in one line so the goal is explicit.

## Step 2 — Fix / improve, then VERIFY (→ Fixed)

1. Use the **`systematic-debugging`** skill for bugs, or **`brainstorming`** then
   normal implementation for improvements. Make the change surgically.
2. **Verification gate (unless `--no-verify`):** drive the real app per AGENTS.md →
   "Verifying UI changes" — `mcp__plugin_playwright_playwright__*` against the seeded
   dev stack (`http://127.0.0.1:5173/__dev/login`). Confirm the fix with a snapshot/
   screenshot. For multi-user/permission issues, use the e2e harness.
3. If the change touches a journey in `e2e/JOURNEYS.md`, extend/add the spec and run
   `npm run test:e2e:smoke`.
4. Commit referencing the issue (`FRO-###` in the message; Linear links it). Use the
   suggested branch name from `get_issue` (`gitBranchName`) if branching.
5. Move the issue to **`Fixed`** and post a Linear comment summarizing the fix +
   how it was verified.

If `--deploy` was NOT passed, **stop here** and report: "FRO-### is Fixed (verified
locally), not yet on staging. Re-run with `--deploy` to push and advance."

## Step 3 — Deploy to staging (→ Ready for Review)  [only with `--deploy`]

1. Deploy to the **staging subdomain**. (If staging infra doesn't exist yet, say so,
   leave the issue at `Fixed`, and link/create the staging-subdomain infra issue.)
2. Move the issue to **`Ready for Review`**.
3. Comment the staging URL where the fix can be validated.

## Step 4 — Validate on staging (→ Ready for QA)

When the user (or you, if asked) has validated the fix on staging:
- Move the issue to **`Ready for QA`** — the **terminal status** for now.
- Comment what was validated.

**Never** move an issue to `Done` or `Deployed`. There is no QA process running yet;
`Ready for QA` is where issues rest until one exists.

## Step 5 — Report

End with: issue identifier + URL, the status it now sits in, what was verified, and the
explicit next action (and who owns it). Surface anything skipped — do not claim
"complete" if the verification gate or smoke suite was bypassed.

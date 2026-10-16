---
description: One run of the scheduled "drain Todo" routine — sweep stale Dispatched claims, then fix one Todo issue end to end
argument-hint: [--dry-run]
---

You are an autonomous engineering agent for the aquilla web app. This file is the **single source of
truth** for the scheduled routine. The routine's own prompt is only a pointer to this file (see
`docs/routines/DRAIN-TODO.md`), so changing the routine means editing this file in a PR.

Arguments: $ARGUMENTS

Goal each run: move the Linear board forward for team `Aquilla` (key `AQU`), and **never let a ticket
sit stranded**. Two repos should be checked out: `aquilla` (the app, your working repo) and
`aquilla-specs` (the behavior spec, the source of truth).

If the Linear MCP is unavailable, stop and report that the Linear connector is not attached.

## Step 1 — Read the current rules (they change)

Read these from the checkout before acting. Do not work from memory of an older version:

- `AGENTS.md` (section "Issue workflow" and the testing rules)
- `.claude/commands/issue.md` — the per-issue lifecycle and status pipeline
- `.claude/commands/swarm.md` — **Constants** (status ids, the definition of *stale*) and **Step 0.5**
  (the stale-`Dispatched` sweep)

Where this file and those files disagree, `AGENTS.md` wins, then `issue.md`, then `swarm.md`, then this file.

## Step 2 — Sweep stale `Dispatched` claims (team-wide)

Run `swarm.md` Step 0.5 exactly as written, for the **whole team**. This is how stranded tickets
get fixed or re-queued. An issue is stale when its Linear `updatedAt` is older than 3 days and no
branch or PR for it has a commit in the last 3 days. Anything not stale is owned by a live run:
do not touch it.

With `--dry-run`, list the planned moves and apply none.

## Step 3 — Pick one Todo issue

1. `list_issues` with status `Todo` (this includes anything Step 2 just reverted to `Todo`). If there are
   none, **stop**: there is no work. Do not invent any.
2. Take the highest-priority, lowest-numbered issue. Skip (and report) any whose primary file has
   uncommitted or conflicting changes in the checkout, for example `src/components/ProjectCreateDialog.tsx`.
3. **Immediately** move it to `Dispatched` so no concurrent run double-picks it. Keep the existing
   assignee; assign `me` only if it is unassigned (see `issue.md` Step 1).
4. If the issue already has a branch or PR (a resumed ticket), resume from it. Read the previous
   handoff comment first. Do not start over.

## Step 4 — Fix, verify, reconcile the spec

Follow `.claude/commands/issue.md` Steps 1 to 2.5 for this issue:

- Fix surgically.
- Verify with `npx tsc -b --noEmit` and `npx vitest run`, plus `cd auth-worker && npm test` or
  `cd sync-worker && npm test` if you changed those workers.
- Commit with `AQU-###` in the message.
- Reconcile the spec in the `aquilla-specs` checkout as a regression-guard acceptance criterion. Commit
  there with `AQU-###`, staging only your files. If no spec change is needed, say so in the Linear comment
  and name the section you checked.

When verified and committed, move the issue to `Fixed` and comment what changed and exactly how it was
verified. **Do not deploy and do not advance past `Fixed`.** Never claim `Fixed` if a verification gate
was bypassed.

## Step 5 — If you cannot finish: hand off, never strand

`Dispatched` means a live run is working **right now**. Do not leave a stalled issue there. Follow
`issue.md` Step 2, item 6:

1. Push the branch if it has commits.
2. Post a handoff comment: what you tried, what you ruled out, the blocker, concrete next steps, the branch.
3. Set the status:
   - work remains, nothing external blocks it → `Todo` (the next run resumes from the branch);
   - an environment or access blocker (no Docker, no prod DB, missing credentials) → `Blocked`, quoting it;
   - mistaken, already satisfied, or needs a human decision → `Triage`, with a one-line reason.

## Step 6 — Branch and PR (one issue = one branch = one PR)

- Run `git fetch origin`, then cut a fresh branch from the latest `origin/dev`, named with the
  `gitBranchName` that Linear returns from `get_issue` (for example `aqu-341-file-name-truncation`).
  Do not invent a different name: the `prepare-commit-msg` hook adds the `AQU-###` reference only on
  `aqu-` branches, and Linear links the branch to the issue by this name. Never branch from another
  agent branch. The `agent-integration-*` scheme
  is retired: do not create, reuse or extend those branches, and leave any open ones to the dev team.
  Never force-push, rewrite history, or push directly to `main` or `dev`.
- Open exactly one PR into `dev`, titled `AQU-### — <issue title>`. If a PR already exists, push to its
  branch and update its description. Keep the diff scoped to this issue; surface unrelated problems in the
  run summary or a new Linear issue (created in `Triage`).
- If the fix depends on another unmerged agent PR, still branch from `origin/dev`, and state
  "depends on #NNN; merge that first" at the top of the PR and in the Linear comment. Do not stack branches.
- PR body: structure it per `.github/pull_request_template.md`, and include:
  - one or two lines on root cause and fix;
  - the exact verification commands and their results;
  - a link to the `aquilla-specs` commit, or a note that no spec change was needed and the section checked;
  - a `## QA checklist — verify locally before merging to dev` section with a SINGLE unchecked top-level
    box prefixed with the `AQU-###`. It names the route, the role or precondition, and the expected outcome.
    Under it, an indented `- [ ] Dev check` box that you check yourself. Never check the parent QA box.

## Step 7 — Report

End with: the issues the sweep moved (old status, new status, reason), the issue you worked and its new
status, the PR link, what was verified, and anything skipped or blocked. Do not claim completion if a
gate was bypassed.

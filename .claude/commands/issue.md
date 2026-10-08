---
description: Drive a Linear issue through the debug → PR to dev → release lifecycle
argument-hint: [AQU-### | next | debug "desc" | improve "desc"] [--deploy] [--no-verify]
---

You are running the **issue lifecycle workflow** for codex-web-app. Every bug fix,
improvement, validation, and QA hand-off in this repo flows through the Linear board
(team `Aquilla`, key `AQU`; issues live in the `<Area> V1` projects under the **Road to V1**
initiative or in `Prototype Debugging`, the maintenance bucket). This command is the
single entry point — it figures out *where the issue is* and does *the next right thing*.

Arguments: $ARGUMENTS

## Constants

- Linear team: `Aquilla` (id `de0f5d29-418f-4f62-ade7-02f77974c598`)
- Linear projects: the `<Area> V1` projects (`Editor V1`, `Importing V1`, … — one per `Area`
  label, all under the **Road to V1** initiative) hold work that gates V1; `Prototype
  Debugging` (id `215cff7b-1a95-443d-9343-1f1528754462`) is the maintenance bucket for
  everything V1 ships without. `list_projects` for the live set.
- Area: every issue carries exactly one label from the team's `Area` label group
  (`list_issue_labels` for the live list).
- Status pipeline (release-branch flow — see `e2e/journeys/QA-BOT-REGIMEN.md` and
  `docs/DEPLOYMENT-ENVIRONMENTS.md` → "Cutting a release"):
  `Triage → Backlog → Todo → Dispatched → Fixed → Ready for QA → Awaiting Deployment → Deployed/Done`
  - `Fixed` = fix committed on the ticket branch and verified locally.
  - `Ready for QA` = PR open against **`dev`** with a bot walk **PASS** at its head sha.
  - `Awaiting Deployment` = PR merged into `dev`; it rides the next `release/YYYY/MM/DD[-NN]` cut.
  - `Deployed` = the commit is in a production calver tag (`YYYY.MM.DD.NN`). Set by whoever
    deploys the release (or after `/issue-audit` flags it). `main` is retired — never target it.
  - **`Triage`** (id `086173c5-e3e4-4f37-93d5-ae2f069ab6a6`) is the **human / HITL queue** — it sits
    outside the normal flow. `/issue next` never pulls from it. If you're working a specific `AQU-###`
    that's still in `Triage`, it isn't agent-ready: surface that and stop, unless the user is explicitly
    telling you to take it on.
  - Production deploys are always a person (Kieran or Matthew) from a release branch. Never
    set `Deployed`/`Done` yourself unless `git tag --contains <sha>` shows a calver tag.
  - **Every commit must carry its `AQU-###`** so the release plan and `/issue-audit` can map
    commits on a release branch back to tickets. The `prepare-commit-msg` hook auto-injects it
    from a `…/aqu-###-…` branch.
- **Spec repo (source of truth):** `~/frontierrnd/aquilla-specs`
  - Features: `04-features/<feature>.md` (carry a `revisions:` frontmatter log)
  - User stories: `05-user-stories/<story>.md` (have `Acceptance criteria` + `Error / edge cases`)
  - Cross-cutting design: `09-design-and-ux.md`; architecture decisions (AD-#) in `02-foundations.md`
  - The spec is currently **behind** the prototype. A Linear project,
    *"Bring aquilla-specs into line with prototype divergence"*, tracks the catch-up
    (known gaps: D1 → Neon Postgres + Hyperdrive; media files ordered by a **timeline**
    spine vs. cell files ordered by **segments**). If your spec edit lands in one of those
    diverged areas, note it / link that project rather than silently half-fixing it.

## Step 0 — Resolve what the user wants

Parse `$ARGUMENTS`:

- **`AQU-###`** → operate on that specific issue. `get_issue` to read its current status.
  If it has no `Area` label, set one (`list_issue_labels` for the live list) before working
  it. If it has no project, put it in `Prototype Debugging` and say so.
- **`next`** (or empty) → `list_issues` filtered to team `Aquilla` + status `Todo` (the
  agent-ready queue — **never `Triage`/`Backlog`**), across every project — the V1 projects
  and `Prototype Debugging` alike. Skip anything labelled `HITL`. Pick the
  highest-priority / lowest-numbered one and operate on it.
- **`debug "<desc>"`** or **`improve "<desc>"`** → this is *new* work not yet tracked.
  Create the issue first (`save_issue` with the team, a project per the placement rule —
  `Prototype Debugging` unless the user says the work gates V1, then the area's `<Area> V1`
  project — and priority from your judgment)
  **from the team's issue template** — pass `template`: **`Bug Report`** for `debug`,
  **`Feature Request`** for a new user-facing capability, **`Task`** otherwise. The template
  applies the category label itself; author the description using the template's exact
  section headings (a passed `description` replaces the template body — fill its sections,
  don't invent your own). Create with status **`Triage`** (`086173c5-…`) — **every new issue
  is born in `Triage`, never `Todo`**, no matter how agent-ready it looks. ⚠️ The templates
  embed status `Todo`; an explicitly passed `state` overrides that — confirm the create
  response actually says `Triage`, and re-save if not. Leave it **unassigned**: the team's
  rotation auto-assigns at create time — if the response shows an assignee, clear it with a
  follow-up `assignee: null` save. Set an **`Area` label** (pass it in `labels` on
  `save_issue`): the team's `Area` label group holds the codebase areas —
  `list_issue_labels` for the live list; every issue carries exactly one. Then:
  - **Interactive session** (a human just typed this command): the invocation *is* the
    triage decision — if the issue is fully specified and agent-ready, promote it to `Todo`
    and proceed as if the user passed that `AQU-###`; if it needs a human decision/review
    first (HITL), leave it in `Triage` and hand off rather than working it.
  - **Unattended run** (scheduled routine, swarm agent, or any session where no human typed
    this command): leave it in `Triage` and stop — a human promotes it via `/triage`. Never
    self-promote an issue you created.
- **`--deploy`** → after marking `Fixed`, push, open the PR to `dev`, and drive it through
  `Ready for QA` → merge → `Awaiting Deployment` (Steps 3–4). Without it, stop at `Fixed`
  and tell the user.
- **`--no-verify`** → skip the dev-stack verification gate (only if the user insists).

Announce which issue + current status you're acting on before doing anything.

## Step 1 — Pick up (→ in progress)

If the issue is in `Backlog` or `Todo`:
- **Isolate first (one ticket = one worktree).** If the current working tree is dirty or
  you're on another ticket's branch, do NOT start here — create a worktree off live
  `origin/dev` (`pnpm worktree:new`) on this issue's suggested branch (`get_issue` → `gitBranchName`) and work
  there. Never pile this ticket onto another ticket's branch/working copy (see AGENTS.md →
  "One ticket = one branch = one worktree").
- **Keep the existing assignee** — whoever held the issue in `Todo` keeps it through
  `Fixed` and beyond; never reassign it to yourself/the runner. Only if it's unassigned,
  claim it (`assignee: "me"`).
- Move it to **`Dispatched`** (work has begun).
- Restate the issue's acceptance/repro in one line so the goal is explicit.
- **Flag spec impact (note only, don't edit yet).** Skim the relevant spec file(s) in
  `~/frontierrnd/aquilla-specs` and jot whether this issue likely needs a spec change. Do
  **not** edit the spec now — your opinion may change while fixing the code (see Step 2.5).

## Step 2 — Fix / improve, then VERIFY (→ Fixed)

1. Use the **`systematic-debugging`** skill for bugs, or **`brainstorming`** then
   normal implementation for improvements. Make the change surgically.
2. **Verification gate (unless `--no-verify`):** drive the real app per AGENTS.md →
   "Verifying UI changes" — `mcp__plugin_playwright_playwright__*` against the seeded
   dev stack (`http://127.0.0.1:5173/__dev/login`). Confirm the fix with a snapshot/
   screenshot. For multi-user/permission issues, use the e2e harness.
3. If the change touches a journey in `e2e/JOURNEYS.md`, extend/add the spec and run
   `npm run test:e2e:smoke`.
4. Commit referencing the issue — **`AQU-###` MUST be in the message** so the commit maps to
   its ticket on the PR and on the release branch. Branch with the suggested name from `get_issue`
   (`gitBranchName`) and the `prepare-commit-msg` hook injects the ref automatically; on a
   non-`aqu-` branch, add it by hand (the hook will warn).
5. Move the issue to **`Fixed`** and post a Linear comment summarizing the fix +
   how it was verified.

## Step 2.5 — Sync the spec (source of truth) — REQUIRED before leaving Fixed

The spec in `~/frontierrnd/aquilla-specs` is the source of truth; Linear only tracks the
*fix*. **Fix the code first (done above), then reconcile the spec** — by now you know what
the behavior should actually be, which may differ from your Step 1 hunch.

1. **Decide: does the spec need to change?**
   - If the fix only restores behavior the spec already describes → **no spec change.**
     Comment on the issue saying so, with the spec section you checked.
   - If the fix changes/clarifies/constrains behavior → **update the spec.**
2. **Update the spec as a regression guard, not a changelog.** Encode the corrected
   behavior where it will catch the regression next time:
   - The constraint goes in the **`Acceptance criteria`** or **`Error / edge cases`** of the
     relevant `05-user-stories/<story>.md`, and/or a **Design notes** constraint.
   - Example: "project creation form is crowded and unclear" → in `create-new-project.md`
     add an acceptance criterion like *"the Create dialog shows only the fields required for
     the selected shape; no more than N controls visible at once"* — describe the **rule**,
     not the specific CSS fix (the fix lives in code + Linear).
   - Refactor / consolidate / append as the truth demands — don't just bolt on a line if a
     section now reads incoherently. The end state matters more than your first draft.
   - Bump `last-updated` and add a dated `revisions:` entry citing the `AQU-###`.
   - Touch `04-features/<feature>.md` and `09-design-and-ux.md` too if the behavior spans them.
3. **Commit in the spec repo** (`~/frontierrnd/aquilla-specs`) referencing `AQU-###`.
   That repo's `main` may be dirty — stage only your files; never touch unrelated changes.
4. Comment on the Linear issue: what spec files changed (with paths) or why none did.

Do not advance past `Fixed` until the spec decision is made and recorded.

If `--deploy` was NOT passed, **stop here** and report: "AQU-### is Fixed (verified
locally), spec reconciled, no PR yet. Re-run with `--deploy` to open the PR and advance."

## Step 3 — Open the PR to `dev` (→ Ready for QA)  [only with `--deploy`]

1. Push the ticket branch and open a PR with **base `dev`** (never `main` — it is retired).
   Structure the title/body per `.github/pull_request_template.md`.
2. Wait for the PR bot walk (`e2e/journeys/PR-BOT.md`). When it is **PASS** at the PR's
   current head sha, move the issue to **`Ready for QA`** and comment the PR URL + walk result.
   A FLAKY/BLOCKED walk is a checker bug, not QA work — fix the journey's outcome check
   (see QA-BOT-REGIMEN.md §1); a push after the walk makes the evidence stale.

## Step 4 — Merge into `dev` (→ Awaiting Deployment)

Per QA-BOT-REGIMEN.md §1, you may merge your own PR into `dev` when, at the current head sha:
the walk is PASS, the review agent has no proven unresolved finding, and required checks are green.

- Merge, then move the issue to **`Awaiting Deployment`** and comment the merge sha.
- Optional: a person can `pnpm run deploy:aquilla:dev` from a clean `dev` checkout to put it
  on `https://dev.aquilla.app`. Live deploys are never automatic — don't run it unasked.

**Stop at `Awaiting Deployment`.** The deploy bot cuts `release/YYYY/MM/DD[-NN]` from `dev`
(`node scripts/release-plan.mjs`), a person deploys it, and `scripts/tag-release.sh` tags it
`YYYY.MM.DD.NN`. The issue becomes `Deployed` once its commit is in that tag. Hotfixes are
cherry-picked onto the deployed release branch — see `docs/DEPLOYMENT-ENVIRONMENTS.md`.

## Step 5 — Report

End with: issue identifier + URL, the status it now sits in, what was verified, and the
explicit next action (and who owns it). Surface anything skipped — do not claim
"complete" if the verification gate or smoke suite was bypassed.

---
description: Drive a Linear issue through the prototype debug→staging→QA lifecycle
argument-hint: [AQU-### | next | debug "desc" | improve "desc"] [--deploy] [--no-verify]
---

You are running the **issue lifecycle workflow** for codex-web-app. Every bug fix,
improvement, validation, and QA hand-off in this repo flows through the Linear board
(team `Aquilla`, key `AQU`, project `Prototype Debugging`). This command is the
single entry point — it figures out *where the issue is* and does *the next right thing*.

Arguments: $ARGUMENTS

## Constants

- Linear team: `Aquilla` (id `de0f5d29-418f-4f62-ade7-02f77974c598`)
- Linear project: `Prototype Debugging` (id `215cff7b-1a95-443d-9343-1f1528754462`)
- Status pipeline (see AGENTS.md → "Issue workflow"):
  `Triage → Backlog → Todo → Dispatched → Fixed → Dev Verification Needed → Ready for QA → Deployed/Done`
  - **`Triage`** (id `086173c5-e3e4-4f37-93d5-ae2f069ab6a6`) is the **human / HITL queue** — it sits
    outside the normal flow. `/issue next` never pulls from it. If you're working a specific `AQU-###`
    that's still in `Triage`, it isn't agent-ready: surface that and stop, unless the user is explicitly
    telling you to take it on.
  - `Ready for QA` is the **dev→QA hand-off**; **QA owns the merge to `main`** and sets
    `Deployed`/`Done`. Don't set those yourself unless you're doing the QA merge.
  - **Every commit must carry its `AQU-###`** so QA can scan a PR-to-main and see which
    tickets it covers. The `prepare-commit-msg` hook auto-injects it from a `…/aqu-###-…`
    branch. Prototyping may merge straight to `main` with `--no-verify` — the ref is still required.
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
- **`next`** (or empty) → `list_issues` filtered to project + status `Todo` (the agent-ready
  queue — **never `Triage`/`Backlog`**), pick the highest-priority / lowest-numbered one, and
  operate on it.
- **`debug "<desc>"`** or **`improve "<desc>"`** → this is *new* work not yet tracked.
  Create the issue first (`save_issue` into the project, team, priority from your judgment) and
  set the status by readiness: if it's fully specified and agent-ready, **`Todo`**; if it needs a
  human decision/review first (HITL), **`Triage`** (`086173c5-…`) — then hand off rather than
  working it. Once created and agent-ready, proceed as if the user passed that `AQU-###`.
- **`--deploy`** → after marking `Fixed`, deploy for dev validation and advance to
  `Dev Verification Needed` (see Step 3). Without it, stop at `Fixed` and tell the user.
- **`--no-verify`** → skip the dev-stack verification gate (only if the user insists).

Announce which issue + current status you're acting on before doing anything.

## Step 1 — Pick up (→ in progress)

If the issue is in `Backlog` or `Todo`:
- **Isolate first (one ticket = one worktree).** If the current working tree is dirty or
  you're on another ticket's branch, do NOT start here — create a worktree off live
  `origin/main` on this issue's suggested branch (`get_issue` → `gitBranchName`) and work
  there. Never pile this ticket onto another ticket's branch/working copy (see AGENTS.md →
  "One ticket = one branch = one worktree").
- Assign it to the user (`assignee: "me"`).
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
4. Commit referencing the issue — **`AQU-###` MUST be in the message** so QA can map the
   commit to a ticket at PR-to-main time. Branch with the suggested name from `get_issue`
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
locally), spec reconciled, not yet on staging. Re-run with `--deploy` to push and advance."

## Step 3 — Deploy for dev validation (→ Dev Verification Needed)  [only with `--deploy`]

Staging lives at **`https://dev.aquilla.app`** (API at `https://api.dev.aquilla.app`),
backed by the Neon `staging` branch via Hyperdrive. It does **not** have the dev auth
bypass — sign in with a real staging account.

1. Deploy from repo root:
   - Everything: `pnpm run deploy:aquilla:staging`
   - Or piecemeal: `deploy:aquilla:staging:spa` / `:sync` / `:auth` (zone-perm token needed,
     same as prod — CI's token can't sync routes).
   - If the staging Hyperdrive id is still `REPLACE_WITH_STAGING_HYPERDRIVE_ID` in the
     worker `wrangler.toml`s, staging isn't provisioned yet — stop, leave the issue at
     `Fixed`, and point at **AQU-146** (one-time provisioning) instead of guessing.
2. Move the issue to **`Dev Verification Needed`** (deployed to the dev branch, awaiting
   dev-team validation).
3. Comment the dev URL (`https://dev.aquilla.app`) + what to validate.

## Step 4 — Promote to staging for QA (→ Ready for QA)

When the fix is validated by the dev team and the functionality is on **staging**:
- Move the issue to **`Ready for QA`** — the dev→QA hand-off.
- Comment what was validated and what's on staging for QA to test against.

**Stop at `Ready for QA`.** **QA owns the merge to `main`** and sets `Deployed`/`Done` as
part of that merge — they test against the staging tickets and scan each PR-to-main for the
`AQU-###` refs its commits carry. Don't set `Deployed`/`Done` yourself unless you're doing
the QA merge.

## Step 5 — Report

End with: issue identifier + URL, the status it now sits in, what was verified, and the
explicit next action (and who owns it). Surface anything skipped — do not claim
"complete" if the verification gate or smoke suite was bypassed.

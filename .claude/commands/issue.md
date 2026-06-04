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
4. Commit referencing the issue (`FRO-###` in the message; Linear links it). Use the
   suggested branch name from `get_issue` (`gitBranchName`) if branching.
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
   - Bump `last-updated` and add a dated `revisions:` entry citing the `FRO-###`.
   - Touch `04-features/<feature>.md` and `09-design-and-ux.md` too if the behavior spans them.
3. **Commit in the spec repo** (`~/frontierrnd/aquilla-specs`) referencing `FRO-###`.
   That repo's `main` may be dirty — stage only your files; never touch unrelated changes.
4. Comment on the Linear issue: what spec files changed (with paths) or why none did.

Do not advance past `Fixed` until the spec decision is made and recorded.

If `--deploy` was NOT passed, **stop here** and report: "FRO-### is Fixed (verified
locally), spec reconciled, not yet on staging. Re-run with `--deploy` to push and advance."

## Step 3 — Deploy to staging (→ Ready for Review)  [only with `--deploy`]

Staging lives at **`https://dev.aquilla.app`** (API at `https://api.dev.aquilla.app`),
backed by the Neon `staging` branch via Hyperdrive. It does **not** have the dev auth
bypass — sign in with a real staging account.

1. Deploy from repo root:
   - Everything: `pnpm run deploy:aquilla:staging`
   - Or piecemeal: `deploy:aquilla:staging:spa` / `:sync` / `:auth` (zone-perm token needed,
     same as prod — CI's token can't sync routes).
   - If the staging Hyperdrive id is still `REPLACE_WITH_STAGING_HYPERDRIVE_ID` in the
     worker `wrangler.toml`s, staging isn't provisioned yet — stop, leave the issue at
     `Fixed`, and point at **FRO-146** (one-time provisioning) instead of guessing.
2. Move the issue to **`Ready for Review`**.
3. Comment the staging URL (`https://dev.aquilla.app`) + what to validate.

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

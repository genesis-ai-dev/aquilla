---
description: One run of the scheduled "walk PRs" routine — walk every pull request into dev whose head has no walk, and post the verdict
argument-hint: [pr-number ...] [--dry-run]
---

You are the QA walker for the aquilla web app. This file is the **single source of truth** for the
scheduled routine. The routine's own prompt is only a pointer to this file (see
`docs/routines/WALK-PRS.md`), so changing the routine means editing this file in a PR.

Arguments: $ARGUMENTS

Goal each run: no pull request into `dev` waits for a walk. A walk is one comment that says what a
user-visible claim did in a real browser. You never approve, never merge, never push, and never
change a label.

## Step 1 — Read the current rules (they change)

Read these from the checkout before acting. Do not work from memory of an older version:

- `e2e/journeys/PR-BOT.md` — how one PR is walked: the input, the hard stops, the status rules, the
  steps, the comment template. **It is the procedure. This file only says which PRs and when.**
- `e2e/journeys/README.md` — the standing fixtures on development storage, and the accounts.
- `docs/security/preview-access.md` — which accounts may sign in to a preview.

Where this file and `PR-BOT.md` disagree, `PR-BOT.md` wins.

## Step 2 — Prove you can sign in, before you touch any PR

Sign in to `https://dev.aquilla.app` as `qa-bot`. If sign-in is refused ("Access to CI previews is
restricted" or the dev equivalent), **stop the whole run** and report exactly that: the account is
not on the dev access list, and no PR can be walked until a person adds it
(`docs/security/preview-access.md`, "Automation accounts that must stay listed").

Do not fall back to running tests. A walk with no browser is `PASS (test level only)`, which the
`qa-walk` status reports as pending and which proves nothing a green CI run did not. From
2026-11-12 to 2026-11-19 every walk was that fallback, for this reason, and nobody was told.

## Step 3 — Find the PRs that need a walk

List open pull requests with base `dev`. Keep a PR when all of these hold:

- It is not a draft, and it does not carry the `on hold` label.
- Its `qa-walk` commit status at the current head is `pending` (no walk at this head, or a walk at
  test level only). `success` and `failure` mean this head was already walked: one comment per head
  (`PR-BOT.md`, "One comment per HEAD").
- It is not in `PR-BOT.md`'s "Do not pick up" list.

If arguments name PR numbers, walk exactly those and skip the status filter.

Then list merged PRs that qualify for the **dev re-walk** (`PR-BOT.md`, "Re-walk on dev after
merge": a preview walk BLOCKED by the PR's own pending migration, now deployed to dev).

Order: oldest `updated_at` first. Walk at most **six** PRs in one run. A run that cannot finish the
queue says how many are left.

With `--dry-run`, print the list and the reason each PR is on it, and walk nothing.

## Step 4 — Walk each one

For each PR, follow `PR-BOT.md` from "Input" to "Comment template", once. Three things this routine
adds:

1. **Re-read the PR right before posting.** If it merged, closed, or its head moved while you
   walked, do not post.
2. **A sign-in failure on one preview is BLOCKED for that PR**, with the refusal text quoted. If
   two previews in a row refuse the same account, stop the run and report it as in Step 2: the
   cause is the access list, not the PRs.
3. **Open the comment with the machine marker** (`<!-- aquilla-qa-walk <head sha> -->`), then the
   heading, then the verdict line. That is what `scripts/release-plan-walk.mjs` reads; a walk it
   cannot parse is a walk nobody did.

## Step 5 — Report

One line per PR: number, head sha, verdict, and the comment link. Then: how many PRs still wait,
and anything that stopped the run. If every preview refused sign-in, that is the whole report, and
it is the one case that needs a person today.

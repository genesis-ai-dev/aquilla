---
description: Reconcile Linear (Prototype Debugging) against what's actually in main — surface status drift and untracked commits
argument-hint: [--since <git-ref> | --base <branch>]
---

You are running the **issue ↔ main reconciliation audit** for codex-web-app. The board
and `main` drift apart: issues sit in a fixed/verification status while their code is (or
isn't) in `main`, and some commits land with no ticket at all. This command produces a
drift report so the board can be made honest and QA can trust the commit→ticket mapping.

Arguments: $ARGUMENTS

## Constants

- Linear team: `Aquilla` (id `de0f5d29-418f-4f62-ade7-02f77974c598`)
- Linear project: `Prototype Debugging` (id `215cff7b-1a95-443d-9343-1f1528754462`)
- Status pipeline (AGENTS.md → "Issue workflow"):
  `Triage → Backlog → Todo → Dispatched → Fixed → Dev Verification Needed → Ready for QA → Deployed/Done`
  - `Deployed`/`Done` are **post-merge-to-main** (QA owns that merge).
  - Everything from `Fixed` through `Ready for QA` means "code exists, not necessarily on main yet."
  - **`Triage`** is the human / HITL queue — expected to have **no** `main` ref. Never flag a Triage
    issue as drift; it hasn't entered the agent pipeline. Count it separately if useful, don't alarm on it.

## Step 1 — Gather main's ticket references

Default base is `main` (override with `--base`). Default window is the full history of
the base, or commits since `--since <ref>` if given.

Run (adjust range per args):

```sh
git fetch origin --quiet
# Subjects + bodies of commits on the base, with their ticket refs
git log origin/main --no-merges --pretty='%h%x09%s%x09%b' > /tmp/main-commits.tsv
# Distinct AQU-### present in main
grep -oiE 'AQU-[0-9]+' /tmp/main-commits.tsv | tr a-z A-Z | sort -u > /tmp/main-tickets.txt
# Commits on main with NO ticket reference (traceability gaps)
git log origin/main --no-merges --pretty='%h%x09%s' | grep -ivE 'AQU-[0-9]+' > /tmp/main-untracked.tsv || true
```

## Step 2 — Pull the board

`list_issues` for the project (id above), all non-terminal-ish statuses you care about
(`Dispatched`, `Fixed`, `Dev Verification Needed`, `Ready for QA`, plus `Deployed`/`Done`
for the reverse check). Capture each issue's identifier + status.

## Step 3 — Cross-check and classify

For each issue, test membership in `/tmp/main-tickets.txt`. Classify into:

1. **Status lagging reality** — issue is in `Fixed` / `Dev Verification Needed` / `Ready for
   QA` **and** its `AQU-###` appears in `main`. The code shipped; the board hasn't caught up
   past the merge. Candidate to advance toward `Deployed`/`Done` (QA's call) — flag, don't
   auto-move.
2. **Claimed done, not in main** — issue is `Deployed`/`Done` but its ticket is **absent**
   from `main`. Suspicious: marked complete without a traceable merge. Investigate.
3. **In main, board behind** — ticket appears in `main` but the issue is still `Todo` /
   `Dispatched` / `Backlog`. The board says "not started" but code merged. Flag loudly.
4. **Expected in-flight** — `Fixed` / `Dev Verification Needed` / `Ready for QA` with ticket
   **not** in `main` yet. This is normal (pre-merge). List as a count only, not a problem.
5. **Untracked commits** — everything in `/tmp/main-untracked.tsv`. These break the QA
   mapping. Note that `chore`/`docs`/`polish`/`build` types are usually acceptable to leave
   ticketless; call those out separately from feature/fix commits that *should* have a ticket.

## Step 4 — Report

Output a concise report:

- A one-line headline (e.g. "7 issues drifted, 12 untracked commits (3 fix/feat)").
- A table per category 1–3 with `AQU-###`, status, the matching commit `%h %s`, and the
  suggested action.
- Category 5 split into "should have had a ticket" (fix/feat/refactor) vs "fine without"
  (chore/docs/polish/build).
- End with the **explicit next actions** and who owns them (status advances are QA/dev-lead
  calls; you do not move issues unless the user asks).

Do **not** mutate the board or git. This is read-only — its job is to make drift visible.

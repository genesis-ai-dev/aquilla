---
description: Reconcile the Linear board (team Aquilla, or one project) against what's actually merged to dev and shipped in production release tags — surface status drift and untracked commits
argument-hint: [<project name | P-AQU-###>] [--since <git-ref> | --tag <calver tag>]
---

You are running the **issue ↔ release reconciliation audit** for codex-web-app. The board
and the code drift apart: issues sit in a fixed/QA status while their code is (or isn't)
merged to `dev` or shipped to production, and some commits land with no ticket at all. This
command produces a drift report so the board can be made honest and the commit→ticket
mapping on release branches can be trusted.

Arguments: $ARGUMENTS

## Constants

- Linear team: `Aquilla` (id `de0f5d29-418f-4f62-ade7-02f77974c598`)
- Linear scope: the whole team by default — the `<Area> V1` projects under the **Road to V1**
  initiative plus `Prototype Debugging` (id `215cff7b-1a95-443d-9343-1f1528754462`, the
  maintenance bucket). Audit by team, not by project, or the V1 projects' issues are missed.
  If a project name or `P-AQU-###` is passed, scope Step 2 to that project only.
- Release flow (`docs/DEPLOYMENT-ENVIRONMENTS.md` → "Cutting a release",
  `e2e/journeys/QA-BOT-REGIMEN.md`): `PR → dev → release/YYYY/MM/DD[-NN] → prod + tag YYYY.MM.DD.NN`.
  **`main` is retired** — it stopped moving when release branches started. Never use it as a baseline.
- Two baselines:
  - **Merged** = `origin/dev` (the trunk).
  - **In production** = the newest calver tag (`YYYY.MM.DD.NN`, override with `--tag`). The tag
    sits on a release branch and may carry hotfix cherry-picks that are not on `dev`, so read
    the tag's own history, not `dev`'s.
- Status pipeline:
  `Triage → Backlog → Todo → Dispatched → Fixed → Ready for QA → Awaiting Deployment → Deployed/Done`
  - `Fixed` / `Ready for QA` = code on a ticket branch or open PR, **not yet on `dev`**.
  - `Awaiting Deployment` = merged to `dev`, waiting for a release cut + deploy.
  - `Deployed`/`Done` = in a production tag.
  - **`Triage`**, `Backlog`, `Blocked`, `Dev Shaped Task` are expected to have **no** refs. Never
    flag them as drift unless code for them has shipped (category 3). Epics/umbrella issues
    referenced by many commits are not drift either.

## Step 1 — Gather ticket references

```sh
git fetch origin --tags --quiet
S=<scratchpad dir>
TAG=${TAG:-$(git for-each-ref --sort=-creatordate --format='%(refname:short)' 'refs/tags/[0-9][0-9][0-9][0-9].*' | head -1)}
git log -1 --format='%h %cs' "$TAG"     # report which tag you used
# Tickets in production
git log "$TAG" --no-merges --format='%s%n%b' | grep -oiE 'AQU-[0-9]+' | tr a-z A-Z | sort -u > $S/prod-tickets.txt
# Tickets merged to dev
git log origin/dev --no-merges --format='%s%n%b' | grep -oiE 'AQU-[0-9]+' | tr a-z A-Z | sort -u > $S/dev-tickets.txt
# Commits in production with NO ticket reference (window: --since, else since the previous tag)
PREV=$(git for-each-ref --sort=-creatordate --format='%(refname:short)' 'refs/tags/[0-9][0-9][0-9][0-9].*' | sed -n 2p)
git log "${SINCE:-$PREV}..$TAG" --no-merges --format='%h%x09%s%x09%b' | grep -ivE 'AQU-[0-9]+' > $S/untracked.tsv || true
```

For a single-project audit, narrow untracked commits to the paths that project owns
(e.g. `-- sync-worker/src/external* src/lib/agent` for Agents & Agent API).

## Step 2 — Pull the board

`list_issues` for the team (or the project, if one was passed), `limit: 250`, paging until
`hasNextPage` is false. Capture each issue's identifier + status.

## Step 3 — Cross-check and classify

For each issue, test membership in `prod-tickets.txt` and `dev-tickets.txt`, then classify:

1. **Status behind reality** — the board hasn't caught up:
   - `Fixed` / `Ready for QA` / `Awaiting Deployment` and the ticket is in the **prod tag** → should be `Deployed`.
   - `Fixed` / `Ready for QA` and the ticket is on **`dev`** (not prod) → should be `Awaiting Deployment`.
2. **Claimed shipped, no trace** — `Deployed`/`Done` but absent from the prod tag, or
   `Awaiting Deployment` but absent from `dev`. Investigate: the work may have shipped
   under another ticket's commits, or never shipped.
3. **Code shipped, board says not started** — ticket in `dev` or prod but the issue is
   `Todo` / `Dispatched` / `Backlog`. Flag loudly — but first check for a revert
   (`git log --grep 'Revert' --grep AQU-### --all-match`); a reverted feature is correctly not done.
4. **Expected in flight** — `Fixed` / `Ready for QA` not on `dev` yet, or `Awaiting
   Deployment` on `dev` but not in prod. Normal. Count only.
5. **Untracked commits** — everything in `untracked.tsv`. These break the release→ticket
   mapping. `chore`/`docs`/`build`/dependency bumps are usually fine ticketless; call those
   out separately from `feat`/`fix`/`refactor`/`security` commits that *should* have a ticket.

## Step 4 — Report

Output a concise report:

- The baselines used (`origin/dev` sha, prod tag + sha).
- A one-line headline (e.g. "7 issues drifted, 12 untracked commits (3 fix/feat)").
- A table per category 1–3 with `AQU-###`, status, the matching commit `%h %s`, and the
  suggested action.
- Category 5 split into "should have had a ticket" vs "fine without".
- End with the **explicit next actions** and who owns them (status advances are dev-lead /
  release-deployer calls; you do not move issues unless the user asks).

Do **not** mutate the board or git. This is read-only — its job is to make drift visible.

# The Deploy bot

What a bot does to cut a production release branch, written so any agent
(Grok's deploy bot, Claude Code, Codex) can follow it without judgment calls.
This is the whole of the job: **decide nothing, cut what the plan says, tell
QA where to look, stop.** Who reads the cut and who deploys it is set by
[QA-BOT-REGIMEN.md](QA-BOT-REGIMEN.md).

The Deploy bot never deploys and never touches production. It does not run
`pnpm run deploy:aquilla`, `scripts/tag-release.sh`, or
`scripts/record-github-deployment.mjs` — those are a person's job, always,
by policy (see "Deployment ownership" in
[DEPLOYMENT-ENVIRONMENTS.md](../../docs/DEPLOYMENT-ENVIRONMENTS.md)). If a
run of this playbook ever finds itself about to push to `production` or run
a deploy command, that is a bug in the playbook, not a step to take anyway —
stop and say so instead of proceeding.

## Input

- Nothing from a person. Every run starts cold: fetch, plan, act on what the
  plan says. There is no PR number or ticket to read first.
- A `GITHUB_TOKEN` with `contents: write` on this repo (to push a branch and
  post a commit comment) and read access to PR comments (the plan's walk
  lookup needs it — see `scripts/release-plan-walk.mjs`). Without a token,
  `scripts/release-plan.mjs` still runs but every non-docs/test PR reports
  `walk: unknown`, which holds; that is a degraded run, not a broken one.
- A clean local checkout with `origin` fetched. `git fetch origin --tags` is
  step 1, not a precondition to assume already done.

## Hard stops

Do not push a branch or post a comment. Stop and say why in one line.

- `node scripts/release-plan.mjs` exits non-zero, or its stdout doesn't
  parse as JSON. This is a checker bug — do not hand-roll the decision it
  was supposed to make.
- `cut` is `false`. This is the ordinary case, not a failure: a release is
  already in flight, or there's nothing new on `dev`. Say nothing at all,
  **except** a once-only warning if `openReleases` names a branch whose
  HEAD has carried no calver tag for more than
  `HOLD_NUDGE_HOURS` (4) hours — that means a held or forgotten release is
  stuck, and a person should look. Check the branch's tag timestamp before
  warning a second time for the same branch; do not repeat the nudge every
  poll.
- The named `branch` already exists on `origin`. The plan computes a fresh
  `-NN` suffix from `usedSuffixesToday`, so this means two bot runs raced,
  or a person already cut by hand. Do not overwrite it or push a `-NN+1`
  guess of your own; stop and say the collision.
- Pushing the branch is rejected for any reason (protected-branch rule,
  network error, stale local `dev`). Do not force-push, do not retry with
  `--force`, do not fall back to a different sha. Re-`fetch` and re-run the
  plan from scratch on the next poll instead.

**Not a hard stop:** `hold: true`. That's the plan correctly saying this
slice needs a person before it deploys — cut it and post the notes exactly
like an ordinary slice. The bot's job ends at the same place either way.

## Steps

1. `git fetch origin --tags` and `git fetch origin 'refs/heads/release/*:refs/remotes/origin/release/*'`.
   The plan reads `refs/remotes/origin/release/` and `20*` tags directly; a
   stale fetch is a stale plan.
2. Run `GITHUB_TOKEN=<token> node scripts/release-plan.mjs`. Parse the JSON.
   Do not second-guess `cut`, `hold`, `branch`, or `sha` — the rules live in
   `scripts/release-plan.mjs` on purpose, read them there if a result looks
   wrong, and fix the code, not the bot's judgment at run time.
3. If `cut` is `false`, stop (see Hard stops).
4. If `cut` is `true`:
   - `git branch <plan.branch> <plan.sha>` then `git push origin <plan.branch>`.
     The branch is cut from `plan.sha`, which is the last PR in the slice —
     **not** the current tip of `dev`; do not `git push origin dev:<plan.branch>`
     or otherwise substitute `dev`'s HEAD.
   - Build the release notes (template below) from `plan.prs`, `plan.areas`,
     and `plan.branch`.
   - Post the notes as a **commit comment** on `plan.sha` (`POST
     /repos/genesis-ai-dev/aquilla/commits/{sha}/comments`), not a PR
     comment, not an issue, not a new PR. The commit is on the new branch
     and reachable from it, so QA and whoever deploys both find it from
     `git log` or the GitHub commit view without hunting for a separate
     artifact.
5. Done. Do not poll for the deploy, do not wait for a tag, do not follow up
   on this release again — the next thing that happens to it happens
   without this bot, per [QA-BOT-REGIMEN.md](QA-BOT-REGIMEN.md) §3.

## Release notes template

Identical to the one in [QA-BOT-REGIMEN.md](QA-BOT-REGIMEN.md); repeated
here because this is what actually gets posted.

```
## Release release/2026/09/24-02 · 4 PRs · areas: sync

| PR | Title | Walk @ head sha | Areas |
| --- | --- | --- | --- |
| #771 | Remove Inworld companion preset | PASS | — |
| #772 | Comment thread polish | PASS | sync |
| #773 | Export raw mode fix | FLAKY | — |
| #774 | Retention tab copy | none (docs only) | — |

Needs a human: #773 (walk not conclusive).
```

- Title line: `## Release <plan.branch> · <plan.prs.length> PRs · areas: <plan.areas joined by ", ", or omit "areas:" entirely if plan.areas is empty>`.
  Note `plan.prCount` is a different number — the total unreleased PRs on
  `dev` at plan time, not this slice's size. Use `plan.prs.length`.
- One table row per PR in `plan.prs`, oldest first (the plan already returns
  them in that order). "Title" is the PR's title, fetched from the GitHub
  API — the plan itself doesn't carry it. "Walk @ head sha" is `pr.walk`
  verbatim: `PASS`, `none`, `fail` (any of PR-BOT.md's FAIL/FLAKY/BLOCKED
  normalize to this — write `fail`, not the original verdict, unless you
  looked it up yourself from the PR's own walk comment), or `unknown` (no
  walk comment found yet, or the lookup had no `GITHUB_TOKEN` to run at
  all). "Areas" is `pr.areas.join(", ")` or `—`.
- "Needs a human" lists every PR whose `walk` is not `PASS` and not `none`
  (that is: `fail` or `unknown`), one per line,
  `#<number> (<reason if known, else "walk not conclusive">)`. Write "none"
  (the word, not an empty line) if every PR is `PASS`/`none`.
- If `hold` is `true`, add one line above the table: `**Held:** <reason>` —
  copy `plan.reason` verbatim. Do not editorialize on why it holds; the
  reason string already says (oldest PR holds, migration, infra, non-PASS
  walk).

## Say only what the plan measured

Same discipline as [PR-BOT.md](PR-BOT.md)'s "Say only what you measured" —
this bot has fewer ways to be wrong (it's reporting a deterministic JSON
result, not walking a UI) but the ones it has are worth naming:

- **Every field in the notes comes from the plan's JSON or the GitHub API
  fetched in this run, never from a previous run's memory.** A PR's title
  can change between when it merged and when a release finally cuts.
- **The sha in the notes is `plan.sha`, not the branch's current tip.**
  They're the same right after the cut but must never be assumed equal
  later — nothing should touch this branch again from this bot.
- **"Needs a human" is derived from `pr.walk`, never assumed from the PR's
  size or author.** A one-line PR can hold; a large PR can be `PASS`.

## What the comment is for

A person deciding whether to deploy this branch should not have to open
every PR in it. The commit comment is the whole of what they need to start:
which PRs are in, what each one's walk said, and which rows still need a
look. Nothing here is a sign-off — see
[QA-BOT-REGIMEN.md](QA-BOT-REGIMEN.md) §3 for who checks what before
`pnpm run deploy:aquilla` actually runs.

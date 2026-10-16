# Release cut

How a production release branch is cut. The **Release cut** workflow
(`.github/workflows/release-cut.yml`) does the whole job with no judgment
calls: **decide nothing, cut what the plan says, tell QA where to look,
stop.** Who reads the cut and who deploys it is set by
[QA-BOT-REGIMEN.md](QA-BOT-REGIMEN.md).

## When it runs

- **After every production deploy.** `pnpm run deploy:aquilla` ends with
  `scripts/tag-release.sh`, which pushes the calver tag once production
  serves the release. That tag push starts the workflow, so the next slice
  is cut the moment the in-flight release closes. GitHub reads a tag-push
  workflow from the tagged commit, so this applies to releases cut after
  the trigger reached `dev`.
- **When a person presses Run workflow** in GitHub Actions, or runs
  `gh workflow run release-cut.yml --ref dev`. Use it when a release branch
  was deleted instead of deployed (no tag, so nothing else starts a cut), or
  to look: tick **Show the plan without pushing a branch** to see what it
  would cut.

Nothing runs on a timer. A run that finds a release in flight names it in
the run summary and stops.

The workflow never deploys and never touches production. It does not run
`pnpm run deploy:aquilla`, `scripts/tag-release.sh`, or
`scripts/record-github-deployment.mjs`; those are a person's job, always,
by policy (see "Deployment ownership" in
[DEPLOYMENT-ENVIRONMENTS.md](../../docs/DEPLOYMENT-ENVIRONMENTS.md)). It
does not deploy even when the plan says `hold: false`.

## Hard stops

The workflow pushes no branch and posts no comment, and the run says why:

- `node scripts/release-plan.mjs` exits non-zero, or its output doesn't
  parse as JSON. This is a checker bug; fix the planner, never hand-roll
  the decision it was supposed to make.
- `cut` is `false`. This is the ordinary case, not a failure: a release is
  already in flight, or there's nothing new on `dev`. The run summary gives
  `plan.reason`.
- The named `branch` already exists on `origin`. The plan computes a fresh
  `-NN` suffix from `usedSuffixesToday`, so two runs raced or a person cut
  by hand. The run fails rather than overwrite it or guess a `-NN+1`.
- The push is rejected for any reason. The workflow never force-pushes and
  never falls back to another sha; run it again once the cause is fixed.

**Not a hard stop:** `hold: true`. That's the plan saying this slice needs a
person before it deploys. The slice is cut and the notes posted exactly like
an ordinary one.

## Steps

`scripts/release-cut.mjs` runs steps 3 and 4 from the plan's JSON.

1. Fetch tags and `release/*`. The plan reads
   `refs/remotes/origin/release/` and `20*` tags directly; a stale fetch is
   a stale plan.
2. Run `node scripts/release-plan.mjs` with the workflow's `GITHUB_TOKEN`,
   which the walk lookup needs (`scripts/release-plan-walk.mjs`). The rules
   live in the planner on purpose; if a result looks wrong, fix the code.
3. If `cut` is `false`, stop.
4. If `cut` is `true`, push `plan.sha` to `plan.branch`. That sha is the
   last PR in the slice, or `plan.floor` (the newest `dev` commit
   production already runs) when the slice ends behind it; never the tip
   of `dev`. Then post the release notes (template below) as a **commit
   comment** on `plan.sha`, where QA and whoever deploys both find it.

## After the cut: smart Jev, then a person

The workflow does not start Jev and does not read its result. The push that
creates `plan.branch`, and every later push onto that branch, is what starts
the one Hetzner run. The webhook accepts `push` events for
`refs/heads/release/YYYY/MM/DD-NN` and ignores pull requests. See
[smart-testing-webhook.md](../../docs/runbooks/smart-testing-webhook.md).

The HEAD Jev tests is not always `plan.sha`. When `hold` is true, a person
checks that pull request and ready pull requests are added onto the branch.
Jev runs after that pile-on. Only a result for the branch's current HEAD counts. A comment on an older commit does not decide the deploy.

- **FAIL** (a journey verdict of `FAIL (model-free check)` or `PRODUCT FAILURE`)
  means that HEAD does not deploy. A new commit on the branch starts Jev again.
- **PASS**. `INCONCLUSIVE` and `HARNESS UNAVAILABLE` do not hold. A person deploys, then tags production.

Adversarial Jev is not part of this cut. It attacks deployed `dev` at 09:00 UTC
and files Linear tickets. It does not affect the cut or the deploy.

## Release notes template

Identical to the one in [QA-BOT-REGIMEN.md](QA-BOT-REGIMEN.md); repeated
here because this is what actually gets posted.

```
## Release release/2026/09/24-02 · 4 PRs · areas: sync

| PR | Title | Walk @ head sha | Areas |
| --- | --- | --- | --- |
| #771 | Remove Inworld companion preset | PASS | — |
| #772 | Comment thread polish | PASS | sync |
| #773 | Export raw mode fix | fail | — |
| #774 | Retention tab copy | none (docs only) | — |

Needs a human: #773 (walk fail).
```

- Title line: `## Release <plan.branch> · <plan.prs.length> PRs · areas: <plan.areas joined by ", ", or omit "areas:" entirely if plan.areas is empty>`.
  Note `plan.prCount` is a different number — the total unreleased PRs on
  `dev` at plan time (a PR the tagged release tip already carries as a
  cherry-pick counts as released), not this slice's size. Use
  `plan.prs.length`.
- One table row per PR in `plan.prs`, oldest first (the plan already returns
  them in that order). "Title" is the PR's title, fetched from the GitHub
  API — the plan itself doesn't carry it. "Walk @ head sha" is `pr.walk`
  verbatim: `PASS`, `none`, `fail` (any of PR-BOT.md's FAIL/FLAKY/BLOCKED
  normalize to this), or `unknown` (no walk comment found yet, or the
  lookup had no `GITHUB_TOKEN` to run at all). `none` prints as
  `none (docs only)`. A title the API can't return prints as
  `(title unavailable)` rather than failing the cut. "Areas" is `pr.areas.join(", ")` or `—`.
- "Needs a human" lists every PR whose `walk` is not `PASS` and not `none`
  (that is: `fail` or `unknown`) on one line, as `#<number> (walk <walk>)`
  separated by commas. It reads `none` if every PR is `PASS`/`none`.
- If `hold` is `true`, add one line above the table: `**Held:** <reason>` —
  copy `plan.reason` verbatim. Do not editorialize on why it holds; the
  reason string already says (oldest PR holds, migration, infra, non-PASS
  walk).

## Say only what the plan measured

Same discipline as [PR-BOT.md](PR-BOT.md)'s "Say only what you measured" —
the workflow has fewer ways to be wrong (it's reporting a deterministic JSON
result, not walking a UI) but the ones it has are worth naming:

- **Every field in the notes comes from the plan's JSON or the GitHub API
  fetched in this run, never from a previous run's memory.** A PR's title
  can change between when it merged and when a release finally cuts.
- **The sha in the notes is `plan.sha`, not the branch's current tip.**
  They're the same right after the cut but must never be assumed equal
  later: the workflow never touches this branch again.
- **"Needs a human" is derived from `pr.walk`, never assumed from the PR's
  size or author.** A one-line PR can hold; a large PR can be `PASS`.

## What the comment is for

A person deciding whether to deploy this branch should not have to open
every PR in it. The commit comment is the whole of what they need to start:
which PRs are in, what each one's walk said, and which rows still need a
look. Nothing here is a sign-off — see
[QA-BOT-REGIMEN.md](QA-BOT-REGIMEN.md) §3 for who checks what before
`pnpm run deploy:aquilla` actually runs.

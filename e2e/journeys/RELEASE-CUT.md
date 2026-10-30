# Release cut

How a production release branch is cut. The **Release cut** workflow
(`.github/workflows/release-cut.yml`) does the whole job with no judgment
calls: **decide nothing, cut what the plan says, tell QA where to look,
stop.** Who reads the cut and who deploys it is set by
[QA-BOT-REGIMEN.md](QA-BOT-REGIMEN.md).

## When it runs

- **On the hour** (`:05`). The hourly release line
  (`docs/RELEASE-RISK-GATES.md`): with no release in flight and ready PRs
  on `dev`, the next slice is cut; `release-deploy.yml` deploys it at
  `:45` once `release-verify` and smart Jev have reported on its HEAD.
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

A run that finds a release in flight names it in the run summary and
stops.

The workflow never deploys and never touches production. It does not run
`pnpm run deploy:aquilla`, `scripts/tag-release.sh`, or
`scripts/record-github-deployment.mjs`. Those run from
`release-deploy.yml` on the hour once the repository variable
`HOURLY_RELEASE` is `on`, and from a person's checkout otherwise (see
"Deployment ownership" in
[DEPLOYMENT-ENVIRONMENTS.md](../../docs/DEPLOYMENT-ENVIRONMENTS.md)).

## Hard stops

The workflow pushes no branch and posts no comment, and the run says why:

- `node scripts/release-plan.mjs` exits non-zero, or its output doesn't
  parse as JSON. This is a checker bug; fix the planner, never hand-roll
  the decision it was supposed to make.
- `cut` is `false`. This is the ordinary case, not a failure: a release is
  already in flight, there's nothing new on `dev`, or every unreleased PR
  is held. The run summary gives `plan.reason`.
- The named `branch` already exists on `origin`. The plan computes a fresh
  `-NN` suffix from `usedSuffixesToday`, so two runs raced or a person cut
  by hand. The run fails rather than overwrite it or guess a `-NN+1`.
- The push is rejected for any reason. The workflow never force-pushes and
  never falls back to another sha; run it again once the cause is fixed.

**Not a hard stop:** a held PR. Held PRs are skipped by the cut, listed in
the notes with why, and wait for a person's `release:approved` label. A
pick that conflicts is aborted and joins the held list as `pick conflict`;
the cut goes on with the rest.

## Steps

`scripts/release-cut.mjs` runs steps 3 and 4 from the plan's JSON.

1. Fetch tags and `release/*`. The plan reads
   `refs/remotes/origin/release/` and `20*` tags directly; a stale fetch is
   a stale plan.
2. Run `node scripts/release-plan.mjs` with the workflow's `GITHUB_TOKEN`,
   which the walk lookup needs (`scripts/release-plan-walk.mjs`). The rules
   live in the planner on purpose; if a result looks wrong, fix the code.
3. If `cut` is `false`, stop.
4. If `cut` is `true`, start `plan.branch` at `plan.base` (the tagged tip
   production runs) and `git cherry-pick -x` every PR in `plan.prs` onto
   it, in order (`-m 1` for a merge commit). Push the result. Then post
   the release notes (template below) as a **commit comment** on the
   branch HEAD, where QA and whoever deploys both find it. The branch is
   never the tip of `dev`: it is production plus exactly the picked PRs.

## After the cut: release-verify, smart Jev, then the hourly deploy

The workflow does not start Jev and does not read its result. The push that
creates `plan.branch`, and every later push onto that branch, is what starts
the one Hetzner run and the `release-verify` workflow (the full suite:
typecheck, lint, every unit and worker test, the production build).
`release-deploy.yml` reads both for the branch's current HEAD at `:45`
(`scripts/release-deploy-check.mjs`) and deploys when `release-verify`
succeeded and Jev reported anything but FAIL; no Jev result yet means it
waits an hour. The webhook accepts `push` events for
`refs/heads/release/YYYY/MM/DD-NN` and ignores pull requests. See
[smart-testing-webhook.md](../../docs/runbooks/smart-testing-webhook.md).

The HEAD Jev tests is not always the cut's HEAD: a person may pick a fix
onto the branch. Jev and `release-verify` run again on that push. Only a
result for the branch's current HEAD counts. A comment on an older commit
does not decide the deploy.

- **FAIL** (a journey verdict of `FAIL (model-free check)` or `PRODUCT FAILURE`)
  means that HEAD does not deploy. A new commit on the branch starts Jev again.
- **PASS**. `INCONCLUSIVE` and `HARNESS UNAVAILABLE` do not hold. The hourly
  deploy (or a person) deploys, then tags production.

Adversarial Jev is not part of this cut. It attacks deployed `dev` at 09:00 UTC
and files Linear tickets. It does not affect the cut or the deploy.

## Release notes template

```
## Release release/2026/10/30-02 · 3 PRs · areas: sync

| PR | Title | Walk @ head sha | Areas |
| --- | --- | --- | --- |
| #771 | Remove Inworld companion preset | PASS | — |
| #772 | Comment thread polish | PASS | sync |
| #774 | Retention tab copy | none (docs only) | — |

**Held, not in this release:** #773 (walk fail), #775 (touches migration), #776 (pick conflict).
A held PR joins the next cut once it carries the `release:approved` label.
```

- Title line: `## Release <plan.branch> · <plan.prs.length> PRs · areas: <plan.areas joined by ", ", or omit "areas:" entirely if plan.areas is empty>`.
  Note `plan.prCount` is a different number — the total unreleased PRs on
  `dev` at plan time (a PR the tagged release tip already carries as a
  cherry-pick counts as released), not this slice's size. Use
  `plan.prs.length`.
- One table row per picked PR, oldest first (the plan already returns
  them in that order). "Title" is the PR's title, fetched from the GitHub
  API — the plan itself doesn't carry it. "Walk @ head sha" is `pr.walk`
  verbatim: `PASS`, `none`, or (only on an approved PR) `fail` /
  `unknown`. `none` prints as `none (docs only)`. A title the API can't
  return prints as `(title unavailable)` rather than failing the cut.
  "Areas" is `pr.areas.join(", ")` or `—`.
- The **Held** line lists every PR in `plan.held` plus every pick that
  conflicted, as `#<number> (<why>)` separated by commas, followed by the
  fixed sentence about `release:approved`. Omit both lines when nothing
  is held. `why` is `touches <areas>`, `walk <verdict>`, or `pick
  conflict`; copy it verbatim.

## Say only what the plan measured

Same discipline as [PR-BOT.md](PR-BOT.md)'s "Say only what you measured" —
the workflow has fewer ways to be wrong (it's reporting a deterministic JSON
result, not walking a UI) but the ones it has are worth naming:

- **Every field in the notes comes from the plan's JSON or the GitHub API
  fetched in this run, never from a previous run's memory.** A PR's title
  can change between when it merged and when a release finally cuts.
- **The comment sits on the HEAD the cut pushed, not the branch's current
  tip.** They're the same right after the cut but must never be assumed
  equal later: the workflow never touches this branch again.
- **"Held" is derived from the merged diff, the walk and the label, never
  from the PR's size or author.** A one-line PR can hold; a large PR can
  be ready.

## What the comment is for

A person reading this branch should not have to open every PR in it. The
commit comment is the whole of what they need to start: which PRs are in,
what each one's walk said, and which PRs were left out and why. Nothing
here is a sign-off — the deploy gate is `release-verify` plus Jev on this
HEAD (`scripts/release-deploy-check.mjs`), and a held PR's sign-off is the
`release:approved` label on that PR.

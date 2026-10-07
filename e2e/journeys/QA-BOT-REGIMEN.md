# QA and bot regimen

How a change gets from a pull request to production with the least human
friction. The rule under all of it: **check each change once, as close to the
change as possible, and carry the evidence forward.** Nobody re-checks what a
bot already proved. Humans spend their attention on taste and on what the bots
could not prove.

Related: [PR-BOT.md](PR-BOT.md) (how a PR is walked),
[DEPLOY-BOT.md](DEPLOY-BOT.md) (how a release branch is cut),
[DEPLOYMENT-ENVIRONMENTS.md](../../docs/DEPLOYMENT-ENVIRONMENTS.md) (branches,
deploy commands, calver tags).

## The line

```
PR ──walk PASS, ci green, not on hold, base dev, not stacked──▶ dev
        │
        ├─ each day, adversarial Jev attacks deployed dev and files Linear tickets
        │
        └─ release plan cuts ──▶ release/YYYY/MM/DD-NN
                └─ smart Jev on the current HEAD ──▶ a person deploys ──▶ prod + tag
```

| Stage | Who acts | Gate |
| --- | --- | --- |
| PR → `dev` | Grok bot, or a Claude automation | Walk `PASS` at the head sha, `ci.yml` green, label is not `on hold`, base is `dev`, not stacked on an open parent. |
| `dev` → release branch | Deploy bot | `node scripts/release-plan.mjs` says `cut: true`. |
| Release HEAD → deploy | A person, after smart Jev | A smart-Jev `FAIL` holds that HEAD. `PASS`, inconclusive, and harness unavailable do not. |
| Release → prod | Kieran or Matthew | Always a person — see "Deployment ownership" in [DEPLOYMENT-ENVIRONMENTS.md](../../docs/DEPLOYMENT-ENVIRONMENTS.md). |

## 1. Pull request: walk PASS, then ci.yml

GitHub Actions does not click merge. GitHub's auto-merge checkbox cannot read
the `on hold` label or a stacked parent, so it is not the merger.

The Grok bot (or a Claude automation) may merge a pull request into `dev` when
all of these hold at the pull request's **current head sha**:

- The bot walk comment ([PR-BOT.md](PR-BOT.md)) is **PASS** for that sha.
- The review agent has no unresolved finding it could prove (a failing test, a
  reproduced bug). Unproven suspicions do not block.
- The `ci.yml` jobs are green: lint (including `i18n:check` and the secret
  scan), unit tests, worker tests, and `pnpm neon:check`.
- The pull request does not have the label `on hold`.
- The base is `dev`.
- The pull request is not stacked on an open parent. A base that is another
  open pull request's head is stacked; leave it open.

Evidence is pinned to the sha. A push after the walk makes the evidence stale;
walk again before merging. A push after `ci.yml` makes that run stale too; wait
for the new run.

**Inconclusive is a checker bug, not QA work.** A `FLAKY` or `BLOCKED` walk means
the bot could not prove the effect. Fix the journey's outcome check (read the
API or the DOM state directly) so the next walk is conclusive. Do not hand the
item to a human to "just look at it", and do not merge it.

`scripts/release-plan.mjs` reads the same walk comment later and holds a cut
unless the walk is `PASS` or `none`.

Branch protection on `dev` requires those `ci.yml` jobs. The Cloudflare preview
can stay required. Admins are exempt today (`enforce_admins` is false). The
trial only works if that account does not merge around a red check.

## 2. Cutting a release: one in flight, no ceiling

The Deploy bot's only job is cutting the branch — it never deploys, and it
never touches production. Full step-by-step mechanics, hard stops, and the
comment template are in [DEPLOY-BOT.md](DEPLOY-BOT.md); the summary:

1. `git fetch origin --tags` and fetch `release/*`.
2. Run `node scripts/release-plan.mjs`. It returns JSON: `cut`, `hold`,
   `reason`, `branch`, `sha`, `areas`, and the PRs in the slice. Do not
   second-guess it; the rules are in code on purpose.
3. If `cut` is false, stop. Post nothing, except a once-only warning for a
   held branch with no tag after 4 hours.
4. If `cut` is true, create the named `branch` at the named `sha` — not the
   tip of `dev` — push it, and post the release notes below as a comment
   on that commit, where QA and the deployer both find it.

Deploying is always a person's call (see "Deployment ownership" in
[DEPLOYMENT-ENVIRONMENTS.md](../../docs/DEPLOYMENT-ENVIRONMENTS.md)).
`hold` does not change who deploys; it changes how much a person checks
first (§3) before running `pnpm run deploy:aquilla` themselves.

The plan's rules:

- **One release in flight.** A release branch whose HEAD has no calver tag is
  waiting for QA or deploy; no new cut happens until it ships or is deleted.
  New merges roll into the next release instead of piling onto this one. The
  release branch is the freeze; `dev` keeps moving.
- **No queue, no ceiling.** The instant the in-flight release closes, the
  next slice cuts at whatever's ready in `dev` right then — however many PRs
  that is. Waiting for a fixed count or a clock only means a hotfix
  cherry-picked onto the closed branch has to be re-cherry-picked onto every
  slice cut before `dev` catches up; cutting immediately means `dev` already
  carries the fix.
- **A PR holds** when it touches a migration or the deploy machinery itself
  (see `HOLDING_AREAS` in `scripts/release-plan.mjs`), or when its walk is
  anything other than `PASS` or `none`. The oldest waiting PR holding cuts it
  alone, immediately, with `hold: true`. A holding PR behind an already-ready
  run ships that run immediately instead of waiting for it.
- **Released means picked, and no cut goes below production.** A release
  branch is cherry-picks of `dev` merges, so the calver tag is not on `dev`.
  The plan treats a `dev` PR as released once the tagged tip carries its
  pick (the `(cherry picked from commit …)` line in the body, or the same
  `Merge pull request #N` subject), and reports `floor`, the newest `dev`
  commit production runs. A slice never cuts below `floor`: PRs older than
  a hotfix that went out ahead of them ship together, at `floor`, and hold
  together if any one of them holds.
- **Sync and auth are noted, not held.** A PR touching `sync-worker/src/`,
  `src/lib/sync/`, `db/shim/`, or `auth-worker/src/` ships in the ordinary
  slice; its area is listed in `areas` so a person can see it.
- **Smart Jev runs the current release HEAD, after any pile-on, before a
  person deploys.** The HEAD Jev tests is not always the sha the plan cut.
  When the slice is held, a person checks that pull request and ready pull
  requests are added onto the branch. Jev runs after that pile-on. Only a result for the branch's current HEAD counts. A `FAIL` means that HEAD does not deploy: push a new commit, and Jev runs again. `INCONCLUSIVE` and `HARNESS UNAVAILABLE` do not hold. The Hetzner service starts from a push
  to `refs/heads/release/YYYY/MM/DD-NN`. See
  [smart-testing-webhook.md](../../docs/runbooks/smart-testing-webhook.md).
- **Adversarial Jev does not affect the cut or the deploy.** Once a day, at
  09:00 UTC, it attacks deployed `dev` and files Linear tickets. It does not
  run on pull requests, on a release preview, or on production. A release
  preview writes to the shared dev database, and a preview sync worker cannot
  call a preview auth worker. Smart Jev is the release run because the
  Hetzner stack boots app, auth, and sync with a fresh database.

### Release notes template

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

"Walk @ head sha" is the PR bot's status for the PR's own final head sha, not
the merge commit that landed on `dev` — the bot's walk comment is posted
against the PR, before it merges. Anything other than PASS or `none` goes in
"Needs a human". Docs-only or test-only PRs may be `none` without needing a
human.

## 3. Smart Jev, then a person deploys

Every slice waits for smart Jev on the branch's **current HEAD**, then for a
person to run the deploy command. `hold` changes what happens before that run.

A held slice (`hold: true`) is cut as that pull request alone. A person checks
it, then ready pull requests are added onto the branch. That pile-on moves
HEAD. Jev's result for the cut sha does not count. Jev runs the new HEAD.

An ordinary slice (`hold: false`) is already the HEAD people would deploy.
The push that cuts it starts Jev. There is no pile-on.

Read the commit comment on that HEAD (`<!-- aquilla-smart-tests -->`):

- **FAIL** — a journey verdict of `FAIL (model-free check)` or `PRODUCT FAILURE`.
  That HEAD does not deploy. A new commit starts Jev again.
- **PASS**, **INCONCLUSIVE**, and **HARNESS UNAVAILABLE** do not hold the
  deploy. A person deploys, then the tag is applied to production.

A held slice, before the pile-on, is also where a person checks **only**:

1. Rows listed under "Needs a human".
2. For a migration or deploy-infra hold: that the change is safe for the
   previous release's code still running in production, and, where the slice
   also carries a sync or auth area, the interaction between them.
3. Taste: does anything in this batch feel wrong, off-brand, or confusing?

QA does **not** re-walk PASS rows. If QA finds itself repeating a check, that
check belongs in a journey; file it so the bot does it next time.

Do not deploy a HEAD whose smart-Jev comment is **FAIL**. Deploy from a clean
checkout of the release branch, checked out by name (not
a detached HEAD — the branch guard and the tag script both need it), with
`pnpm run deploy:aquilla`. It refuses to publish if prod has pending
migrations, and it tags the verified deploy `YYYY.MM.DD.NN`. That tag ends
the release's "in flight" state, so the bot can cut the next one.

## 4. Stop the line

Anyone may stop a release. Stopping is cheap and expected, never blame.

- **Before deploy:** push a fix to the release branch (cherry-pick from `dev`
  when it is already fixed there), or drop the release: delete the untagged
  branch and let the bot cut again after the fix merges to `dev`.
- **After deploy:** roll back first, then diagnose. A hotfix is a
  cherry-pick onto the branch that was deployed; redeploying tags the next
  `NN` in that date's series, independent of the branch's own `-NN` suffix.
- Every stop gets a follow-up: which check should have caught it? Add that
  check to a journey or a test, so the same class of problem is caught at the
  PR next time.

## What humans own

- **Taste:** what the product should feel like. This is not automatable.
- **The stop button:** at any stage.
- **The checks themselves:** QA designs and grows the journey scenarios
  (`e2e/journeys/*.md`). Every repeated manual check becomes a journey.

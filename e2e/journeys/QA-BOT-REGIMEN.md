# QA and bot regimen

How a change gets from a pull request to production with the least human
friction. The rule under all of it: **check each change once, as close to the
change as possible, and carry the evidence forward.** Nobody re-checks what a
bot already proved. Humans spend their attention on taste and on what the bots
could not prove.

Related: [PR-BOT.md](PR-BOT.md) (how a PR is walked),
[DEPLOYMENT-ENVIRONMENTS.md](../../docs/DEPLOYMENT-ENVIRONMENTS.md) (branches,
deploy commands, calver tags).

## The line

```
PR ──walk + review──▶ dev ──bot cuts──▶ release/YYYY/MM/DD-NN ──ordinary: bot deploys──▶ prod + tag YYYY.MM.DD.NN
                                                              └─held: a person deploys──┘
```

| Stage | Who acts | Gate |
| --- | --- | --- |
| PR → `dev` | Agents (merge themselves) | Evidence below. No required human reviewer. |
| `dev` → release branch | Release bot | `node scripts/release-plan.mjs` says `cut: true`. |
| Release → prod, ordinary slice | Release bot | `hold` is false. Runs `pnpm run deploy:aquilla` itself. |
| Release → prod, held slice | Kieran or Matthew | `hold` is true. Same command, run by a person. |

## 1. Pull request: verify once

An agent may merge its own PR into `dev` when all of these hold at the PR's
**current head sha**:

- The bot walk comment ([PR-BOT.md](PR-BOT.md)) is **PASS** for that sha.
- The review agent has no unresolved finding it could prove (a failing test, a
  reproduced bug). Unproven suspicions do not block.
- Required status checks are green.

Evidence is pinned to the sha. A push after the walk makes the evidence stale;
walk again before merging.

**Inconclusive is a checker bug, not QA work.** A FLAKY or BLOCKED walk means
the bot could not prove the effect. Fix the journey's outcome check (read the
API or the DOM state directly) so the next walk is conclusive. Do not hand the
item to a human to "just look at it". Every inconclusive result that reaches
QA is re-checking we chose not to automate.

## 2. Cutting a release: small slices, one in flight

The release bot runs on a schedule (a 15-minute poll, plus once right after
every deploy so a finished slice doesn't sit idle) and does only this:

1. `git fetch origin --tags` and fetch `release/*`.
2. Run `node scripts/release-plan.mjs`. It returns JSON: `cut`, `hold`,
   `reason`, `branch`, `sha`, `areas`, and the PRs in the slice. Do not
   second-guess it; the rules are in code on purpose.
3. If `cut` is false, stop. Post nothing, except a once-only warning for a
   held branch with no tag after 4 hours, or a queue behind an in-flight
   release that has grown past 7.
4. If `cut` is true, create the named `branch` at the named `sha` — not the
   tip of `dev` — push it, and post the release notes below where QA watches.
5. If `hold` is false, run `pnpm run deploy:aquilla` from a clean checkout of
   that branch, checked out by name. If `hold` is true, stop: a person
   deploys the same command when they are ready.

The plan's rules:

- **One release in flight.** A release branch whose HEAD has no calver tag is
  waiting for QA or deploy; no new cut happens until it ships or is deleted.
  New merges roll into the next release instead of piling onto this one. The
  release branch is the freeze; `dev` keeps moving.
- **Small slices.** Cut at 7 unreleased PRs, when the oldest has waited 24
  hours, or when the queue is draining (a tag just landed and more PRs are
  waiting). Small slices make each QA pass short and each rollback cheap.
- **A PR holds** when it touches a migration or the deploy machinery itself
  (see `HOLDING_AREAS` in `scripts/release-plan.mjs`), or when its walk is
  anything other than `PASS` or `none`. The oldest waiting PR holding cuts it
  alone, immediately, with `hold: true`. A holding PR behind an already-ready
  run ships that run immediately instead of waiting for it.
- **Sync and auth are noted, not held.** A PR touching `sync-worker/src/`,
  `src/lib/sync/`, `db/shim/`, or `auth-worker/src/` ships in the ordinary
  slice; its area is listed in `areas` so a person can see it.

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

## 3. QA at a held release: check the gaps, then ship

An ordinary slice (`hold: false`) deploys itself; QA's job there is the stop
button below, not a sign-off. A held slice (`hold: true`) waits for a person.
QA opens the release branch's preview and checks **only**:

1. Rows listed under "Needs a human".
2. For a migration or deploy-infra hold: that the change is safe for the
   previous release's code still running in production, and, where the slice
   also carries a sync or auth area, the interaction between them.
3. Taste: does anything in this batch feel wrong, off-brand, or confusing?

QA does **not** re-walk PASS rows. If QA finds itself repeating a check, that
check belongs in a journey; file it so the bot does it next time.

Deploy from a clean checkout of the release branch, checked out by name (not
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

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
PR ──walk + review──▶ dev ──bot cuts──▶ release/YYYY/MM/DD ──QA triggers──▶ prod + tag YYYY.MM.DD.NN
```

| Stage | Who acts | Gate |
| --- | --- | --- |
| PR → `dev` | Agents (merge themselves) | Evidence below. No required human reviewer. |
| `dev` → release branch | Release bot | `node scripts/release-plan.mjs` says `cut: true`. |
| Release → prod | QA (Kieran, Matthew) | Checks only the gaps, then `pnpm run deploy:aquilla`. |

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

## 2. Cutting a release: small batches, one in flight

The release bot runs on a schedule (hourly is fine) and does only this:

1. `git fetch origin --tags` and fetch `release/*`.
2. Run `node scripts/release-plan.mjs`. It returns JSON: `cut`, `reason`,
   `tier`, and the unreleased PRs with their risk `areas`. Do not second-guess
   it; the rules are in code on purpose.
3. If `cut` is false, stop. Post nothing.
4. If `cut` is true, create `release/YYYY/MM/DD` (today, UTC) from `origin/dev`,
   push it, and post the release notes below where QA watches.

The bot never deploys and never tags. The plan's rules:

- **One release in flight.** A release branch whose HEAD has no calver tag is
  waiting for QA or deploy; no new cut happens until it ships. New merges roll
  into the next release instead of piling onto this one. The release branch is
  the freeze; `dev` keeps moving.
- **Small batches.** Cut at 4 unreleased PRs, or when the oldest has waited 24
  hours. Small batches make each QA pass short and each rollback cheap.
- **Risk tier from paths.** A PR is high risk if it touches migrations, the
  sync engine, auth, or deploy infra (see `HIGH_RISK` in
  `scripts/release-plan.mjs`). The release is high risk if any PR is.

### Release notes template

```
## Release release/2026/09/24 · tier: low · 4 PRs

| PR | Title | Walk @ merged sha | Risk areas |
| --- | --- | --- | --- |
| #771 | Remove Inworld companion preset | PASS | — |
| #772 | Comment thread polish | PASS | — |
| #773 | Export raw mode fix | FLAKY | — |
| #774 | Retention tab copy | none (docs only) | — |

Needs a human: #773 (walk not conclusive).
```

"Walk @ merged sha" is the PR bot's status for the sha that merged. Anything
other than PASS goes in "Needs a human". Docs-only or test-only PRs may be
`none` without needing a human.

## 3. QA at release: check the gaps, then ship

QA opens the release branch's preview and checks **only**:

1. Rows listed under "Needs a human".
2. For a **high** tier release: the interactions between PRs in the risky
   areas (for example a migration plus a sync change), and that the migration
   is safe for the previous release's code.
3. Taste: does anything in this batch feel wrong, off-brand, or confusing?

QA does **not** re-walk PASS rows. If QA finds itself repeating a check, that
check belongs in a journey; file it so the bot does it next time.

Then:

- **Low tier:** deploy the same day. QA's job here is the stop button, not a
  sign-off.
- **High tier:** a person deploys it deliberately and watches the live checks.

Deploy from a clean checkout of the release branch with
`pnpm run deploy:aquilla`. It refuses to publish if prod has pending
migrations, and it tags the verified deploy `YYYY.MM.DD.NN`. That tag ends
the release's "in flight" state, so the bot can cut the next one.

## 4. Stop the line

Anyone may stop a release. Stopping is cheap and expected, never blame.

- **Before deploy:** push a fix to the release branch (cherry-pick from `dev`
  when it is already fixed there), or drop the release: delete the untagged
  branch and let the bot cut again after the fix merges to `dev`.
- **After deploy:** roll back first, then diagnose. Hotfixes are
  cherry-picks onto the same release branch; redeploying tags the next `NN`.
- Every stop gets a follow-up: which check should have caught it? Add that
  check to a journey or a test, so the same class of problem is caught at the
  PR next time.

## What humans own

- **Taste:** what the product should feel like. This is not automatable.
- **The stop button:** at any stage.
- **The checks themselves:** QA designs and grows the journey scenarios
  (`e2e/journeys/*.md`). Every repeated manual check becomes a journey.

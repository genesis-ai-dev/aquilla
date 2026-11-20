# 0014 — A release hold is a gate to build, not a label to add

*Decided and recorded 2026-11-19, from the release cut of that day. No Linear issue yet.*

## Context

The hourly release line (2026-10-30) keeps a merged PR out of production
while a person has to look at it. Three weeks in, production got one to three
releases a day against 13 to 25 PRs merged. Of the 47 PRs waiting on
2026-11-19, 36 were held because no one had walked them in a browser and 6
because of a risk area. The walks were missing because the walker could not
sign in to a preview, and people cleared the hold by labelling every PR
`release:approved` in batches. The line ran at the speed of the labelling,
and the label had stopped meaning that a person had looked.

## Decision

1. A PR is held only for an outcome that cannot be fixed forward. A missing
   or test-level walk is not one, so by default only a failed walk holds
   (`scripts/release-plan.mjs::walkHolds`). `WALK_POLICY=strict` is the
   earlier rule.
2. Each holding area has a gate, or a stated reason it cannot have one. A
   gate is a check on the PR's head that proves the area's outcome did not
   happen, named in `scripts/release-risk.mjs::AREA_GATES`. `infra` is the one
   area without a gate: the deploy machinery and the gates' own files.
3. A gate's checker and golden are `infra`, and where the checker is a script
   it runs from the base commit, so a PR cannot pass itself
   (`scripts/release-risk.mjs::classifyFiles`).
4. A gate whose green result makes the line do something new has a switch
   that is off until the new action is proven
   (`scripts/release-risk.mjs::GATE_SWITCHES`). The same holds for the
   rollback watch, which reports before it acts
   (`scripts/release-rollback.mjs::decideRollback`).
5. What ships unwalked is watched after it ships. A release that fails the
   watch is promoted back, and an open `release:halt` issue stops the line
   (`scripts/release-deploy-check.mjs::HALT_LABEL`).
6. A held PR is named once when it has waited four hours
   (`scripts/release-hold-nudge.mjs::holdNudge`).

## Consequences

- A week in which most PRs need `release:approved` is a broken or missing
  gate. The fix is that gate, in a PR of its own.
- A change to a gate's golden, to the planner's answer on the live queue, or
  to a migration statement off the additive list still goes to a person.
  That is the gate working: it has turned "review this PR" into "review this
  diff".
- An unwalked UI regression can reach production. It is bounded by the
  release slice's full suite, smart Jev, and the watch, and it is fixed
  forward.
- The file map and the gates are release machinery, so this record's own
  change shipped through `release:approved`.

## Not covered yet

- The rollback watch counts failed invocations. A handler that answers 500
  on purpose, and a wrong answer with a 200, are invisible to it.
- `AUTO_ROLLBACK` and `AUTO_MIGRATE` are off. The watch and the migration
  apply have not run against production.
- `qa-walk` reports on a PR and does not block a merge.
- `export` is noted, not holding. `docs/RELEASE-RISK-GATES.md` has the open
  item.

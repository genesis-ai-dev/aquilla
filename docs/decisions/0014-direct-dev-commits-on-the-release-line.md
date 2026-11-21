# 0014 — Direct dev commits on the release line

*Decided and recorded 2026-11-20. No Linear issue yet.*

## Context

A release branch is production's tagged tip plus cherry-picks of what merged
to `dev` since. The planner found that work by PR number: a first-parent
commit whose subject was not a PR merge was skipped. It was never picked,
never listed as held, and in no release notes.

Commits do reach `dev` without a PR. Two shell commits were pushed on
2026-11-09; a release branch went red four days later because it lacked
their version bump. From 2026-11-14 a job pushed a localization commit
most mornings, six by 2026-11-20: the locale catalogs and their
source-hash sidecar, with keys appended to every locale. The release line
never got those lines, so each later PR that appended locale keys
conflicted in the sidecar. On 2026-11-20 two approved PRs were listed as a pick conflict on
every hourly cut, and the hint could not name what they needed, because
what they needed was not a PR.

The job that pushes those commits is not in this repository.

## Decision

1. A direct commit is planned, in its dev position, like a PR merge.
   `scripts/release-plan.mjs::unreleasedPrs` returns it with `direct: true`,
   its sha and its subject. Only a direct commit that changes no file is
   left out: there is nothing to pick.
2. Its files decide whether it is ready. A commit that touches only
   generated locale catalogs, as `scripts/release-plan.mjs::isLocaleCatalogOnly`
   reads them, is picked by the cut with `git cherry-pick -x`, with no walk.
   The catalogs are generated data, the same commit lands every day, and
   the release branch's own suite runs the catalog check on the result.
3. Any other direct commit is held with the reason
   `scripts/release-plan.mjs::NOT_A_PR`, and is listed on every cut until a
   person acts. `scripts/release-plan.mjs::prHolds` reads no walk, no gate
   and no label for a direct commit: none of them can exist without a PR.
4. A person releases a held direct commit by picking it onto a release
   branch with `git cherry-pick -x`. The pick is the sign-off. The steps
   are in `docs/RELEASE-RISK-GATES.md`, section 3.
5. Production carries a direct commit when the tagged tip has its
   `(cherry picked from commit <sha>)` line, which
   `scripts/release-plan.mjs::releasedMarks` reads. A PR has a second key,
   the number in its subject. A direct commit has only this one.
6. A pick that conflicts can name a held direct commit as what it needs:
   `scripts/release-cut.mjs::dependencyHint` answers with its short sha.

## Consequences

- A catalog-only commit ships with no person and no walk. That is as much
  trust as a docs-only PR gets, on a path check alone. The check is by
  file name; it does not read what the commit wrote into a catalog.
- A held direct commit is repeated in every cut's notes. That is the
  intent: before this record the same commit was repeated nowhere.
- Releasing one means a person pushes to a release branch. There is no
  label to click.
- A direct commit picked by hand without `-x` is not seen as released. The
  cut tries it again, or lists it again, until someone records it.
- `plan.prs` and `plan.held` now hold entries without a `number`. Anything
  that reads the plan has to name an entry through
  `scripts/release-plan.mjs::entryLabel`, not by number.
- The walk lookup skips direct commits
  (`scripts/release-plan-walk.mjs::fillWalks`), so a PR that GitHub happens
  to associate with the sha can never lend the commit its approval.

## Not covered yet

- An approval for a direct commit that does not need a push to a release
  branch, such as a trusted comment on the commit.
- Dismissing a direct commit that should never ship. Today that is a pick
  of the commit and of its revert, or a hand-written marker for each.
- Direct commits that touch only docs or tests. They are held like any
  other; only locale catalogs are picked.
- A plan made while a release is in flight lists nothing as held, so a
  direct commit pushed after a cut first appears in the next cut's notes.
- A direct merge commit hides the first-parent commits of the side it
  merged in, PR merges included. The merge itself is now listed as held;
  the PRs inside it are still not listed one by one.

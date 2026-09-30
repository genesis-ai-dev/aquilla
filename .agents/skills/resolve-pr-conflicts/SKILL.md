---
name: resolve-pr-conflicts
description: Resolve merge conflicts on a GitHub pull request in this repo - merge the PR's base branch (usually dev) into the PR branch from a scratch worktree, resolve, audit the merge for silent semantic breaks, verify, and push through the real gate. Use whenever the user asks to resolve or fix conflicts on a PR, "merge dev into PR 123", "get #123 mergeable", "bring this branch up to date with dev", "catch this PR up", or points at a PR GitHub shows as CONFLICTING - even when they only give a PR number or a branch name. Not for cherry-picking onto release branches, and not for reviewing a PR.
argument-hint: <pr-number> [--no-push]
---

# Resolve PR conflicts

Done means: the PR branch contains its base, GitHub reports it mergeable, the branch still does
what it set out to do, nothing the base landed was lost, and the push went through the normal
gate. The textual conflicts are usually the easy half. The reason this skill exists is the other
half: merges that come out textually clean and are still wrong.

`$SKILL` below is this skill's base directory (announced when the skill loads). The scripts live
in the main checkout, so call them by absolute path from the worktree.

## Ground rules

- **Merge the base into the branch. Never rebase or force-push a PR branch.** Other people and
  agents have these branches checked out and reviewed; rewriting them strands their work.
- **Work in a detached scratch worktree**, never the main checkout. Several sessions share the
  main checkout at once, so switching its branch or stashing there tramples someone else's work.
  The stash list is shared across all worktrees too - do not use `git stash` at all.
- **Stage files by name.** The worktree has untracked helper symlinks; `git add -A` commits them.
- **Being the base settles nothing.** Most disagreements have an answer that does not depend on
  which side is `dev`: structure yields to intent, a superset beats a subset, duplicate
  mechanisms collapse into the copy that has callers. When the two sides genuinely want
  different behaviour, what decides it is evidence that a side *meant* it - see "Deciding a real
  disagreement" - and when both sides meant it, the user decides, not you.
- **Attribute a failure before chasing it.** The base routinely carries its own red tests and
  type errors. A red you did not cause is reported, not fixed inside a merge commit.
- **Never `--no-verify`, never `neon:apply*`** without the user saying so for this PR.

If this session is already running in an app-made worktree of the PR branch itself, use the
`sync_with_base_branch` tool for the merge instead of steps 1-2, then continue from step 3.

## 1. Set up

```bash
"$SKILL/scripts/prepare-worktree.sh" <pr-number> "<scratchpad>/pr-<number>"
```

It fetches, refuses forks and closed PRs, creates a detached worktree at `origin/<head>`, warns
if the branch is checked out elsewhere or has unpushed local commits, previews which files will
conflict, and prints `HEAD_BRANCH`, `BASE_BRANCH`, `OLD_TIP`, `BASE_TIP`. Keep those values.

Heed the warnings: if another worktree holds the branch with uncommitted or unpushed work, a
push from here will diverge it - say so and ask before going on.

Before touching anything, read what the PR is for (`gh pr view <n>`, `git log --oneline
origin/<base>..HEAD`). You cannot judge a resolution without knowing the branch's intent.

## 2. Merge and resolve

```bash
cd "<scratchpad>/pr-<number>"
git -c merge.conflictStyle=zdiff3 merge --no-ff --no-commit origin/<base>
git diff --name-only --diff-filter=U
```

`zdiff3` puts the common ancestor inside each conflict, which shows what *each* side changed
rather than just two end states. For each side's reasoning: `git log --oneline --merge -- <file>`.
`--no-commit` keeps even a clean merge open, so the steps below are the same either way.

GitHub's CONFLICTING flag can be stale. If the merge is clean locally, carry on with steps 3-5
anyway - a clean merge still needs the audit.

How conflicts in this repo usually resolve:

| Shape | Resolution |
| --- | --- |
| Both sides appended (union types, event kinds, switch cases, `JOURNEYS.md`, test tables) | Keep both. |
| One side moved or refactored code the other edited in place | Keep the refactorer's structure and re-apply the other side's change inside it. Drop definitions that were relocated, not the behaviour. Works in both directions. |
| One side's version does everything the other's does and more | Take the superset. Verify it really is one - read both, do not assume the longer one is. |
| Both sides built the same thing (add/add, stacked slices whose parent already landed) | Take the copy that already has callers - normally the base's, because the base's other code adopted it since. Port any fix the losing copy has that the winner lacks. Then look for a leftover duplicate from the branch that auto-merged alongside it (double-firing handlers). |
| The sides want different behaviour, or their tests cannot both pass | A product question, not a merge question - see "Deciding a real disagreement" below. |
| `db/postgres/schema.sql` | Usually keep both; comments that cite a migration number follow the final filename. |
| Locale catalogs, `source-hashes.json`, `pnpm-lock.yaml` | Generated - see `references/traps.md`; do not hand-merge line by line. |
| Git reports a *binary* conflict on a source file | The file holds raw NUL bytes. Pull the stages (`git show :1:<f>`, `:2:`, `:3:`) and merge by hand; use `grep -a` to search it. |

### Deciding a real disagreement

Two sides that want different behaviour is a product decision that happened to surface in a
merge. Settle it with evidence of intent, never with the branch name.

1. **Find out whether each side meant it.** For the branch: its Linear ticket (the AQU number in
   the branch name), the PR body, its commit messages, and any test that asserts the behaviour.
   For the base: `git log --merge -- <file>` lists the commits behind its side of the conflict;
   read their messages and tickets and look for a test that pins the behaviour. A change with a
   ticket or test asking for it is *deliberate*. A side effect of a refactor, a rename, a
   generated file, a mechanical sweep, or something the branch merely carried forward from the
   old merge base is *incidental*.
2. **Deliberate beats incidental, on either side.** A branch that deliberately changed what the
   base only bumped in passing keeps its change. A base ticket that changed behaviour the branch
   only inherited wins, and the branch is re-applied on top of it. Say which in the commit message.
3. **A side that contradicts its own ticket or test is a bug, not a tie.** Keep the side that
   matches its own spec and report the bug. This is the only "one side is wrong" call you may
   make; a hunch that the other side's design is worse is not grounds.
4. **Both deliberate: stop and ask - after two checks.** Two tickets that disagree are not yours
   to arbitrate, but make sure they really do. First, trace the contested case through both
   sides' *code*, not their prose: a doc or commit message claiming behaviour that side's own
   code can never produce is step 3, and the question disappears. Second, check whether one
   ticket records a decision that supersedes the other (a later ticket often says so, and then
   the PR may need closing rather than merging). Otherwise put the question to the user in this
   shape:

   ```
   #<n> disagrees with <base> on <what>:
   - branch (AQU-A): <behaviour> - <its stated reason>
   - <base> (AQU-B, landed <date> in #<pr>): <behaviour> - <its stated reason>
   Keeping <base>'s drops <what the PR loses>; keeping the branch's undoes <what the base loses>.
   Which one - or should #<n> close as superseded?
   ```

5. **Neither deliberate, or you cannot tell.** If it changes user-visible behaviour, data
   written, or an API contract, ask - same shape, with "unclear" in place of the reasons. If it
   is naming, formatting or a log message, keep the base's for consistency with the surrounding
   code and list it in the report; this is the one place being the base counts, and only because
   it avoids churn.
6. **Tests that cannot both pass: work out whether it is a fixture collision or a real
   disagreement.** Ask what each test was written to pin.
   - *Fixture collision* - one side's test only passes through a case the other side
     deliberately changed, without being about it (its fixture happens to lack a self-test, a
     role, a setting), and real use never hits that combination. Settle it yourself: keep both
     claims, move the incidental fixture so its own claim is still exercised, and pin the
     changed case explicitly. List it in the report with both test names.
   - *Real disagreement* - both tests are about the same case and want opposite outcomes, or
     the case occurs in real use. Go to step 4.
   Either way, never get to green by deleting a test or weakening what an assertion claims.

Do not commit yet. The audit and the checks below may send you back into files git merged on its
own, and those fixes belong in the merge commit. Leave the merge in progress until step 4 ends.

## 3. Audit what git merged silently

```bash
"$SKILL/scripts/merge-audit.sh"
```

Act on each section:

1. **Files both sides changed.** These are the only places git can anchor one of the branch's
   hunks to the wrong spot. It happens when the base adds a block nearby containing lines
   identical to the branch's context: the branch's insertion slides onto the base's new block and
   nothing conflicts. `same lines` only proves nothing was dropped, so read each listed file's
   merged-vs-base diff (the script prints the command) and confirm every hunk of the branch sits
   at the site its author meant. `LINES CHANGED` is expected for files you resolved by hand and
   a red flag for ones you did not.
2. **Changes outside the overlap** - files only the branch changed whose diff moved, and files
   the branch never touched that now differ from the base. Should list nothing but edits you
   made on purpose; each one belongs in the commit message.
3. **Effective PR diff.** Compare it with what the PR claims. If it is empty or reduced to a
   test, the base has superseded the PR: stop and report that instead of pushing.
4. **Migrations.**
   - `DUPLICATE` - the base already has the same SQL under another number: `git rm` the
     branch's copy.
   - `PREFIX COLLISION` / sorts before the base's latest - renumber to the base's max + 1,
     skipping numbers other open PRs already claim, and fix every mention of the old number.
     Procedure and safety check in `references/traps.md`.
   - A branch migration that DROPs and re-ADDs a CHECK constraint, enum or allowlist carries the
     list as of the old merge base. Diff it against the base's newer migrations touching the same
     object and fold their additions in, or applying it erases them. The script cannot see this.

Then look for the semantic clashes no script catches - they surface in step 4, but knowing the
shapes saves time:

- Both sides added the same i18n key, or the branch still translates a key the base deleted.
- The base added a required field, union member or `Record<Kind, …>` table that the branch's
  new code or tests do not satisfy (and vice versa: the branch adds an event kind the base's
  exhaustive tables now reject).
- The base added prose - a runbook, a doc section, a code comment - describing wording or
  behaviour the branch changes. Grep the base's new text for the strings the branch renames; the
  merge makes that prose false and nothing fails to tell you.
- The base widened the situations in which the branch's hook or guard runs. If the branch's own
  rationale (ticket, PR body, the guard it already carries) answers whether the new cases are
  covered, apply that answer and say so in the commit message. If it does not, ask - that is a
  design extension, not a merge.

## 4. Verify, attributing every red, then commit

```bash
"$SKILL/scripts/link-deps.sh"
```

Run this once the conflicts are resolved so it sees the merged lockfiles. It symlinks the main checkout's
dependencies where the installed versions match, does a real install where they do not, and arms
the pre-push hook.

Scale the checks to the PR's effective diff (`git diff --name-only origin/<base> HEAD`):

- Root types: `npx tsc -b --noEmit` (about 30 s cold).
- Worker types, for each worker the diff touches - and all of them when `db/shared/` or
  `db/shim/` changed: `npx tsc --noEmit -p sync-worker/tsconfig.json` (likewise `auth-worker`,
  `agent-worker`). Root `tsc -b` does not cover the workers and CI never type-checks them, so
  this is the only place a broken worker type shows up. They carry standing errors: compare the
  error list with the base's, do not expect zero.
- Tests: the branch's own test files first (that is where slippage shows), then tests beside
  every file you resolved. Root: `pnpm exec vitest run <paths>`. Workers:
  `cd sync-worker && pnpm test <paths>`. Run suites one at a time - concurrent suites cause
  timeout flakes that look like regressions.
- `npx eslint --quiet <changed files>`; `pnpm i18n:check` if `src/lib/i18n/` changed;
  `pnpm neon:check` if `db/postgres/` changed.

Sort each failure into one of three buckets before doing anything about it:

- **The base's own** - identical on a clean base. Cheapest proof: the failing file is
  byte-identical to the base (`git diff --quiet origin/<base> HEAD -- <file>`). Otherwise make a
  baseline worktree (`git worktree add --detach "<scratchpad>/base-clean" origin/<base>`, run
  `link-deps.sh` in it) and run the same command there. Report it; do not fix it here.
- **The branch's own** - already failing at `OLD_TIP`, before the merge. Report it. Fix it only
  when trivial and unambiguous, in a separate commit.
- **Merge-induced** - neither of the above. This is yours: fix it.

Compare against a detached `origin/<base>` worktree, not the main checkout - the main checkout's
branch is often far behind.

When the checks are settled, re-run `merge-audit.sh` if you edited anything since, then commit.
Fixes the merge *needs* to be correct go in the merge commit and are named in its message. A fix
to the branch's own older problem goes in a separate commit afterwards.

```bash
git add <each resolved or fixed file, by name>
git commit -m "Merge origin/<base> into <head>" -m "<one line per conflict and per silent fix>"
```

Always pass `-m`: a bare `git commit` opens an editor and hangs.

## 5. Gate and push

Skip this step if the user passed `--no-push`; report the worktree path and commit instead.

```bash
git fetch origin <base> <head>
```

If the base advanced, merge it again (usually disjoint) and re-run the audit. If `origin/<head>`
moved, someone pushed to the PR: merge that in too rather than overwriting it.

Make sure Docker is up (`docker ps`; `open -a Docker` if not), then push in the background with
the output teed to a log - the gate takes several minutes:

```bash
git push origin HEAD:refs/heads/<head> 2>&1 | tee "<scratchpad>/pr-<number>-push.log"
```

The hook runs the secret scan, then the browser specs affected by everything being pushed. A
base merge pushes hundreds of files, so expect most of the smoke suite on two isolated stacks.
That is the intended cost; it runs beside a live `pnpm dev` without port clashes.

If `link-deps.sh` reported the hook as not armed, run the same gate by hand first:

```bash
pnpm run scan:secrets
E2E_PUSH_REFS="HEAD $(git rev-parse HEAD) refs/heads/<head> $(git rev-parse origin/<head>)" \
  pnpm run test:e2e:affected < /dev/null
```

When the gate goes red, open `references/traps.md` ("Gate failures") before debugging. In short:
every spec failing is environmental; a few failing deterministically get re-run alone on the
clean base first. If the base itself is red, the gate is blocked by something outside this PR -
report it and ask; bypassing is the user's call.

After the push:

```bash
gh pr view <pr-number> --json mergeable,mergeStateStatus,url
```

`UNKNOWN` means GitHub is still computing; check again shortly. `MERGEABLE` with `BLOCKED` means
checks are pending, not that a conflict remains.

If the resolution changed what the PR contains - a renumbered or removed migration, a dropped
slice - correct those statements in the PR body with `gh pr edit`. Change only what the merge
made false.

Finally remove the worktrees: `git worktree remove --force "<scratchpad>/pr-<number>"` (and the
baseline one). This deletes only the symlinks, not what they point at.

## 6. Report

Lead with the state, then only what the reader needs to trust it:

```
PR #<n> <title> - <MERGEABLE | still blocked: why>
Merged <base>@<short sha> as <merge sha>; pushed to <head>.

Conflicts (<count>)
- <file>: <one line - what each side did, what was kept>

Fixed beyond the markers
- <semantic clash, slipped hunk, migration renumber/removal - or "none">

Verification
- <command>: <result>
- Not mine: <red> - the base's own / the branch's own (how it was attributed)
- Gate: <n> specs, <pass/fail>

For you
- <migration to apply, PR claims now stale, sibling PRs needing the same rename, ties settled by
  step 2/3/5/6 of "Deciding a real disagreement" with which side won and why - or "nothing">
```

## Stop and ask instead of pushing

- The audit shows the PR is superseded, or resolving would drop the slice the PR exists for.
- Both sides deliberately want different behaviour and neither ticket records a decision that
  supersedes the other - or you cannot tell whether either side meant it and the difference is
  user-visible ("Deciding a real disagreement", steps 4-5).
- The gate is red for reasons outside the PR and the only way through is `--no-verify`.
- The branch has unpushed or uncommitted work in another worktree.
- A migration the branch ships has already been applied to a shared database under its old name
  (`references/traps.md`).
- The PR's base is not `dev` and the base itself conflicts with `dev` (a stack): resolve the
  base PR first, and confirm the order with the user.

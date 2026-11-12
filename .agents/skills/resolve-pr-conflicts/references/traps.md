# Traps

Read the section you need; nothing here is required for a merge that goes smoothly.

- [Generated files](#generated-files)
- [Renumbering a migration](#renumbering-a-migration)
- [Dependencies in a worktree](#dependencies-in-a-worktree)
- [Gate failures](#gate-failures)
- [Shell traps on this machine](#shell-traps-on-this-machine)

## Generated files

**`pnpm-lock.yaml` (root or a worker).** Take the base's version (`git checkout --theirs`), then
run the matching install so pnpm re-adds whatever the branch's `package.json` needs: root
`pnpm install`; workers `pnpm install --ignore-workspace` from inside the worker directory (they
are standalone packages - a plain install there walks up to the root and installs nothing).

**Locale catalogs (`src/lib/i18n/messages/<locale>.ts`).** One key per line, so they conflict
whenever either side adds or removes English keys. After resolving the text:

- `Catalog` is typed by the English keys, so a locale line for a key either side deleted is a
  type error in every locale file - and `tsc` reports only the *first* unknown key per file. Get
  the whole set by importing `en` and `CATALOGS` in a `tsx` one-off and filtering, then strip
  those lines from every catalog.
- A key both sides added is a duplicate-key type error, and at runtime the *last* duplicate wins.
  If the two strings serve different purposes keep both and rename the branch's key.
- The no-duplicates test fails when the branch drops an excepted key and adds a replacement with
  the same English text; it needs its own `DUPLICATE_EXCEPTIONS` entry.

**`src/lib/i18n/source-hashes.json`.** Per locale, `key -> hash of the English it was translated
from`. Resolve as a key-level union, the base's hash winning on overlap, and drop keys that no
longer exist. Re-serialise with `JSON.stringify(all, null, 2) + "\n"`; a byte-identical
round-trip proves there are no duplicate keys.

**`eslint-suppressions.json`.** Counts are per file and all-or-nothing: one violation over the
count un-suppresses every violation in that file. A branch can therefore appear to introduce
dozens of lint errors it did not write. Attribute by running eslint on the same files in the
baseline worktree and diffing the (file, rule, message) sets. Do not raise counts to make it pass.

## Renumbering a migration

Do this when `merge-audit.sh` reports a prefix collision or a migration that sorts before the
base's latest.

1. **Check it is still pending.** The runner records applied migrations by full filename, so a
   rename is only clean while the file has never been applied. Run `pnpm neon:status:dev` in the
   merge worktree *before* renaming: it holds the base's migrations plus the branch's, which is
   the only view that shows everything (the status only compares the ledger with the files in the
   checkout it runs from, so a stale checkout hides merged-but-unapplied migrations). The script
   reads credentials from the repo root's `.env`, which a worktree lacks - link it for this one
   command and remove it again (`ln -s "<main checkout>/.env" .env`, run, `rm .env`), because a
   lingering `.env` would change how the e2e stack builds. The branch's file must show as
   *pending*. If the old name is already in the ledger, stop and ask: the new name would re-apply
   it and the old row would be orphaned. Status is read-only; never run an apply.
2. **Pick the number.** The base's max + 1, skipping numbers other open PRs already add:
   `gh pr list --limit 400 --json number,headRefName` (the default cap of 100 truncates silently),
   then `git diff --name-only --diff-filter=A origin/<base>...origin/<head> -- db/postgres/migrations/`
   for the likely candidates.
3. **`git mv`** the file so it shows as a rename. Do not touch the SQL body.
4. **Fix every mention of the old number**:
   `git grep -nP "(?<![0-9.a-f])0NNN(?![0-9a-f])" -- ':!*.svg' ':!*lock*' ':!src/lib/i18n/source-hashes.json'`.
   Usual places: the migration's own header comment, `db/postgres/schema.sql` comments,
   `db/postgres/RLS.md`, `db/shared/*.ts` comments, `docs/AGENT-API.md`, worker test comments -
   and the PR body.
5. `pnpm neon:check` must stay green.
6. **Sibling PRs.** Branches cut from the same feature often carry their own copy of the
   original-numbered file. Name them in the report; they need the same new filename or must
   delete their copy once the parent lands.

Applying migrations to the shared dev database is the user's step. A preview walk that 500s after
the push usually means exactly that migration is pending - say so in the report.

## Dependencies in a worktree

`link-deps.sh` handles the normal case. When results still look wrong:

- **Module-resolution errors or a wall of type errors in files the PR never touched** mean
  mismatched dependencies, not a regression. Replace the links with a real install:
  `rm -rf node_modules && pnpm install --frozen-lockfile` at the root, or
  `rm -rf node_modules && pnpm install --ignore-workspace --frozen-lockfile` in the worker.
- **Stack boot dies waiting on a `/healthz`** with `Cannot find package …` in the e2e logs: a
  worker has no `node_modules`. Re-run `link-deps.sh`.
- The root `tsc -b` writes incremental state into `node_modules/.tmp`. `link-deps.sh` gives the
  worktree its own; if you symlinked `node_modules` wholesale by hand instead, a green `tsc -b`
  may be reading the main checkout's state and is not trustworthy.
- `tsx` is only a local bin: `pnpm exec tsx …`, never bare `tsx`.

## Gate failures

- **Every test in every shard fails** - environmental. Look at one `test-results-s*/…/error-context.md`.
  "Executable doesn't exist … ms-playwright" means a Playwright bump landed without browsers:
  `pnpm exec playwright install chromium`.
- **Whole shards fail at boot** - a worker without dependencies (above), or Docker not running.
- **One shard fails a cluster of specs early with wait timeouts while the others pass** - cold
  start contention. Retry the push once before diagnosing.
- **A stack dies mid-run and the following specs fail with ECONNREFUSED** - only the first
  failure is real; the rest are fallout.
- **A few specs fail the same way every time** - run just those on the clean base before
  suspecting the merge:
  `pnpm exec tsx scripts/e2e-up.ts -- <spec files>` in the baseline worktree. Arguments before
  `--` are ignored and the whole suite runs, so keep the `--`. Identical failure there means the
  base is red; that blocks the gate for every branch touching those specs, and bypassing it needs
  the user's explicit go-ahead.
- **Running the gate by hand in the background dies instantly with `EAGAIN` at `readFileSync(0)`** -
  stdin was a non-blocking pipe. Always redirect `< /dev/null`.
- A backgrounded command wrapped as `cmd; echo exit=$?` reports success regardless. Read the log.
- The hook sizes the run from `remote tip..local tip`. To see what the branch alone would
  select (informational, not a substitute for the gate):
  `pnpm exec tsx scripts/e2e-affected.ts --base origin/<base> < /dev/null`.
- The pre-commit warning that the branch "already has commits for OTHER tickets" is noise on any
  branch cut from `dev`; it compares against `main`. It never blocks.

## Shell traps on this machine

- zsh does not word-split: `git diff -- $FILES` with a space-separated string diffs nothing and
  exits 0. Use an array or `${=FILES}`.
- zsh treats `$var:path` as a modifier: write `git show "${sha}:path/to/file"`.
- zsh expands unquoted globs in arguments and aborts when nothing matches: quote them
  (`grep -r --include='*.ts'`), or the command dies with "no matches found".
- macOS has no `timeout` and no `xargs -a`. zsh's pipe status array is `$pipestatus`.
- `origin/<base>` can move mid-task because every worktree shares one `.git` and other sessions
  fetch. If `git diff origin/<base> HEAD` suddenly lists files the branch never touched, that is
  what happened: merge again.

# Replay corpus

The events replay gate (`docs/RELEASE-RISK-GATES.md`). Each manifest entry is
one project's event log plus the rows the projection rebuild reads beside it.
`src/__tests__/replay-corpus.test.ts` seeds each into a fresh in-process
Postgres, runs the production rebuild from genesis, and compares a hash of
every projection table with `golden.json`.

## What is in the repo, and what never is

The repo is public (MIT). Nothing here carries client content or names a
client: `manifest.json` holds opaque slugs (`prod-07`), the file's sha256,
event counts and a capture date; `golden.json` holds row counts and hashes.
The corpus files themselves (every event payload: verse text, comments,
authors; the lanes and chain claims) live only in the private production
snapshots bucket under `replay-corpus/` and in the gitignored `cache/`. The
export deliberately leaves out the `projects` row, so not even the project's
name or id is written anywhere; the harness reads the project id off the
events in the fetched file. Do not add an identifying column to the manifest.

| File | Committed | What |
| --- | --- | --- |
| `manifest.json` | yes | every corpus: slug, file, sha256, event count (no project id) |
| `golden.json` | yes | per corpus, per table: row count + sha256 of the canonical rows |
| `synthetic/*.json` | yes | generated corpora (`node scripts/replay-corpus.mjs synthetic`) |
| `cache/*.json` | **no** | real projects, fetched from R2 (`… fetch`); client content |
| `out/*.jsonl` | no | the candidate's rows, written when a digest differs |

## Adding a real project

Pick projects a client actually works in, small enough to replay in PGlite in
minutes (a few thousand to ~50k events; a Bible-scale log is too slow here).

```bash
node scripts/replay-corpus.mjs export --url "$PROD_READ_URL" --project <projectId> --slug <name>
node scripts/replay-corpus.mjs upload --slug <name>
UPDATE_REPLAY_GOLDEN=1 pnpm --dir sync-worker test replay-corpus
```

Commit `manifest.json` and `golden.json`. The corpus file is content-addressed
in R2 (`replay-corpus/<sha256>-<file>`), so refreshing a project is a new
object and a new manifest line; old goldens stay reproducible.

## When the gate fails

The candidate build projects a real log to different rows than the golden.
The test prints which tables and writes the candidate rows to `out/`. Diff
them against a run on `dev` to see what moved. If the change is the point of
the PR, regenerate the golden and say so in the PR: the gate workflow keeps
the PR held while `golden.json` changes, so a person reviews that diff.

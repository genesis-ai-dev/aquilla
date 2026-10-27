# AQU-2218: verified audio recovery

This change is **qualified for controlled cutover**. The final complete smoke
run passed all 104 tests without retries (14.9 minutes), after investigating the
earlier failures described below. The recovery cutover must not be inferred
from staged files; deployment and destination verification receipts are separate.

## What is corrected

- Historical pointer evidence now binds the recording in both the audited and
  current notebook: file, cell, attachment, path, author, timestamp and media
  metadata. Unrelated text edits and the local `isMissing` marker do not discard
  valid evidence. Changed, deleted, moved or ambiguous recordings fail closed.
- `historyOnly` audio attaches add an unselected historical take without
  replacing existing rows, clearing votes, changing another selection or undoing
  an app deletion. The flag survives event replay.
- An explicitly audited `restoreProjectionOf` repair can reconstruct a missing
  legacy audio row even when its original event has already been ingested. It
  retains the original event ID, creation timestamp, author and surviving votes.
  Existing rows, logged removals and newer selection choices take precedence.
  This is a separate repair, **not an automatic retry of every past event**.
- The runner requires both recovery capabilities on the public replay Worker
  and the private ingestion Worker before its audio stage can write anything.

No IDs, source files, permissions, archived-project policy, ledger entries,
leases or existing daemon services are reset by these staging tools.

## Why two overlays

The live optimized daemon and the private ingestion Worker contain changes not
present in this checkout's `dev` base. Replacing them wholesale would discard
previous performance and safety work. `overlay.patch` applies only these changes
to the exact audited runner. `hashes.json` refuses drift in every changed file.

`worker-overlay.patch` similarly preserves the rest of the actual deployed
JavaScript. Its baseline versions were:

- `aquilla-sync-worker`: `007debeb-5325-497c-8ec6-936af05dbc4b`
- `aquilla-migration-ingest`: `1e8be1d1-5828-4d39-bdcb-0ef38c61fdcf`

These are **baseline version IDs**, not newly deployed versions. The original
bundles are not committed. Supply the downloaded public bundle as `index.js` and
private bundle as `production-migration.js`; `worker-hashes.json` pins their
complete bytes. Restage and requalify if Cloudflare's active version has changed.

```sh
python3 scripts/migrate-daemon/recovery-deployment/stage.py \
  --base-app /path/to/audited-running-app \
  --candidate-app /path/to/new-inactive-candidate

python3 scripts/migrate-daemon/recovery-deployment/stage-workers.py \
  --base-bundles /path/to/downloaded-baseline-bundles \
  --candidate-bundles /path/to/new-inactive-worker-candidates
```

Both commands only create candidate files. Neither uploads, restarts a service,
touches the queue or grants write access. Keep each Worker in its own small
deployment directory: Wrangler's module discovery must not include audit data,
recovery audio, credentials or unrelated files.

## Qualification and cutover requirements

1. Pass the repository's full release gate. Do not replace it with targeted
   tests. Record producer/consumer, lost-acknowledgement and from-empty-projection
   rebuild tests. The isolated local workerd/native-Postgres canary covers the
   exact patched production bundle as well as the source implementation.
2. Recheck active Cloudflare versions, preserve every binding/secret/setting,
   and record rollback versions. Both Workers must expose
   `audio-history-attach-v1` and `audio-projection-repair-v1` before runner cutover.
3. Gracefully drain the one current writer. Preserve its stopped release and
   configuration, make a consistent SQLite queue/ledger backup, and verify the
   lease is free. Never delete a foreign lease or run parallel writers.
4. Recheck source heads, destination placement/archive status, live selections,
   tombstones, and object conflicts. Revalidate every recovery manifest against
   the live notebooks; a filename or `isMissing` flag alone is never proof.
5. Canary the available Xiang/Pattani/Gan objects. For a projection repair also
   verify the original attach, missing row, exact bytes, source selection and
   full audio history. After ingestion verify the row actually exists: an
   accepted guarded event can intentionally do nothing after a concurrent change.
6. Verify bytes, rows, selections and votes before widening. Resume the existing
   queue and run discovery for other new content. Keep archived projects excluded
   and genuine source absences explicit as completed with historical gaps.

## 2026-10-27 evidence

The read-only live preflight identified 77 available objects absent from expected
destination keys: 11 Xiang, 65 Pattani and 1 Gan, totalling 27,620,322 bytes.
Every byte was separately recovered to an archive and checked against its SHA-256
and expected size. That archive is **not a claim of production ingestion**.

Gan still has 15 pointer-unresolved references and 3 absent source objects. Its
108 donor-recoverable references are already present at the destination. Using
the real donor resolver confirmed those counts; omitting donor recovery inflated
the raw unresolved count to 123. Keep these categories separate in reports.

The full application smoke run failed in project creation/team flows, project
settings, YouTube captions, a delayed edit acknowledgement, and sidebar reimport.
No assertions were weakened and no production deployment was made around that
failure. Inspect the saved run artifacts before attributing those failures to
either this patch or the base application.

The first serial run passed the earlier failures after diagnosing a source-row
hydration race in the shared page object and reducing local stack contention.
Its remaining MP4 seek failure prompted an explicit pause-readiness check: both
the transport and linked picture must have paused before seeking. The two video
paths then passed, followed by the full 104-test run. No seek assertion was weakened.

Qualification recorded on October 27:

- `pnpm build`: passed.
- Worker typecheck and 78 targeted Worker tests: passed.
- 10 recording-proof/audio-producer tests and 58 candidate-runner tests: passed.
- Actual patched production bundle against isolated local native PostgreSQL:
  selected, no-selection, deleted and missing-projection cases passed, including
  duplicate acknowledgements and full projection rebuilds.
- `pnpm run test:e2e:guard` then
  `pnpm exec tsx scripts/e2e-shard.ts 1 -- smoke.spec`: 104 passed, no retries.
- `pnpm scan:secrets` and `git diff --check`: passed.

The companion specification records the recovery invariants and historical-gap
reporting in `aquilla-specs/04-features/export-and-legacy-import.md` and the
acceptance criteria in `05-user-stories/import-legacy-project.md` (commit
`2343eae`, AQU-2218).

After recovery events have been committed, retain compatible ingestion and replay
consumers even if rolling back the runner. An older consumer that ignores the
historical-attach contract is not a valid replay rollback.

# AQU-2506 archive admission contract

Archived projects are intentionally skipped, not transferred and not completed.
The authenticated GET `/migrate/project?archiveStatus=true` validates stable identity,
organization and team grant before returning `archived: boolean`. Placement failures
remain 409 even when archived; legacy callers still receive 409 for archives.

The daemon parks both content and audio jobs as `skipped_archived`, retaining their
revision and prior attempt count. New revisions update the parked job without
unparking it. Read-only checks every 15 minutes resume jobs only after a successful
active response; a changed placement/access/endpoint failure stays parked but sets
an error that monitoring must report. Unarchive does not relax any write fence.
The latest queued revision is re-fetched on resume. Two Healthchecks remain.

Deployment order:
1. Release the endpoint through normal reviewed CI/release gates. Verify authenticated
   active and archived responses and placement rejection before touching the runner.
2. Validate runner-base-hashes.json against the actual installed release. Stage a
   separate release copy, apply runner.patch and copy ../archive.ts into the staged
   scripts/migrate-daemon directory. Never overwrite the running release.
3. Independently test the staged optimized runner, including pending_sha/claim/release
   behavior. These differ from the repository daemon; root unit tests alone are not
   proof of the optimized overlay.
4. Check monitor-base.sha256, apply monitor.patch to a staged monitor, verify skipped
   rows with no error remain visible without alerts and errors/new revisions retain
   their ordinary alert semantics. Preserve all existing exceptions and credentials.
5. Gracefully stop the sole daemon, confirm lease release without overriding a foreign
   lease, back up SQLite with its WAL consistently, switch to the staged release and
   start exactly one writer. Keep old release and queue backup. Verify skip totals,
   unchanged copied totals and normal unrelated project progress; no archive bypass.

Rollback retains the queue backup and old binaries. The old daemon does not know
skipped_archived; do not blindly restart it and assume parked jobs will run. Either
keep the new reader/scheduler or explicitly restore a consistent pre-cutover queue
only after ensuring no post-cutover migration progress would be lost.

Tests cover endpoint through actual SyncClient, persistent job state and latest
revision handling. Monitoring reporting changes are an overlay because AQU-2472 is
not merged in this base. No product UI or application realtime-sync spec changes;
this runbook specifies the legacy migration admission contract.

# Migration-only direct Neon transport (AQU-2081)

Status: opt-in candidate. Not enabled by an application deployment. Do not replace
the optimized server installation with the repository daemon: that installation
has additional recovery, queue, lease and audio logic that must be preserved.

## Connection and request contract

The dedicated entry point is `sync-worker/src/migration-worker.ts`. It exposes
only authenticated `GET /migrate/readiness`, `POST /migrate/ingest` and
`POST /migrate/finalize`. The normal application continues using Hyperdrive.
Provisioning, settings, event-ID reconciliation, R2 copies and the existing writer
lease stay on the normal service. The new worker holds no R2 bindings.

Provision only a dedicated operator secret and database URI; the application
token-signing key is not needed on this worker.

Use the example migration Wrangler configuration with Ohio placement and a pooled
Neon URI. Pin the exact host, database and database role separately; require TLS.
The role must be reviewed against the current worker's effective privileges.
The dedicated adapter applies transaction-local limits because the isolated
Neon pool ignored startup GUCs (observed 0ms / 300000ms). Readiness verifies actual
database/role and the effective 15s statement / 30s idle transaction timeouts. Failure is a blocker, not a reason to remove those checks.
The connection pool maximum is one per request; it is not a global connection cap.
Keep runner concurrency and pacing conservative and monitor total Neon load.

Every write requires the operator credential, runner identity, the pinned
`x-migrate-destination` and immutable `x-migrate-gitlab-id` / `x-migrate-org-id` /
optional `x-migrate-team-id`. A mutable title is never an identity. The destination
UUID must match the numeric source ID. The existing identity handler rechecks org,
team grant and archive state immediately before each request. This is not an
atomic lock against a concurrent administrator move/archive during a batch.

The existing ingestion handler retains AQU-2025's atomic event/projection groups.
Only the dedicated entry enables bulk source creation: adjacent distinct source
cells in one file, at most 200 per SQL group, retaining coerced integer metadata.
Other events use the ordinary projection path. Requests are capped at 250 events
and 4 MiB. `eventsOnly` is rejected. Finalize must complete before marking a job
done; event counts alone do not prove complete projections or R2 audio bytes.

## Runner integration and admission

The repository `SyncClient` supports a separate ingestion base, operator secret
and expected destination. `loadConfig` requires all three settings together:
`MIGRATE_INGEST_BASE`, `MIGRATE_INGEST_SECRET`, `MIGRATE_INGEST_DESTINATION`.
The destination format is `POOLER_HOST/DATABASE/ROLE`. Identity is supplied from
existing project records, preserving UUIDs and placement. The client checks
readiness, splits large submissions into ordered 250-event requests, validates
acknowledgements and never falls back silently to another endpoint. Failed or
uncertain submissions do not advance the existing write-after-ack ledger.

This same change must be ported surgically into the optimized deployed runner;
its current queue, recovery logic, lease owner, versions and pacing must survive.
Do not copy the whole repository daemon over it. Both transports must use the same
existing lease. The runner header is attribution, not an exclusion mechanism.

With the environment loaded securely, check admission without starting a writer:

```bash
pnpm exec tsx scripts/migrate-daemon/check-direct.ts
```

## Cutover gate and rollback

1. Verify the actual current deployment contains atomic event/projection groups.
2. Test the repository client and actual worker on an isolated Neon branch, including
   interrupted writes, replay, rename, placement/archive rejection and finalization.
   Include production-sized existing data, database reconnection and the optimized
   runner's restart/lease path before claiming full-run qualification.
3. Compare the primary Hyperdrive origin with the new URI's branch endpoint and
   database via Cloudflare/Neon metadata. Retain a pre-cutover snapshot branch;
   the read-only Oct 20 production audit reported only six hours of restore history.
   Matching project rows on a dev mirror are
   not enough to prove the destination. Verify effective role privileges and backups.
4. Start with writes disabled and explicit source IDs. Readiness can inspect the
   connection in that state, but the runner admission command intentionally rejects
   disabled writes. Enable only the selected canary IDs after destination review.
5. Gracefully stop and drain the current runner. Preserve old executable, systemd
   configuration, environment and an SQLite-consistent backup (SQLite backup API,
   not a live copy of the main DB file without its WAL). Do not override a foreign
   lease. Restart exactly one runner using the existing state after its prior holder
   has released the shared lease.
6. Verify destination events, projections, finalize counters and actual audio object
   existence. Check live application latency, errors and Neon connections/lock waits.
   Widen scope only after the canary passes. Do not raise concurrency simultaneously.

To roll back transport: drain/stop the same runner, remove all three ingestion
settings, and restart it against the existing normal service and same queue.
Keep event IDs/checkpoints intact. Reconcile uncertain acknowledgements by replay;
never delete target data or reset the queue merely to change transport. Confirm
that rollback code also contains the atomic-write fix. Database writes already
committed are retained; this is transport rollback, not a database restore.

## Verification commands

```bash
pnpm exec vitest run scripts/migrate-daemon/__tests__/http.test.ts scripts/migrate-daemon/__tests__/main.test.ts scripts/migrate-daemon/__tests__/push.test.ts
pnpm --dir sync-worker exec vitest run src/__tests__/migration-worker.test.ts src/__tests__/migrate-ingest-seq.test.ts
pnpm --dir sync-worker run type-check
pnpm exec wrangler deploy --dry-run --config sync-worker/wrangler.migration.example.toml --outdir /tmp/aquilla-migration-build
```

Synthetic metadata benchmarks do not measure GitLab scans, R2 bytes, recovery of
missing originals, full-daemon runtime or contention with live application users.

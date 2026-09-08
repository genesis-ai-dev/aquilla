# GitLab → Aquilla migration daemon — design

Date: 2026-09-08. Status: approved design, sub-project 1 (framework + content) planned first.

## Problem

`scripts/migrate-all.ts --apply` is the one-way GitLab → Aquilla content sync. Today it is
unfit to run on a schedule:

- **Memory.** Each `doProject` materializes every notebook, the whole project's event array,
  and a `Set` of every event id already in prod (up to 166k per project), with 8 projects in
  flight and 8 `npx tsx migrate-fetch` child processes. A full dry-run OOMs (~230/488
  projects) at Node's default heap; 8 GB heap completes in ~45 min.
- **Prod load.** Every non-skipped project calls `POST /migrate/project`,
  `POST /migrate/finalize` (project-wide `UPDATE files` + one transaction per file) and bumps
  `project_settings.version` even when zero events are new. Eight of those at once were
  30-40% of Hyperdrive queries and caused write-lock convoys (see the 2026-09-04 perf
  diagnosis); the 15-minute Mac crontab was disabled.
- **Change detection.** Skip key is HEAD SHA; a GitLab hiccup on the SHA fetch means "full
  reprocess", and discovery re-probes all 488 projects (2 API calls each) every run.
- **Reliability.** Only `/migrate/ingest` retries (4×, 750 ms); every other call has none.
  Projection statements re-execute on replayed events, so retries are not truly idempotent.
  41 projects are blocked by stale local checkouts keyed by project *name* (collisions).
- **State** is a local `.migrate-state.json` rewritten after each project, with an R2 copy
  synced only at the end of the nightly GitHub workflow.

Dry-run 2026-09-08: 446/488 planned, 419 clean, 41 stale-checkout, 26 no org/team mapping.
~17M historical events across the 419 (p50 33k, p90 89k, max 166k per project).

## Goals

1. Continuous one-way sync, webhook-driven, with a periodic reconcile that catches missed hooks.
2. Bounded memory regardless of project size (stream per file).
3. Prod writes only when something changed, at a paced rate that never convoys Hyperdrive.
4. Fidelity: the event stream for a project is byte-identical to what `migrate-all.ts`
   produces today; nothing is lost or duplicated across retries, crashes or restarts.
5. Every failure is retried with backoff and visible; nothing is silently skipped.
6. Runs unattended on the always-on Linux box (`clear@192.168.1.80`, 32 cores / 125 GB).

Non-goals: changing the mapping semantics (`map.ts`, `orphans.ts`, `ids.ts`), moving
orchestration to Cloudflare, real-time (<30 s) latency.

## Architecture

New service `services/migrate-daemon/` in this repo, run with `tsx`, importing the existing
pure libs unchanged (`src/lib/codex-editor/parse-codex`, `src/lib/migrate/{map,orphans,ids,
comments,audio-copy,group-sync,gitlab/*,r2-s3,run-lock}`). Stages are independent workers over
one local SQLite database. Files ≤ 500 lines.

```
services/migrate-daemon/
  main.ts            CLI: daemon | once [--only <gitlabId>] [--kind content|audio] [--dry-run]
                          | status | reconcile | seed-ledger [--only]
  config.ts          env + defaults (pacing, paths, concurrency)
  db.ts              SQLite (better-sqlite3, WAL) at $MIGRATE_HOME/state.db; schema + migrations
  http.ts            retrying clients for sync-worker (/migrate/*) and GitLab
  pacer.ts           token bucket + adaptive chunk size + circuit breaker
  notify.ts          Discord digest + PostHog events
  stages/detect.ts   webhook inbox poll + reconcile → jobs
  stages/fetch.ts    warm clone by gitlab id, fetch + ff, re-clone on failure
  stages/materialize.ts  per-file parse → plan NDJSON; ledger delta
  stages/push.ts     single writer: ingest chunks, finalize, settings, verify
```

### Data model (SQLite)

- `projects(gitlab_id PK, aquilla_id, name, namespace, org_id, team_id, last_activity_at,
  head_sha, applied_sha, content_logic, cast_hash, status, last_error, updated_at)`
- `jobs(id PK, project_id, kind, sha, stage, attempts, next_run_at, created_at, updated_at,
  error)` — `stage ∈ detected|fetched|planned|pushing|done|failed`. Unique `(project_id,
  kind)` among unfinished jobs; a newer SHA supersedes the pending job's `sha`.
- `files(project_id, path, content_hash, PK(project_id,path))` — working-tree hash of each
  `.codex`/`.source`/`comments.json`; a file whose hash is unchanged since `applied_sha` is
  not re-materialized.
- `applied_events(project_id, event_id, PK(project_id,event_id))` — local mirror of prod's
  `/migrate/event-ids`. Seeded once per project from prod; appended per acked chunk.
- `push_log(id, job_id, chunk_no, events, ms, http_status, attempt, at)`.
- `kv(key PK, value)` — inbox cursor, reconcile high-water mark, breaker state.

### Stage: detect

- Poll `GET /migrate/webhook/inbox?since=<cursor>` on sync-worker every 30 s.
- Reconcile every 15 min: paginated `GET /projects?order_by=last_activity_at&sort=desc`,
  stop at the first project whose `last_activity_at` ≤ stored high-water mark. New or changed
  projects → `detectCodexProject` probe (as today) → upsert `projects`, enqueue job.
- Placement: org/team maps from `GET /migrate/org-team-maps`, refreshed hourly; a project with
  no mapping is recorded with `status='unmapped'` (surfaced in `status`), not silently skipped.

### Stage: fetch (parallel ×4, git only, in-process)

Clone dir `$MIGRATE_HOME/clones/<gitlab_id>` (id-keyed; fixes name collisions). Existing:
`git fetch` + `git merge --ff-only`; if ff impossible or the repo is corrupt: delete and
re-clone (`depth=1, single-branch`). The clone is a disposable cache, never authoritative.
Verifies the working tree HEAD equals the job SHA (or newer; then update the job SHA).

### Stage: materialize (parallel ×2, memory bounded by one file)

For each file pair whose hash changed (or all, on first sight / logic-version bump):
`parseCodexNotebook` → `mapFilePairToEvents` (+ `mapComments` for `comments.json`) → for
previously migrated files, per-file `GET /migrate/cell-ids` → `computeOrphanRetractions`
(retractions, resurrections, anchor repairs) → filter by `applied_events` → append lines to
`$MIGRATE_HOME/plans/<gitlab_id>/<sha>.ndjson`. Each line: `{id, event, hash}`. IDML pairs
keep today's prerequisite/`source-artifact-copy` handling. Cast additions computed from
speakers; `cast_hash` stored. A plan with zero lines and unchanged cast marks the job `done`
with `applied_sha = sha` and never touches prod.

### Stage: push (single global writer)

Reads plan files in job order. Pacing: token bucket `PUSH_EVENTS_PER_SEC` (default 400),
`max in-flight = 1`. Adaptive chunk: start 500; 5xx/timeout/response >3 s → halve (floor 50)
and pause 30 s; 20 consecutive fast 2xx → double (cap 2500). Breaker: 5 consecutive failures
→ pause push 5 min, notify. Optional quiet-hours window weights bulk to low-traffic UTC.

Per project: `POST /migrate/project` only on first sight; ingest chunks (`deferFileCounters:
true`); after ack, append ids to `applied_events` and `push_log` in one SQLite transaction;
`POST /migrate/finalize` only if ≥1 event landed; `POST /migrate/settings` only if
`cast_hash` changed. Then **verify**: `GET /migrate/event-ids?count=1` vs ledger count;
mismatch → re-seed ledger from prod, re-plan, re-push before `done`. Weekly full re-seed of
every project.

### Fidelity guarantees

- Same pure mapping functions → identical events and ids; only scheduling changes.
- Deterministic ids + `ON CONFLICT (id) DO NOTHING` → re-sends never duplicate.
- Ledger written only after 2xx → a crash can only cause a re-send, never a skip.
- Prod is truth: count verify per job + weekly re-seed catches any ledger drift (e.g. a
  manual `migrate-all.ts --apply` elsewhere).
- Release gate: parity diff (event ids + payload hashes) between `migrate-all.ts` dry-run and
  the daemon's `once --dry-run` for all 419 clean projects must be empty.

### Retries and failure handling

One HTTP client for sync-worker and GitLab: exponential backoff with jitter 1 s → 60 s, 6
attempts, on network errors / 5xx / 429 (honour `Retry-After`). Other 4xx → job failure.
Job-level backoff `next_run_at`: 5 m, 15 m, 1 h, 6 h, then daily; jobs are never dropped.
Fetch failure → re-clone once, then job failure. `status` lists failed/unmapped projects and
the breaker state.

### Server-side changes (sync-worker, one small PR first)

1. `POST /migrate/webhook/gitlab`: verify `X-Gitlab-Token` against `GITLAB_WEBHOOK_SECRET`;
   accept `push` and project events; store `{gitlabId, sha, ts}` in KV keyed by minute.
   `GET /migrate/webhook/inbox?since=` (admin bearer) returns and advances.
2. `migrate-ingest-route.ts`: events insert uses `RETURNING id`; projection statements are
   enqueued only for rows actually inserted, making replayed chunks true no-ops.
3. `GET /migrate/event-ids?count=1` returns `{count}` only.

## Deployment and operations

- Box: `clear@192.168.1.80` (Tailscale). Repo at `~/aquilla` on `main`; daemon
  self-updates with `git pull --ff-only` on restart. `MIGRATE_HOME=~/aquilla-migrate`.
- Secrets: `/etc/aquilla-migrate/env` (0600): `GITLAB_URL`, `FRONTIER_TOKEN`,
  `SYNC_SECRET_KEY`, `R2_*`, `MIGRATE_ADMIN_BEARER`, `DISCORD_WEBHOOK_URL`.
- systemd `aquilla-migrate.service`: `Restart=always`, `MemoryMax=32G`,
  `NODE_OPTIONS=--max-old-space-size=16384`; logs to journald + rotating file.
- Keeps the R2 `RunLock` so a manual `migrate-all.ts --apply` and the daemon cannot overlap.
- `MIGRATE_RUNNER=daemon@<host>` header for the migrate fence.

## Sub-projects

1. **Framework + content** (this plan): everything above; content step removed from the
   nightly GitHub workflow after cutover.
2. **Audio-fast**: `kind=audio` jobs on the same queue, reusing `audio-copy.ts`; pacing on R2
   copies.
3. **Users + groups**: `migrate-users` and `syncGroupsToNeon` as periodic jobs (hourly), plus
   GitLab system hooks if the admin token allows. Then retire `audio-delta-sync.yml`.

## Testing

- Unit (vitest, root suite): `pacer.ts` (adaptive chunking, breaker), `db.ts` job state
  machine and supersede rule, `materialize` streaming on a synthetic 100-file project with a
  heap assertion, ledger write-after-ack ordering, `http.ts` backoff and `Retry-After`.
- sync-worker tests for the three route changes.
- Parity diff script (release gate) — see Fidelity.
- Integration against the local dev stack with a fixture repo on disk.

## Rollout

1. sync-worker PR (webhook inbox, idempotent projection, count endpoint); deploy.
2. Daemon on the box in `--dry-run` for **2 hours**, logging what it would push.
3. Parity diff must be empty.
4. Canary: `once --only <id>` with `PUSH_EVENTS_PER_SEC=100`; watch Hyperdrive + PostHog.
5. Enable push for the full backlog (night, UTC).
6. Remove the content step from `audio-delta-sync.yml`; register the GitLab webhook.

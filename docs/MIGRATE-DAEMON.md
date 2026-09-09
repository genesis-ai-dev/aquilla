# Migrate daemon

## What it is

The migrate daemon replaces the periodic `migrate-all.ts` sweep (run nightly from
`audio-delta-sync.yml`) with a long-running process that keeps Aquilla content in
sync with GitLab near-real-time: a GitLab webhook lands push events in a
sync-worker inbox, the daemon polls that inbox, clones/updates the affected repo,
materializes an event plan, and pushes it to the sync-worker as a single writer.
See `docs/superpowers/specs/2026-09-08-migrate-daemon-design.md` for the full
design and rationale.

## Stages

**detect** (`scripts/migrate-daemon/stages/detect.ts`) — discovers Codex projects
two ways: polling the sync-worker webhook inbox (near-real-time, populated by the
GitLab system hook) and a periodic full GitLab activity `reconcile` that catches
anything the webhook missed (mirrors `migrate-all.ts`'s placement logic exactly:
namespace → org/team, via the same `orgLegacyUuidFor`/`teamLegacyUuidFor`
derivation). Either path enqueues a `content` job for the project at `detected`.

**fetch** (`stages/fetch.ts`) — ensures a local git checkout for the project is at
or past the sha that triggered the job, cloning fresh or fast-forwarding as
needed. If the checkout lands ahead of the triggering sha (a push landed mid-clone),
the newer sha is re-enqueued rather than migrating a stale tree. Every clone/fetch
disables git-lfs smudging (env var plus `-c filter.lfs.*` flags), so LFS objects
always land as pointer text, never smudged bytes — audio attachments are migrated
separately in sub-project 2 via direct R2 copy. Advances to `fetched`.

**materialize** (`stages/materialize.ts`) — walks the checkout file-by-file,
delta-filtering against the local ledger, and streams an NDJSON event plan to
disk (never holding a whole project's events in memory). Output must be
byte-identical to `migrate-all.ts` for the same checkout — only the scheduling
and memory shape differ (see `CONTENT_LOGIC_VERSION`, which must match on both
sides). Advances to `planned`.

**Accepted semantic change — unchanged files skip the orphan pass.** In steady
state a file whose bytes hash the same as the recorded `files.content_hash` is
skipped entirely, which means its orphan pass (retracting cells deleted
upstream, re-anchoring moved ones) does not run. `migrate-all.ts` ran that pass
on every file, every sweep. Projection drift is therefore possible between
pushes — a cell prod holds that the checkout no longer has. It is reconciled
within 7 days: the weekly ledger reseed force-re-materializes every `ok`
project (`forceNext`), which runs the orphan pass on every file regardless of
hash. `--force` does the same on demand for one project.

**push** (`stages/push.ts`) — the daemon's single writer: one project, one paced
chunk at a time via the `Pacer`. **Durability contract**: the local ledger is
written *after* prod acks a chunk ("write-after-ack"), so a crash or a failing
chunk leaves the ledger a strict prefix of what prod holds — never a superset —
and a retry only re-plans the remainder; no event is silently skipped. After each
push, prod's own event count is compared against the ledger's (count-verify).
Prod's count includes **human-authored** events that never came from a
migration, so only a *deficit* is treated as drift: `remote < local` means prod
is missing events the ledger claims landed, and the local mirror is thrown away
and reseeded from prod before retrying. `remote >= local` verifies, and a
surplus is logged as "non-migrate events" — expected in any project people have
worked in. If the **second** push attempt after a reseed still fails
verification, the job fails outright (into backoff) rather than looping forever —
this is the "second unverified push fails into backoff" behavior: a mismatch that
survives one full reseed-and-retry indicates something structural (concurrent
writer, a mapping bug) that needs a human, not another automatic retry.

## Pacing knobs

- `PUSH_EVENTS_PER_SEC` — target push throughput; canary default `100`, steady
  state `400` once Hyperdrive + PostHog look clean at canary rate.
- `FETCH_CONCURRENCY` — concurrent git fetch/clone operations (default `4`).
- `MATERIALIZE_CONCURRENCY` — concurrent materialize (plan-build) operations,
  CPU/disk bound so kept low (default `2`).
- The push stage itself is strictly serial (one writer, one chunk at a time) —
  there is no push concurrency knob; only the pacer's rate.

## Commands

All run via `pnpm migrate:daemon <command>` from the repo root (`~/aquilla` on
the box), or `tsx scripts/migrate-daemon/main.ts <command>` directly.

- **`daemon`** — runs forever: inbox poll, periodic reconcile, weekly full
  ledger reseed, and the stage drain loop. Acquires the R2 run lock (shared with
  `migrate-all.ts --apply`) unless `DRY_RUN=1`. This is what the systemd unit
  runs.

  **`--dry-run` / `DRY_RUN=1` runs WITHOUT the R2 run lock.** It never writes to
  prod, but it does fetch, materialize and read prod (event ids, counts,
  projections) — so a dry run adds read-only load and can run concurrently with
  a real writer. Conversely, at cutover the **Mac crontab entry that runs
  `migrate-all --apply` every 15 minutes must be removed**: it contends for the
  same lease and will start failing with `LockHeldError` once the daemon holds
  it.

- **`once [--only <gitlab-id>] [--dry-run] [--force]`** — drains every ready job
  once and exits. `--only` first registers/looks up a single GitLab project id
  before draining (used for the canary). `--force` forces re-materialization
  even if the checkout looks unchanged. Example output:
  ```
  once: 3 job(s) done, 0 planned, 1 with errors
    job 42 project 913: verify mismatch persisted after ledger reseed and forced re-materialize
  ```
  Exit code is non-zero if **any** job in the queue failed — not just jobs
  touched by this invocation (see Known gaps).

- **`status`** — summarizes project and job state, plus a fresh (not the live
  process's) pacer snapshot and ledger row counts. Example output:
  ```
  projects: 452 total — ok=419, unmapped=26, error=7
    error 913 acme/some-project: verify mismatch persisted after ledger reseed and forced re-materialize
  jobs: 5 total — detected=2, fetched=1, planned=1, done=1
    job 42 project 913 planned attempts=2 next=2026-09-08T14:22:00.000Z error=...
  pacer (fresh — live pacer state is per-process): {"eventsPerSec":400,...}
  ledger rows: 118422
  kv inbox_cursor: 2026-09-08T13:00:00.000Z
  kv reconcile_hwm: 2026-09-08T12:45:00.000Z
  kv last_full_reseed: 1757296800000
  kv reseed_failed_ids: [913]
  kv reseed_next_attempt: 1757300400000
  clones: 452 checkout(s), 61.30 GB (not pruned for projects deleted in GitLab)
  ```

- **`reconcile`** — runs a one-off full GitLab activity reconcile (same logic the
  daemon runs on `reconcileMs` interval) and enqueues any missed projects.

- **`seed-ledger [--only <gitlab-id>]`** — rebuilds the local ledger for one or
  all `ok` projects from prod's own event log, without touching job state. This
  is the manual escape hatch for "the local mirror looks wrong"; the daemon also
  does this automatically weekly (`weeklyReseed`) and on a verify mismatch.
  Example output: `seed-ledger 913 (a1b2c3...): 4021 events`.

## Files on disk

Everything lives under `MIGRATE_HOME` (`~/aquilla-migrate` on the box):

- `daemon.db` — SQLite: project/job state, the local event ledger, KV cursors
  (`inbox_cursor`, `reconcile_hwm`, `last_full_reseed`, `reseed_next_attempt`,
  `reseed_failed_ids`, and per-project `reseed_done:<gitlab-id>` markers).
- `clones/<gitlab-id>/` — working-copy git checkouts, one per project.
- `plans/<gitlab-id>/<sha>.ndjson` — materialized event plans, newest per
  project used by the push stage and by the parity gate. Only the newest plan
  per project is kept: materialize prunes older shas as it writes, and the
  scheduler deletes the file once its job reaches `done`. A plan therefore only
  survives on disk while its job is unfinished (a dry-run leaves it at
  `planned`, so `--dry-run` runs do accumulate one plan per project).
- `daemon.log` — stdout of the systemd unit (`StandardOutput=append:...`),
  rotated by `/etc/logrotate.d/aquilla-migrate` (weekly, 8 rotations,
  compressed, copytruncate so the daemon's open file handle stays valid).

## Operations

- **Deploy (first time)** — two steps, because the box requires an
  interactive sudo password so a non-interactive SSH session can't run
  privileged commands:
  1. As `clear` (no sudo): `ssh clear@<box> 'bash -s' < deploy/migrate-daemon/install.sh [branch] [env-file]`
     (or copy the script over and run it locally). Idempotent. Clones/updates
     the repo and installs the toolchain + dependencies entirely in
     user-space, then prints the exact `sudo bash .../install-system.sh
     [env-file]` command to run next.
  2. As root, interactively on the box (not over non-interactive SSH):
     `sudo bash deploy/migrate-daemon/install-system.sh [env-file]`. Copies
     the systemd unit, installs the env file (if given), writes the
     logrotate stanza, and enables (but does not start) the service.
  See `deploy/migrate-daemon/env.example` for every variable.

  **Why user-space pnpm**: the box's system `node` (`/usr/bin/node`) has no
  bundled `pnpm`, and `corepack enable` writes shims next to it — into
  root-owned `/usr/bin` — so it fails without root. `install.sh` instead
  runs `corepack enable --install-directory ~/.local/bin`, and the systemd
  unit (`aquilla-migrate.service`) sets `Environment=PATH=` to include
  `/home/clear/.local/bin` and calls `pnpm` there directly (no
  `/usr/bin/env` indirection, since the login PATH systemd uses doesn't
  include it either).

- **Roll a new version**: `deploy/migrate-daemon/update.sh [branch]`, run on the
  box as `clear`. `git pull --ff-only` + `pnpm install --frozen-lockfile` +
  `systemctl restart aquilla-migrate`. This — not the unit's `ExecStartPre`, and
  not re-running `install.sh` — is the sanctioned way to ship a new build; a
  failed pull or install here just leaves the current version running instead of
  crash-looping the service.

- **Read status**: `pnpm migrate:daemon status` (from `~/aquilla` on the box, or
  point `MIGRATE_HOME` at a copy of `daemon.db` from elsewhere).

- **Re-seed a ledger**: `pnpm migrate:daemon seed-ledger --only <gitlab-id>`
  (single project) or without `--only` (every `ok` project) — use after a
  verify-mismatch failure or if prod state was restored from a backup.

- **Force one project**: `pnpm migrate:daemon once --only <gitlab-id> [--force]`.
  Used for the canary and for manually pushing a project the daemon hasn't
  gotten to yet.

- **Disk growth**: `status` reports the clones directory's checkout count and
  total size. Clones are **never pruned automatically** — a project deleted or
  renamed away in GitLab leaves its `clones/<gitlab-id>/` behind forever (a
  follow-up; deleting it by hand is safe, the daemon re-clones on demand).
  Clone flags are deliberately unchanged (no `--filter=blob:none`): LFS and
  attachment behaviour must not shift under the migration. Plans, by contrast,
  are pruned (see Files on disk).

- **Tail logs**: `tail -f ~/aquilla-migrate/daemon.log` on the box, or
  `journalctl -u aquilla-migrate -f` for the unit's own lifecycle events
  (start/stop/restart, not stdout — stdout is redirected to the log file).

- **Discord digest**: if `DISCORD_WEBHOOK_URL` is set, the daemon posts an
  hourly digest (events pushed, jobs done, breaker trips, failures) plus a
  start-of-run and end-of-run message. See `scripts/migrate-daemon/notify.ts`.

## GitLab webhook setup

The daemon's near-real-time path depends on a GitLab **system hook** (admin-level,
covers every project, not a per-project webhook):

1. In GitLab admin → System Hooks, add a hook with URL
   `https://api.aquilla.app/sync/migrate/webhook/gitlab`.
2. Secret token: the sync-worker's `GITLAB_WEBHOOK_SECRET` (sent back as the
   `X-Gitlab-Token` header; sync-worker rejects any request where it doesn't
   match — see `sync-worker/src/events/migrate-webhook-route.ts`).
3. Triggers: **Push events** (all branches) and **Repository update events**.
4. SSL verification: on.
5. Test it with the hook's own **Test** button (pick "Push events") — a
   successful call returns `200` and lands a marker under `_migrate/inbox/` in
   the `aquilla-snapshots` R2 bucket. Confirm with:
   ```bash
   aws s3 ls s3://aquilla-snapshots/_migrate/inbox/ --endpoint-url <r2-endpoint>
   ```
   The daemon's `inbox` poll (every `inboxPollMs`, default 30s) picks these up
   and enqueues jobs; you should see a `detected` job appear in `status` within
   a poll interval.

## Parity gate

Before trusting the daemon to replace `migrate-all.ts`, diff their output on a
fresh ledger (see Task 12 / `scripts/migrate-daemon/parity.ts`):

```bash
# 1. Old sweep script's dry-run event stream, per project, into <oldDir>
tsx scripts/migrate-all.ts --dump-plan <oldDir>   # omit --apply for dry-run

# 2. Daemon's materialized plans, against an EMPTY ledger so nothing is
#    delta-filtered out on either side, with a frozen clock so both sides
#    hash identically for time-sensitive fields
MIGRATE_HOME=<fresh-empty-dir> MIGRATE_FIXED_NOW=<epoch-ms> \
  tsx scripts/migrate-daemon/main.ts once --dry-run

# 3. Compare
tsx scripts/migrate-daemon/parity.ts <oldDir> <fresh-empty-dir>/plans [--only <id>]
```

Expect zero `missing`, `extra`, `changed`, and ordering (`order`) differences.
Both runs must start from an empty/fresh `MIGRATE_HOME` — a mirror that already
has ledger rows will delta-filter events out and produce false "missing" diffs.
The `order` invariant only ever judges plan lines tagged `reconcile: true`
(retractions/resurrections/repairs from `computeOrphanRetractions`), so it is
only exercised when the ledger being reconciled against is seeded — an
empty-ledger run emits no reconciliation events at all and `order` reports 0.

## Cutover checklist

From the design spec's Rollout plan:

1. Ship the sync-worker PR (webhook inbox, idempotent projection, count
   endpoint) and deploy it.
2. Bring the daemon up on the box in `DRY_RUN=1` for a **2-hour window**:
   `reconcile` + fetch + materialize run for every project, nothing is pushed.
   Then run `pnpm migrate:daemon status` and the parity gate against a fresh
   `--dump-plan` from the Mac. Expect `status` to show roughly ≥419 projects
   `ok`, ~26 `unmapped`, 0 stale-checkout failures, and the parity gate to
   report zero differences. Attach both outputs to the PR.
3. Canary: flip `DRY_RUN=0` with `PUSH_EVENTS_PER_SEC=100`, restart the service,
   then `pnpm migrate:daemon once --only <id>` against a project already in
   prod. Watch Neon `sweet-paper-88472094` query latency and the PostHog
   `/migrate/*` log for 15 minutes.
4. Raise `PUSH_EVENTS_PER_SEC` to `400` (steady state) and let the daemon drain
   the full backlog overnight (UTC).
5. Remove the content-migration step from `.github/workflows/audio-delta-sync.yml`
   and register the GitLab system hook (see above) so the daemon is the sole
   path going forward.

## Known gaps

- Unchanged IDML pairs are not re-copied as artifacts unless `--force` is
  passed — a checkout that looks unchanged skips artifact re-copy even if the
  artifact itself is missing or stale downstream.
- `push_log.attempt` is currently always written as a constant rather than an
  incrementing per-chunk attempt counter.
- `once`'s exit code reflects **any** failed job currently in the queue, not
  only jobs touched by that invocation — a stale failed job from an earlier run
  will make an otherwise-clean `once --only <id>` exit non-zero.
- Audio migration and users/groups migration are still handled by the nightly
  `audio-delta-sync.yml` GitHub Actions workflow; this daemon only covers
  content (sub-projects 2 and 3 will bring those under the daemon too).

// Projection rebuild endpoint.
//
// POST /admin/projects/:projectId/rebuild-projection
//
// Drops every cell row + cell_validators row for this project, then replays
// every event in `server_seq` order, applying the head compare-and-swap rule
// (AQU-1154, invariant I1): walking the log in seq order, a chain-arbitrated
// event applies iff its parent_id IS the cell's head (per side/lane) at that
// point, or the row does not exist yet.
//
// AQU-1844: a sibling race is decided by the live `chain_claims` row, not by
// seq order — since AQU-1005 the lower-seq sibling can be the one that
// committed second, and live kept the other. The project's claims are read
// alongside the log and handed to the replay. chain_claims itself is NOT
// rewritten by rebuild: it IS the live record this replay defers to.
//
// AQU-1833: when the project has a usable projection snapshot in R2, the
// wiped tables are seeded from it and only events with
// `server_seq > snapshotSeq` are replayed — rebuild time stops growing with
// the project's whole history. A snapshot is an optimization and never the
// authority: anything doubtful about it (missing, corrupt, written against a
// different column set, ahead of the log) re-wipes and replays in full. See
// projection-snapshot.ts.
//
// `?fullReplay=1` forces the from-genesis replay. Because a snapshot is taken
// from the LIVE projection, a seeded rebuild repairs the log's tail, not the
// snapshot itself — so a projection suspected WRONG rather than merely stale
// is repaired with that flag.
//
// ── Bounded memory + atomic swap (AQU-1827) ────────────────────────────
// A Bible-scale project is 300k–1M events, so NOTHING here may hold the log
// (or a statement per event) in the isolate at once. Two rules:
//
//   1. The log is read in keyset pages (`server_seq > ? ORDER BY server_seq
//      LIMIT EVENT_PAGE_LIMIT`), index-backed by the UNIQUE
//      `idx_events_project_seq_id (project_id, server_seq)` — which is also
//      why `server_seq` alone is a total order and needs no tie-breaker. Only
//      one page of rows is live at a time, and projection statements are
//      applied every BATCH_LIMIT rather than accumulated to the end. Steady
//      state is one page + one chunk, whatever the log's size.
//      The one thing still O(cells) is the replay's own head map, which is
//      what it is: a head per (file, cell, side, lane).
//
//   2. The whole rebuild runs inside ONE transaction, which is the atomic
//      swap: under MVCC a reader's snapshot keeps seeing the PREVIOUS
//      projection until it commits, so the project never reads empty or
//      half-replayed, and an abort (an unknown kind, an unreadable payload, a
//      dead isolate) rolls the wipe back and leaves the old projection intact
//      and rebuildable. Nothing is written to a shadow table, because
//      Postgres already gives the shadow for free.
//      Cost, deliberately accepted: the wipe's row locks are held for the
//      whole replay, so a concurrent WRITER on this project's cells blocks
//      until the rebuild commits (before, it blocked only for the wipe's own
//      transaction). Rebuild is an operator repair of a project whose
//      projection is already wrong — blocking its writers for the duration
//      beats serving every reader an empty project.
//
// Because the replay is inside the transaction, a mid-replay failure must
// THROW (RebuildFailed) and not `return` a Response: returning would commit
// the partial projection, which is the exact failure mode this endpoint
// existed to clean up.
//
// The snapshot seed (AQU-1833) runs inside that same transaction — the keyset
// cursor simply starts at the snapshot's seq instead of the top of the log,
// so both rules above cover it unchanged. Its R2 chunk reads are the one
// place this transaction waits on non-DB work: each is a single bounded
// object fetch, far inside the 30s idle-in-transaction ceiling
// (DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS). The manifest itself is read
// before the transaction opens.

import {
  buildEventProjectionStmts,
  projectFileCountersRecomputeStmt,
  type PersistedEvent,
} from './event-projection'
import {
  buildClaimWinners,
  ChainHeadReplay,
  type ChainClaimRow,
} from './chain-head-replay'
import { loadTargetLanes } from './lane-read-wall'
import type { EventKind } from './types'
import { fullProgressRecomputeStmts } from './progress-projection'
import { isAuthorizedAdminBearer } from '../lib/admin-auth'
import { withLongOperationTimeout } from '../../../db/shim/postgres'
import {
  readProjectionSnapshot,
  restoreProjectionSnapshot,
  SnapshotUnusableError,
  type ProjectionSnapshotEnv,
  type ProjectionSnapshotManifest,
  type RestoredSnapshot,
} from './projection-snapshot'

const BATCH_LIMIT = 100

/** Events per keyset page — the only event-shaped allocation the rebuild
 *  holds. Payloads (verse HTML, metadata) are the bulk of a row and run to
 *  kilobytes, so a page is a few MB here and a smaller number buys little
 *  against the extra round-trip per page. Exported for the paging tests. */
export const EVENT_PAGE_LIMIT = 1000

export interface RebuildEnv {
  AQUILLA_PG?: AquillaDb
  ADMIN_SECRET?: string
  SYNC_SECRET_KEY?: string
  /** AQU-1833: projection snapshots. Unbound simply means every rebuild is a
   *  full replay, exactly as before snapshots existed. */
  SNAPSHOTS?: R2Bucket
  R2_KEY_PREFIX?: string
}

/** The three projection tables a rebuild owns, emptied before every replay —
 *  and emptied again when a snapshot seed is refused part-way through its
 *  inserts. One statement at a time on the transaction handle: `batch()`
 *  there would open a nested transaction (see rebuildProjection). */
async function wipeProjection(tx: AquillaDb, projectId: string): Promise<void> {
  await tx.prepare('DELETE FROM file_section_progress WHERE project_id = ?').bind(projectId).run()
  await tx.prepare('DELETE FROM cell_validators WHERE project_id = ?').bind(projectId).run()
  await tx.prepare('DELETE FROM cells WHERE project_id = ?').bind(projectId).run()
}

interface EventRow {
  id: string
  schema_version: number
  project_id: string
  file_id: string | null
  cell_id: string | null
  parent_id: string | null
  kind: string
  author: string
  payload: string
  client_ts: number
  server_ts: number
  server_seq: number
}

/** A replay failure that must roll the transaction back and surface as a 500
 *  with this message — see the atomicity note at the top of the file. */
class RebuildFailed extends Error {}

/** AQU-1833: a snapshot manifest that read as usable, plus the bucket it
 *  points into. Resolved before the transaction opens (see the handler). */
interface SnapshotSeed {
  env: ProjectionSnapshotEnv
  manifest: ProjectionSnapshotManifest
}

interface RebuildOutcome {
  eventsRead: number
  eventsProjected: number
  statementsApplied: number
  cellsAfter: number
  validatorsAfter: number
  rebuiltSeq: number
  /** AQU-1833: what this rebuild actually had to replay. `replayFromSeq` 0 is
   *  a from-genesis replay; `snapshotNote` says why a snapshot that existed
   *  was not used, so a slow rebuild is never a mystery. */
  fromSnapshot: boolean
  snapshotSeq: number | null
  snapshotRowsRestored: RestoredSnapshot['rowsRestored'] | null
  replayFromSeq: number
  maxServerSeq: number
  snapshotNote?: string
}

const REBUILD_PATH = /^\/admin\/projects\/([^/]+)\/rebuild-projection$/

const EVENT_COLUMNS = `id, schema_version, project_id, file_id, cell_id, parent_id, kind,
              author, payload, client_ts, server_ts, server_seq`

export async function handleRebuildProjectionRequest(
  request: Request,
  env: RebuildEnv,
): Promise<Response | null> {
  const url = new URL(request.url)
  const match = REBUILD_PATH.exec(url.pathname)
  if (!match) return null

  if (request.method !== 'POST') {
    return new Response('method not allowed', { status: 405 })
  }

  if (!env.SYNC_SECRET_KEY) {
    return new Response('SYNC_SECRET_KEY not configured', { status: 500 })
  }
  const auth = request.headers.get('Authorization') ?? ''
  if (!isAuthorizedAdminBearer(auth, env)) {
    return new Response('unauthorized', { status: 401 })
  }

  if (!env.AQUILLA_PG) {
    return new Response('AQUILLA_PG binding not configured', { status: 500 })
  }

  // AQU-1876: every worker connection carries a 15s statement_timeout. A
  // rebuild is minutes of work by design — the paged replay is many short
  // statements, but the project-wide wipe, the set-based counter recompute
  // and the per-file progress recompute are each one statement over a whole
  // project — so it runs under the registered `project-rebuild` ceiling
  // instead. The registry (db/shim/postgres.ts LONG_OPERATION_TIMEOUTS) is
  // the one list of operations allowed to outrun the default. The ceiling is
  // a SET LOCAL inside the transaction opened below, so every statement of
  // the replay inherits it.
  const db = withLongOperationTimeout(env.AQUILLA_PG, 'project-rebuild')
  // The transaction IS the atomic swap, so a handle without one cannot run
  // this endpoint at all — a half-replayed projection is the bug being fixed,
  // not an acceptable degraded mode. Production PostgresDb always has it.
  if (typeof db.transaction !== 'function') {
    return new Response('AQUILLA_PG binding does not support transactions', { status: 500 })
  }
  const projectId = decodeURIComponent(match[1])
  const startedAt = Date.now()

  // AQU-1833: `?fullReplay=1` refuses the snapshot and replays from the first
  // event — the from-genesis repair for a projection believed WRONG, as
  // opposed to merely stale (see the header note). The manifest is read here,
  // before the transaction opens: it needs nothing from the database, and a
  // snapshot that reads as missing or corrupt is settled without the
  // transaction waiting on R2 at all. Unbound SNAPSHOTS means every rebuild
  // is a full replay, exactly as before snapshots existed.
  const fullReplay = url.searchParams.get('fullReplay') === '1'
  let seed: SnapshotSeed | null = null
  if (!fullReplay && env.SNAPSHOTS) {
    const snapshotEnv: ProjectionSnapshotEnv = {
      SNAPSHOTS: env.SNAPSHOTS,
      R2_KEY_PREFIX: env.R2_KEY_PREFIX,
    }
    const manifest = await readProjectionSnapshot(snapshotEnv, projectId)
    if (manifest) seed = { env: snapshotEnv, manifest }
  }

  let outcome: RebuildOutcome
  try {
    outcome = await db.transaction((tx) => rebuildProjection(tx, projectId, seed))
  } catch (err) {
    if (err instanceof RebuildFailed) {
      return new Response(err.message, { status: 500 })
    }
    throw err
  }

  const completedAt = Date.now()

  return Response.json({
    ok: true,
    ...outcome,
    startedAt,
    completedAt,
    note: 'Rebuild runs in one transaction: readers keep the previous projection until it commits, and a failure leaves the old projection intact.',
  })
}

/**
 * The rebuild itself, on a transaction-bound handle.
 *
 * Every statement here runs through `tx`, one at a time: `batch()` on a
 * transaction handle would open a NESTED transaction (db/shim/postgres.ts
 * batch() → executor.begin()), which the PGlite test executor cannot do. The
 * round-trip count is unchanged either way — `batch()` awaits its statements
 * serially inside its own transaction.
 */
async function rebuildProjection(
  tx: AquillaDb,
  projectId: string,
  seed: SnapshotSeed | null,
): Promise<RebuildOutcome> {
  // 1. Wipe the projection for this project. Rolled back with everything else
  //    if the replay below fails.
  await wipeProjection(tx, projectId)

  // 2. Head compare-and-swap, tracked in memory per (file, cell, side, lane)
  //    — the same row key `cells` uses. Shared with the live-link mirror fold
  //    (AQU-1574); see chain-head-replay.ts.
  //
  //    AQU-1612: the project's target lane rows go in so replay resolves each
  //    event's lane by `laneId` first and falls back to the `targetLang` tag.
  //    Pre-1612 events carry only the tag and key exactly as they always did,
  //    so a full replay still reproduces the live projection byte for byte.
  //
  //    AQU-1844: the project's chain_claims go in too, so a sibling race
  //    replays to the event that actually won it live rather than to whichever
  //    sibling holds the lower seq. A claim naming an event absent from the
  //    log must be dropped (see buildClaimWinners) — AQU-1827 does that with
  //    an EXISTS in SQL instead of handing it a Set of every event id, which
  //    for a million-event log was itself tens of megabytes (and a
  //    snapshot-seeded rebuild, AQU-1833, only ever reads the log's tail, so
  //    it never had every id to hand over).
  const { results: claimRows } = await tx
    .prepare(
      `SELECT c.file_id, c.cell_id, c.parent_key, c.event_id
       FROM chain_claims c
       WHERE c.project_id = ?
         AND EXISTS (
           SELECT 1 FROM events e
           WHERE e.id = c.event_id AND e.project_id = c.project_id
         )`,
    )
    .bind(projectId)
    .all<ChainClaimRow>()
  const replay = new ChainHeadReplay(
    await loadTargetLanes(tx, projectId),
    buildClaimWinners(claimRows ?? [], null),
  )

  // 2b. AQU-1833: the snapshot (if any) is tagged with a `server_seq`, so the
  //     log's high-water mark decides whether it still describes this project.
  const maxSeqRow = await tx
    .prepare('SELECT COALESCE(MAX(server_seq), 0) AS seq FROM events WHERE project_id = ?')
    .bind(projectId)
    .first<{ seq: number | string | bigint }>()
  const maxServerSeq = Number(maxSeqRow?.seq ?? 0)

  // 2c. AQU-1833: seed from the latest projection snapshot, when there is one
  //     worth trusting. Every refusal ends in the same place — tables empty,
  //     `replayFromSeq` back at 0 — so the paged replay below walks the log
  //     from the top, exactly as it does with no snapshot at all.
  let replayFromSeq = 0
  let snapshot: RestoredSnapshot | null = null
  let snapshotNote: string | null = null
  if (seed) {
    try {
      if (seed.manifest.snapshotSeq > maxServerSeq) {
        // The snapshot is ahead of the log it claims to summarize: the
        // project was truncated, restored, or copied. Replaying its tail
        // would keep rows no event accounts for.
        throw new SnapshotUnusableError(
          `snapshot seq ${seed.manifest.snapshotSeq} is ahead of the log's ${maxServerSeq}`,
        )
      }
      const restored = await restoreProjectionSnapshot(seed.env, tx, seed.manifest)
      if (!replay.seedFromCellRows(restored.cellRows)) {
        throw new SnapshotUnusableError(
          "snapshot cells name lanes this project's lane rows do not have",
        )
      }
      snapshot = restored
      replayFromSeq = seed.manifest.snapshotSeq
    } catch (err) {
      // A refused snapshot is a reason to replay in full, not to fail. The
      // restore may have inserted rows before it was refused (a chunk missing
      // part-way), so wipe again before replaying from the top; the head seed
      // itself is all-or-nothing (ChainHeadReplay.seedFromCellRows), so
      // `replay` is untouched. Only SnapshotUnusableError takes this arm:
      // anything else is a database error, after which Postgres has already
      // aborted this transaction and the re-wipe could not run — so the whole
      // rebuild rolls back (the old projection stays intact, per the
      // atomic-swap note above) and the operator re-runs with ?fullReplay=1.
      if (!(err instanceof SnapshotUnusableError)) {
        throw new RebuildFailed(
          `projection snapshot restore failed: ${String(err)} — re-run with ?fullReplay=1`,
        )
      }
      snapshotNote = `ignored projection snapshot: ${String(err)}`
      console.warn(`[rebuild] ${projectId}: ${snapshotNote}`)
      snapshot = null
      replayFromSeq = 0
      await wipeProjection(tx, projectId)
    }
  }

  let eventsRead = 0
  let eventsProjected = 0
  let statementsApplied = 0
  let stmts: AquillaStatement[] = []

  const flush = async () => {
    for (const stmt of stmts) await stmt.run()
    statementsApplied += stmts.length
    stmts = []
  }

  // Kinds whose projection is built OUTSIDE buildEventProjectionStmts (it
  // throws for them by design): assignment.* land in the assignments table
  // via handleAssignmentEvent and project.link-source is handled in
  // dispatch.ts — neither targets the tables this rebuild wipes
  // (cells / cell_validators / file_section_progress), so their live
  // projection is intact and they are simply skipped during replay. Without
  // this, one assignment event anywhere in the log aborted the whole rebuild
  // MID-REPLAY, stranding the project on a partially rebuilt projection.
  const DELEGATED_PROJECTION_KINDS = new Set<string>([
    'assignment.create',
    'assignment.reassign',
    'assignment.unassign',
    'project.link-source',
  ])

  // 3. Replay the log in keyset pages. (project_id, server_seq) is UNIQUE
  //    (idx_events_project_seq_id), so `server_seq` is already a total order
  //    within the project and the cursor needs no tie-breaker — the same order
  //    the pre-paging single SELECT walked.
  //
  //    AQU-1833: a seeded rebuild starts the cursor at the snapshot's seq, so
  //    its first page is already `server_seq > snapshotSeq` — the tail the
  //    snapshot does not reflect. Without a seed the cursor starts null and
  //    the first page carries no seq predicate at all: `server_seq > 0` would
  //    exclude a seq-0 event, and this replay is the last line of defence for
  //    exactly the kind of log that has one (an event-level migration, a
  //    project copy) — it must never silently skip a row it can see.
  let cursor: number | null = replayFromSeq > 0 ? replayFromSeq : null
  for (;;) {
    const pageStmt: AquillaStatement = cursor === null
      ? tx
          .prepare(
            `SELECT ${EVENT_COLUMNS}
             FROM events WHERE project_id = ?
             ORDER BY server_seq ASC
             LIMIT ${EVENT_PAGE_LIMIT}`,
          )
          .bind(projectId)
      : tx
          .prepare(
            `SELECT ${EVENT_COLUMNS}
             FROM events WHERE project_id = ? AND server_seq > ?
             ORDER BY server_seq ASC
             LIMIT ${EVENT_PAGE_LIMIT}`,
          )
          .bind(projectId, cursor)
    const { results: eventRows } = await pageStmt.all<EventRow>()
    if (!eventRows) throw new RebuildFailed('failed to read events from DB')
    if (eventRows.length === 0) break

    for (const row of eventRows) {
      eventsRead += 1
      if (DELEGATED_PROJECTION_KINDS.has(row.kind)) continue

      // Head compare-and-swap for every chain-arbitrated event (must match the
      // live gate in event-projection.ts): it applies iff its parent_id is the
      // current head for its side/lane, or there is no row yet. Stale branches
      // stay in `events` (we're not rewriting the log) but do not contribute to
      // the projection. The guard applies ONLY to chain-arbitrated kinds —
      // cell.validate (parent_id NULL) is not a chain step, and a parent-null
      // cell DELETE (a migration retraction, AQU-747/910) is a tombstone that
      // applies unconditionally (AQU-931).
      //
      // An unreadable payload replays with a null one (lane ''), and only fails
      // the rebuild if the event won — a stale sibling is skipped either way.
      let payload: unknown = null
      let parseError: unknown = null
      try {
        payload = JSON.parse(row.payload)
      } catch (err) {
        parseError = err
      }
      const isWinner = replay.apply({
        id: row.id,
        kind: row.kind,
        fileId: row.file_id,
        cellId: row.cell_id,
        parentId: row.parent_id,
        payload,
      })
      if (!isWinner) continue

      if (parseError !== null) {
        throw new RebuildFailed(
          `failed to parse payload for event ${row.id}: ${String(parseError)}`,
        )
      }

      const event: PersistedEvent = {
        id: row.id,
        schemaVersion: row.schema_version,
        projectId: row.project_id,
        fileId: row.file_id,
        cellId: row.cell_id,
        parentId: row.parent_id,
        kind: row.kind as EventKind,
        author: row.author,
        payload,
        clientTs: row.client_ts,
        serverTs: row.server_ts,
        serverSeq: row.server_seq,
      }

      try {
        // Defer the O(N²) per-cell file-counter recompute; do it once, set-based,
        // after the replay (step 4b) — the 67%-of-time fix, now in the rebuild.
        buildEventProjectionStmts(tx, event, stmts, { deferFileCounters: true })
        eventsProjected += 1
      } catch (err) {
        throw new RebuildFailed(
          `failed to build projection for event ${row.id} (kind: ${row.kind}): ${String(err)}`,
        )
      }

      // 4. Apply in chunks as we go — the statements for a million-event log
      //    do not fit in the isolate, and order (not batching) is what the
      //    projection depends on.
      if (stmts.length >= BATCH_LIMIT) await flush()
    }

    cursor = Number(eventRows[eventRows.length - 1].server_seq)
    if (eventRows.length < EVENT_PAGE_LIMIT) break
  }

  await flush()

  // 4b. Recompute file counters once, set-based (deferred above). Shares one
  //     builder with the live projection and POST /migrate/finalize — this used
  //     to be a third hand-written copy, and it had already drifted, dropping
  //     ai_drafted_count. AQU-1083 made the divergence dangerous rather than
  //     merely untidy: a rebuild running its own SQL would silently put
  //     headings back into a project that had excluded them.
  await projectFileCountersRecomputeStmt(tx, projectId, Date.now()).run()

  // 5. Mark the rebuild for warm delta clients (audit B5). A rebuild changes
  //    projection rows without minting events, so MAX(server_seq) — the
  //    GET /cells delta + ETag watermark — does not move and every warm
  //    client's `?since=` would return an empty delta (and If-None-Match
  //    would 304) forever, pinning pre-rebuild values in the client's
  //    persistent IDB cache. Allocate one seq through the same per-project
  //    counter the live path uses (event-insert.ts; same seeding, same
  //    GREATEST self-heal) and record it as rebuilt_seq: the read route
  //    resyncs any cursor below it and folds it into the ETag.
  //
  //    Allocating — rather than copying last_seq — makes the marker STRICTLY
  //    greater than every cursor a client could hold pre-rebuild, so even a
  //    fully caught-up client (since == MAX(server_seq) == last_seq) trips
  //    the `since < rebuilt_seq` resync. The consumed seq is a harmless gap,
  //    exactly like an idempotent replay's.
  const rebuiltSeqRaw = await tx
    .prepare(
      `INSERT INTO project_seq_counters (project_id, last_seq, rebuilt_seq)
       SELECT ?, seed.next_seq, seed.next_seq
       FROM (SELECT COALESCE((SELECT MAX(server_seq) FROM events WHERE project_id = ?), 0) + 1 AS next_seq) seed
       ON CONFLICT (project_id) DO UPDATE SET
         last_seq    = GREATEST(project_seq_counters.last_seq + 1, excluded.last_seq),
         rebuilt_seq = GREATEST(project_seq_counters.last_seq + 1, excluded.last_seq)
       RETURNING last_seq`,
    )
    .bind(projectId, projectId)
    .first<number | string | bigint>('last_seq')
  const rebuiltSeq = Number(rebuiltSeqRaw ?? 0)

  const { results: files } = await tx
    .prepare('SELECT id FROM files WHERE project_id = ?')
    .bind(projectId)
    .all<{ id: string }>()
  for (const file of files ?? []) {
    for (const stmt of fullProgressRecomputeStmts(tx, projectId, file.id, Date.now())) {
      await stmt.run()
    }
  }

  // 6. Counts.
  const cellsResult = await tx
    .prepare('SELECT COUNT(*) as cnt FROM cells WHERE project_id = ?')
    .bind(projectId)
    .first<{ cnt: number }>()
  const validatorsResult = await tx
    .prepare('SELECT COUNT(*) as cnt FROM cell_validators WHERE project_id = ?')
    .bind(projectId)
    .first<{ cnt: number }>()

  return {
    eventsRead,
    eventsProjected,
    statementsApplied,
    cellsAfter: Number(cellsResult?.cnt ?? 0),
    validatorsAfter: Number(validatorsResult?.cnt ?? 0),
    rebuiltSeq,
    fromSnapshot: snapshot !== null,
    snapshotSeq: snapshot?.manifest.snapshotSeq ?? null,
    snapshotRowsRestored: snapshot?.rowsRestored ?? null,
    replayFromSeq,
    maxServerSeq,
    ...(snapshotNote !== null ? { snapshotNote } : {}),
  }
}

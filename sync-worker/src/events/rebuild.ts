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
// ── Non-atomic failure mode ────────────────────────────────────────────
// As before — DELETE + replay is not wrapped in a transaction. Re-running
// the endpoint after a partial failure restarts from a clean slate.

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
  type RestoredSnapshot,
} from './projection-snapshot'

const BATCH_LIMIT = 100

export interface RebuildEnv {
  AQUILLA_PG?: AquillaDb
  ADMIN_SECRET?: string
  SYNC_SECRET_KEY?: string
  /** AQU-1833: projection snapshots. Unbound simply means every rebuild is a
   *  full replay, exactly as before snapshots existed. */
  SNAPSHOTS?: R2Bucket
  R2_KEY_PREFIX?: string
}

/** The three projection tables a rebuild owns, emptied before every replay.
 *  A function, not a constant: the statements are consumed by `batch()` and
 *  the snapshot fallback has to wipe a second time. */
function wipeProjectionStmts(db: AquillaDb, projectId: string): AquillaStatement[] {
  return [
    db.prepare('DELETE FROM file_section_progress WHERE project_id = ?').bind(projectId),
    db.prepare('DELETE FROM cell_validators WHERE project_id = ?').bind(projectId),
    db.prepare('DELETE FROM cells WHERE project_id = ?').bind(projectId),
  ]
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

const REBUILD_PATH = /^\/admin\/projects\/([^/]+)\/rebuild-projection$/

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
  // rebuild replays the whole event log — the full-log SELECT and the chunked
  // projection writes are minutes of work by design — so it runs under the
  // registered `project-rebuild` ceiling instead. The registry
  // (db/shim/postgres.ts LONG_OPERATION_TIMEOUTS) is the one list of
  // operations allowed to outrun the default.
  const db = withLongOperationTimeout(env.AQUILLA_PG, 'project-rebuild')
  const projectId = decodeURIComponent(match[1])
  const startedAt = Date.now()
  // AQU-1833: `?fullReplay=1` refuses the snapshot and replays from the first
  // event — the from-genesis repair for a projection believed WRONG, as
  // opposed to merely stale (see the header note).
  const fullReplay = url.searchParams.get('fullReplay') === '1'

  // Head compare-and-swap, tracked in memory per (file, cell, side, lane) —
  // the same row key `cells` uses. Shared with the live-link mirror fold
  // (AQU-1574); see chain-head-replay.ts.
  //
  // AQU-1612: the project's target lane rows go in so replay resolves each
  // event's lane by `laneId` first and falls back to the `targetLang` tag.
  // Pre-1612 events carry only the tag and key exactly as they always did,
  // so a full replay still reproduces the live projection byte for byte.
  //
  // AQU-1844: the project's chain_claims go in too, so a sibling race replays
  // to the event that actually won it live rather than to whichever sibling
  // holds the lower seq. A claim naming an event this project's log does not
  // have is dropped (see buildClaimWinners) — AQU-1833 moved that existence
  // test into the query, because a snapshot-seeded rebuild only reads the
  // log's TAIL and so no longer holds every event id to test against. The
  // predicate is the same one: the claim's winner is an event of this project.
  const { results: claimRows } = await db
    .prepare(
      `SELECT c.file_id, c.cell_id, c.parent_key, c.event_id
       FROM chain_claims c
       WHERE c.project_id = ?
         AND EXISTS (SELECT 1 FROM events e
                      WHERE e.id = c.event_id AND e.project_id = c.project_id)`,
    )
    .bind(projectId)
    .all<ChainClaimRow>()

  // AQU-1833: the snapshot (if any) is tagged with a `server_seq`, so the log's
  // high-water mark decides whether it still describes this project.
  const maxSeqRow = await db
    .prepare('SELECT COALESCE(MAX(server_seq), 0) AS seq FROM events WHERE project_id = ?')
    .bind(projectId)
    .first<{ seq: number | string | bigint }>()
  const maxServerSeq = Number(maxSeqRow?.seq ?? 0)

  // 1. Wipe the projection for this project.
  await db.batch(wipeProjectionStmts(db, projectId))

  // 1b. AQU-1833: seed from the latest projection snapshot, when there is one
  //     worth trusting. Every failure arm ends in the same place — tables
  //     empty, `replayFromSeq` back at 0 — so the full replay below is
  //     byte-for-byte what it was before snapshots existed.
  const replay = new ChainHeadReplay(
    await loadTargetLanes(db, projectId),
    buildClaimWinners(claimRows ?? [], new Set((claimRows ?? []).map((row) => row.event_id))),
  )
  let replayFromSeq = 0
  let snapshot: RestoredSnapshot | null = null
  let snapshotNote: string | null = null
  if (!fullReplay && env.SNAPSHOTS) {
    const snapshotEnv: ProjectionSnapshotEnv = {
      SNAPSHOTS: env.SNAPSHOTS,
      R2_KEY_PREFIX: env.R2_KEY_PREFIX,
    }
    const manifest = await readProjectionSnapshot(snapshotEnv, projectId)
    if (manifest) {
      try {
        if (manifest.snapshotSeq > maxServerSeq) {
          // The snapshot is ahead of the log it claims to summarize: the
          // project was truncated, restored, or copied. Replaying its tail
          // would keep rows no event accounts for.
          throw new SnapshotUnusableError(
            `snapshot seq ${manifest.snapshotSeq} is ahead of the log's ${maxServerSeq}`,
          )
        }
        const restored = await restoreProjectionSnapshot(snapshotEnv, db, manifest)
        if (!replay.seedFromCellRows(restored.cellRows)) {
          throw new SnapshotUnusableError(
            "snapshot cells name lanes this project's lane rows do not have",
          )
        }
        snapshot = restored
        replayFromSeq = manifest.snapshotSeq
      } catch (err) {
        // A restore can throw part-way through its inserts, so wipe again
        // before replaying from the top. The seed itself is all-or-nothing
        // (ChainHeadReplay.seedFromCellRows), so `replay` is untouched.
        snapshotNote = `ignored projection snapshot: ${String(err)}`
        console.warn(`[rebuild] ${projectId}: ${snapshotNote}`)
        snapshot = null
        replayFromSeq = 0
        await db.batch(wipeProjectionStmts(db, projectId))
      }
    }
  }

  // 2. Load the events this replay has to cover, in server_seq order: the whole
  //    log, or just the tail the snapshot does not already reflect.
  //
  //    The seq predicate is added only when a snapshot was seeded, so the
  //    from-genesis query is the one it always was. `server_seq > 0` would
  //    exclude a seq-0 event, and this replay is the last line of defence for
  //    exactly the kind of log that has one (an event-level migration, a
  //    project copy) — it must never silently skip a row it can see.
  const tailOnly = replayFromSeq > 0
  const { results: eventRows } = await db
    .prepare(
      `SELECT id, schema_version, project_id, file_id, cell_id, parent_id, kind,
              author, payload, client_ts, server_ts, server_seq
       FROM events WHERE project_id = ?${tailOnly ? ' AND server_seq > ?' : ''}
       ORDER BY server_seq ASC, server_ts ASC, id ASC`,
    )
    .bind(...(tailOnly ? [projectId, replayFromSeq] : [projectId]))
    .all<EventRow>()

  if (!eventRows) {
    return new Response('failed to read events from DB', { status: 500 })
  }

  const stmts: AquillaStatement[] = []
  let eventsRead = 0
  let eventsProjected = 0

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
      return new Response(
        `failed to parse payload for event ${row.id}: ${String(parseError)}`,
        { status: 500 },
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
      buildEventProjectionStmts(db, event, stmts, { deferFileCounters: true })
      eventsProjected += 1
    } catch (err) {
      return new Response(
        `failed to build projection for event ${row.id} (kind: ${row.kind}): ${String(err)}`,
        { status: 500 },
      )
    }
  }

  const statementsApplied = stmts.length

  // 4. Apply in batch chunks.
  for (let i = 0; i < stmts.length; i += BATCH_LIMIT) {
    await db.batch(stmts.slice(i, i + BATCH_LIMIT))
  }

  // 4b. Recompute file counters once, set-based (deferred above). Shares one
  //     builder with the live projection and POST /migrate/finalize — this used
  //     to be a third hand-written copy, and it had already drifted, dropping
  //     ai_drafted_count. AQU-1083 made the divergence dangerous rather than
  //     merely untidy: a rebuild running its own SQL would silently put
  //     headings back into a project that had excluded them.
  await projectFileCountersRecomputeStmt(db, projectId, Date.now())
    .run()

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
  const rebuiltSeqRaw = await db
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

  const { results: files } = await db
    .prepare('SELECT id FROM files WHERE project_id = ?')
    .bind(projectId)
    .all<{ id: string }>()
  for (const file of files) {
    await db.batch(fullProgressRecomputeStmts(db, projectId, file.id, Date.now()))
  }

  // 6. Counts.
  const [cellsResult, validatorsResult] = await Promise.all([
    db
      .prepare('SELECT COUNT(*) as cnt FROM cells WHERE project_id = ?')
      .bind(projectId)
      .first<{ cnt: number }>(),
    db
      .prepare('SELECT COUNT(*) as cnt FROM cell_validators WHERE project_id = ?')
      .bind(projectId)
      .first<{ cnt: number }>(),
  ])

  const completedAt = Date.now()

  return Response.json({
    ok: true,
    eventsRead,
    eventsProjected,
    statementsApplied,
    cellsAfter: cellsResult?.cnt ?? 0,
    validatorsAfter: validatorsResult?.cnt ?? 0,
    rebuiltSeq,
    // AQU-1833: what this rebuild actually had to replay. `replayFromSeq` 0 is
    // a from-genesis replay; `snapshotNote` says why a snapshot that existed
    // was not used, so a slow rebuild is never a mystery.
    fromSnapshot: snapshot !== null,
    snapshotSeq: snapshot?.manifest.snapshotSeq ?? null,
    snapshotRowsRestored: snapshot?.rowsRestored ?? null,
    replayFromSeq,
    maxServerSeq,
    ...(snapshotNote ? { snapshotNote } : {}),
    startedAt,
    completedAt,
    note: 'Rebuild is not atomic; if the worker died mid-rebuild, projection rows may be incomplete. Re-run this endpoint to recover.',
  })
}

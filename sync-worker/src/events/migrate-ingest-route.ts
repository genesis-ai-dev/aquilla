// POST /migrate/ingest — trusted bulk event ingest for legacy-Codex migration.
//
// The generic POST /events route binds `author` to the caller's JWT and mints
// its own server-side ids; POST /import does the same and only emits source
// genesis events. Neither can reproduce a *legacy* edit with its ORIGINAL
// author, its ORIGINAL timestamp, and a DETERMINISTIC id. This route can,
// because it is gated on the service credential (SYNC_SECRET_KEY) — the same
// trust tier as /admin/.../rebuild-projection.
//
// The operator CLI (scripts/migrate.ts) parses a legacy project, maps it to a
// stream of fully-formed event envelopes (deterministic UUIDv5 ids, original
// author, legacy clientTs, correct parent chain) and POSTs them here in chunks.
// We reuse buildEventProjectionStmts verbatim, so migrated rows are byte-
// identical to dispatcher / import rows.
//
// Idempotency: events.id is the deterministic key; `INSERT OR IGNORE` drops
// replays and the projection is UPSERT-based (+ self-healing counters), so a
// re-run inserts 0 new events and converges the projection to the same state.
// That idempotency rests on an ATOMICITY INVARIANT (AQU-2025): an event's
// INSERT and every one of its projection statements ride in the SAME
// transaction, so a committed event id always implies a complete projection.
// The replay pre-filter below skips ids already in `events`, which is only
// sound while that holds — otherwise a half-projected event is committed,
// filtered out of every retry, and its missing rows can never be written.
// An interrupted run therefore leaves a clean prefix of whole events and the
// re-run completes the rest.
//
// SECURITY: this route trusts the body's author/id/timestamp. It must NEVER be
// reachable by browser clients — only holders of SYNC_SECRET_KEY may call it.

import { buildEventProjectionStmts, buildBulkSourceCellCreateStmt, coerceIntegerMsPayload, type PersistedEvent } from './event-projection'
import {
  allocateSeqRange,
  buildBulkEventInsertStmt,
  buildSettleSeqRangeStmt,
  type SeqEventInsertRow,
} from './event-insert'
import type { EventKind } from './types'
import { isAuthorizedAdminBearer } from '../lib/admin-auth'
import { dataTargetTagsFromEvents, ensureProjectLanes } from '../../../db/shared/lanes'

// Keep each ingest transaction short so it commits and releases its locks
// quickly — large batches hold a write transaction open longer and serialise
// concurrent ingesters behind it. 100 is the proven sweet spot. Tune CLIENT
// concurrency (migrate-all --concurrency) to saturate throughput, NOT batch size.
//
// This is a bound on a transaction, not a cut point: statements are packed into
// it whole-group-at-a-time (AQU-2025), so a transaction may land a little under
// the limit, and a single event whose group exceeds it rides alone.
const BATCH_LIMIT = 100

export interface MigrateIngestEnv {
  AQUILLA_PG?: AquillaDb
  ADMIN_SECRET?: string
  SYNC_SECRET_KEY?: string
  /** Dedicated migration Worker only; ordinary application traffic stays unchanged. */
  MIGRATION_BULK_SOURCE?: boolean
}

/** One fully-formed event envelope from the migration engine. Unlike RawEvent,
 *  `author` + `clientTs` + `id` are authoritative — that is the trust this
 *  route grants in exchange for the service credential. */
interface IngestEvent {
  id: string
  schemaVersion?: number
  kind: EventKind
  fileId?: string | null
  cellId?: string | null
  parentId?: string | null
  author: string
  clientTs: number
  payload: unknown
}

interface MigrateIngestBody {
  projectId: string
  events: IngestEvent[]
  /** When true, insert ONLY the raw event rows and skip buildEventProjectionStmts.
   *  The firehose path: get every event durable fast (~5x fewer statements/cell),
   *  then derive cells/files/validators/etc. in one efficient per-project rebuild.
   *  Safe only while the project has no live readers (migration window). */
  eventsOnly?: boolean
  /** When true, skip the per-cell file-counter recompute (cell_count, word_count,
   *  etc.) — an O(N²)-per-file UPDATE that the profiler showed was ~67% of all
   *  migration query time. The CLI calls POST /migrate/finalize once per project
   *  afterward to recompute every file's counters set-based (O(total cells)). */
  deferFileCounters?: boolean
}

function isMigrateIngestBody(x: unknown): x is MigrateIngestBody {
  if (typeof x !== 'object' || x === null) return false
  const b = x as Record<string, unknown>
  return typeof b.projectId === 'string' && Array.isArray(b.events)
}

const INGEST_PATH = '/migrate/ingest'

/** Error text safe to log: name + message, truncated. Postgres driver errors
 *  carry the failing statement and its bound values on `query` / `parameters`,
 *  so logging the error object whole would put event payloads, cell text and
 *  credentials into the logs — which the AQU-2025 diagnostics must never do. */
function errSummary(err: unknown): string {
  const e = err as { name?: unknown; message?: unknown } | null
  const name = typeof e?.name === 'string' ? e.name : 'Error'
  const message = typeof e?.message === 'string' ? e.message : String(err)
  return `${name}: ${message}`.slice(0, 500)
}

/**
 * POST /migrate/ingest
 *
 * Body: { projectId, events: IngestEvent[] }
 * Returns: { accepted: number } | error
 * Returns null if the URL doesn't match (chainable in the fetch dispatcher).
 */
export async function handleMigrateIngestRequest(
  request: Request,
  env: MigrateIngestEnv,
): Promise<Response | null> {
  const url = new URL(request.url)
  if (url.pathname !== INGEST_PATH) return null
  if (request.method !== 'POST') {
    return new Response('method not allowed', { status: 405 })
  }
  if (!env.SYNC_SECRET_KEY) {
    return new Response('SYNC_SECRET_KEY not configured', { status: 500 })
  }
  const authHeader = request.headers.get('Authorization') ?? ''
  if (!isAuthorizedAdminBearer(authHeader, env)) {
    return new Response('unauthorized', { status: 401 })
  }
  if (!env.AQUILLA_PG) {
    return new Response('AQUILLA_PG binding not configured', { status: 500 })
  }
  const db = env.AQUILLA_PG
  const pipelined = typeof db.batchPipelined === 'function'

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return new Response('invalid JSON body', { status: 400 })
  }
  if (!isMigrateIngestBody(body)) {
    return new Response('body must be { projectId, events[] }', { status: 400 })
  }

  if (body.events.length === 0) {
    return Response.json({ accepted: 0 })
  }

  // serverTs is monotonic within the request; server_seq comes from the
  // pre-allocated block below. clientTs carries the original legacy edit
  // timestamp (preserves history ordering); it is NOT part of any
  // deterministic id.
  let serverTs = Date.now()
  const eventsOnly = body.eventsOnly === true
  const deferFileCounters = body.deferFileCounters === true
  // Each entry is ONE event's indivisible statement group: its `events` INSERT
  // followed by that event's projection statements, in order (AQU-2025).
  const groups: AquillaStatement[][] = []
  const eventsOnlyRows: SeqEventInsertRow[] = []

  // AQU-2025: ingestion phase timings + counts. Production ingest has been
  // sitting at 10-13s per request with no way to tell whether the time goes to
  // validation, the replay pre-filter, lane upserts, seq allocation or the
  // write transactions, so every diagnosis blamed Cloudflare or Neon by
  // default. DURATIONS AND COUNTS ONLY: no event payloads, no cell text, no
  // credentials and no SQL parameters ever enter these lines.
  const projectId = body.projectId
  const counts = {
    events: body.events.length,
    fresh: 0,
    replayed: 0,
    groups: 0,
    statements: 0,
    transactions: 0,
    oversizedGroups: 0,
  }
  const phases: Record<string, number> = {}
  const startedAt = Date.now()
  let phaseMark = startedAt
  const endPhase = (name: string): void => {
    const now = Date.now()
    phases[name] = now - phaseMark
    phaseMark = now
  }
  const emitDiagnostics = (outcome: string, error?: string): void => {
    const line = {
      projectId,
      outcome,
      eventsOnly,
      deferFileCounters,
      pipelined,
      ...counts,
      phases,
      totalMs: Date.now() - startedAt,
      ...(error ? { error } : {}),
    }
    if (outcome === 'ok') console.log('[migrate-ingest] phases', line)
    else console.error('[migrate-ingest] phases', line)
  }

  // AQU-1005 pass 1: validate + build every projection statement BEFORE taking
  // an allocation. Projection statements don't depend on server_seq, so all of
  // this route's 400s can be raised while the seq ledger is still untouched —
  // a malformed body must not pin the project's advertised reader cursor on a
  // pending allocation for the full PENDING_ALLOC_TTL_MS.
  const prepared: { event: PersistedEvent; row: Omit<SeqEventInsertRow, 'serverSeq'>; projStmts: AquillaStatement[] }[] = []

  for (const e of body.events) {
    if (typeof e.id !== 'string' || typeof e.kind !== 'string' || typeof e.author !== 'string') {
      return new Response('each event needs string id, kind, author', { status: 400 })
    }
    const schemaVersion = e.schemaVersion ?? 1
    if (!Number.isInteger(schemaVersion) || schemaVersion < 1 || schemaVersion > 2) {
      return new Response(`event ${e.id} has unsupported schemaVersion`, { status: 400 })
    }
    const event: PersistedEvent = {
      id: e.id,
      schemaVersion,
      projectId: body.projectId,
      fileId: e.fileId ?? null,
      cellId: e.cellId ?? null,
      parentId: e.parentId ?? null,
      kind: e.kind,
      author: e.author,
      payload: e.payload,
      clientTs: typeof e.clientTs === 'number' ? e.clientTs : Date.now(),
      serverTs: serverTs++,
    }

    const projStmts: AquillaStatement[] = []
    if (!eventsOnly) {
      try {
        buildEventProjectionStmts(db, event, projStmts, { deferFileCounters })
      } catch (err) {
        // Unknown kind or malformed payload — surface the offending event so the
        // CLI can pinpoint it rather than failing the whole batch opaquely.
        return new Response(
          `cannot project event ${event.id} (kind: ${event.kind}): ${String(err)}`,
          { status: 400 },
        )
      }
    }

    prepared.push({
      event: coerceIntegerMsPayload(event),
      row: {
        id: event.id,
        schemaVersion,
        projectId: event.projectId,
        fileId: event.fileId,
        cellId: event.cellId,
        parentId: event.parentId,
        kind: event.kind,
        author: event.author,
        payloadJson: JSON.stringify(event.payload),
        clientTs: event.clientTs,
        serverTs: event.serverTs,
      },
      projStmts,
    })
  }

  endPhase('prepare')

  // AQU-1005: allocate the whole batch's server_seqs in ONE autocommit counter
  // bump BEFORE the write transactions. The old shape ran the bump CTE inside
  // every event INSERT, so the first statement of each pipelined transaction
  // took the project's seq-counter row lock and held it until COMMIT — live
  // editors' single-event writes queued behind bulk ingest for the whole
  // transaction (measured in minutes during the Aug 25–26 storms). With
  // pre-allocation the lock is held for a single round trip. Replayed ids
  // still consume their seq — gaps are harmless, seq is an ordering key.
  // Replay pre-filter: ON CONFLICT (id) DO NOTHING already drops the events
  // row for a retried id, but the projection statements built above would
  // still run and overwrite the cell with the retry's payload. Drop replayed
  // ids up front so a retried chunk is a true no-op.
  const ids = prepared.map((p) => p.row.id)
  const replayed = new Set<string>()
  for (let i = 0; i < ids.length; i += 500) {
    const slice = ids.slice(i, i + 500)
    const found = await db
      .prepare(`SELECT id FROM events WHERE project_id = ? AND id IN (${slice.map(() => '?').join(',')})`)
      .bind(body.projectId, ...slice)
      .all<{ id: string }>()
    for (const r of found.results ?? []) replayed.add(r.id)
  }
  const fresh = replayed.size ? prepared.filter((p) => !replayed.has(p.row.id)) : prepared
  counts.replayed = replayed.size
  counts.fresh = fresh.length
  endPhase('replayFilter')
  if (fresh.length === 0) {
    emitDiagnostics('ok')
    return Response.json({ accepted: 0, replayed: replayed.size })
  }

  // AQU-1240 slice 6: lanes must exist before projection (slice 5) resolves
  // lane_id. Codex upserts the project first (placeholders) then ingests;
  // this call is still required so extra targetLang tags in the chunk get
  // rows, and so already-migrated re-runs stay idempotent.
  try {
    await ensureProjectLanes(db, body.projectId, {
      dataTargetTags: dataTargetTagsFromEvents(body.events),
    })
  } catch (err) {
    endPhase('lanes')
    emitDiagnostics('ensure-lanes-failed', errSummary(err))
    return Response.json({ error: "ensure lanes failed" }, { status: 500 })
  }
  endPhase('lanes')

  let nextSeq: number
  let seqBase: number
  try {
    seqBase = nextSeq = await allocateSeqRange(db, body.projectId, fresh.length)
  } catch (err) {
    endPhase('seqAlloc')
    emitDiagnostics('seq-allocation-failed', errSummary(err))
    return Response.json({ error: "seq allocation failed" }, { status: 500 })
  }
  endPhase('seqAlloc')

  // Pass 2: stamp seqs from the pre-allocated block, in body order, and emit
  // each event's insert ahead of its own projection statements (the ordering
  // pass 1 preserved). Replayed ids were already dropped above.
  for (let i = 0; i < fresh.length;) {
    const first = fresh[i]
    // Only adjacent, distinct source cells in one file with one projection
    // statement may share a bulk upsert. Keep the event insert and projection
    // indivisible under AQU-2025; duplicate cells retain sequential semantics.
    if (env.MIGRATION_BULK_SOURCE && !eventsOnly && deferFileCounters
      && first.event.kind === 'source.cell.create' && first.projStmts.length === 1) {
      const unit: typeof fresh = []
      const seen = new Set<string>()
      while (i + unit.length < fresh.length && unit.length < 200) {
        const item = fresh[i + unit.length]
        const payload = item.event.payload as { cellId?: string }
        const key = String(payload.cellId ?? item.event.cellId)
        if (item.event.kind !== 'source.cell.create' || item.event.fileId !== first.event.fileId
          || item.projStmts.length !== 1 || seen.has(key)) break
        seen.add(key)
        unit.push(item)
      }
      if (unit.length >= 2) {
        groups.push([
          buildBulkEventInsertStmt(db, unit.map(({ row }) => ({ ...row, serverSeq: nextSeq++ }))),
          buildBulkSourceCellCreateStmt(db, unit.map(({ event }) => event)),
        ])
        i += unit.length
        continue
      }
    }
    const { row, projStmts } = fresh[i++]
    const insertRow: SeqEventInsertRow = { ...row, serverSeq: nextSeq++ }
    if (eventsOnly) eventsOnlyRows.push(insertRow)
    else groups.push([buildBulkEventInsertStmt(db, [insertRow]), ...projStmts])
  }

  // Firehose (eventsOnly) rows collapse into multi-row INSERTs — same rows,
  // ~200x fewer statements. 200 rows × 12 cols = 2,400 binds per statement,
  // far under Postgres' 65,535-param ceiling.
  if (eventsOnly) {
    const ROWS_PER_STMT = 200
    for (let i = 0; i < eventsOnlyRows.length; i += ROWS_PER_STMT) {
      groups.push([buildBulkEventInsertStmt(db, eventsOnlyRows.slice(i, i + ROWS_PER_STMT))])
    }
  }

  // Settle the allocation LAST (the groups below are split across multiple
  // runBatch calls) so the ledger row only clears once every event row has
  // actually committed. Its own single-statement group: it depends on nothing
  // in the chunk it rides in, and packing keeps it in the final transaction.
  groups.push([buildSettleSeqRangeStmt(db, body.projectId, seqBase)])
  counts.groups = groups.length

  // Pipelined batch (postgres.js) collapses the per-statement Hyperdrive↔Neon
  // round-trips that dominated ingest (2 RTTs × thousands of stmts ≈ 21 stmts/s
  // — see batchPipelined in db/shim/postgres.ts for the mechanics). Order +
  // atomicity are identical to batch(). Falls back to serial batch() on
  // executors without it (PGlite tests). Larger limit when pipelined: each
  // batch re-pays a ~2-RTT prepare per distinct statement shape (the prepared-
  // statement cache is per connection, and a batch can land on any pooled
  // connection), so fewer, bigger transactions amortize the warm-up; at
  // pipelined speed a 1000-stmt transaction still commits in ~1s.
  const runBatch = pipelined ? db.batchPipelined!.bind(db) : db.batch.bind(db)
  const limit = pipelined ? 1000 : BATCH_LIMIT

  // AQU-2025: pack WHOLE GROUPS into each transaction, never cutting mid-group.
  // This loop used to be `stmts.slice(i, i + limit)` over the flat statement
  // list, which cut wherever the index landed — so an event's INSERT committed
  // in one transaction while the tail of its projection went to the next. A
  // failure in that next transaction left the event id committed with an
  // incomplete projection, and the replay pre-filter above then skipped that id
  // on every retry, so the missing rows could never be written. That is the
  // canary's 249 audio event rows against 248 audio projection rows.
  //
  // Oversized single event: a group that alone exceeds `limit` rides as its own
  // transaction rather than being split. Atomicity wins over the size bound —
  // splitting it is precisely the bug above — and the bound still holds for
  // every other transaction.
  try {
    let chunk: AquillaStatement[] = []
    const flush = async (): Promise<void> => {
      if (chunk.length === 0) return
      await runBatch(chunk)
      counts.transactions++
      counts.statements += chunk.length
      chunk = []
    }
    for (const group of groups) {
      if (chunk.length > 0 && chunk.length + group.length > limit) await flush()
      if (group.length > limit) counts.oversizedGroups++
      chunk.push(...group)
    }
    await flush()
  } catch (err) {
    endPhase('write')
    emitDiagnostics('db-batch-failed', errSummary(err))
    return Response.json({ error: "DB batch failed" }, { status: 500 })
  }
  endPhase('write')
  emitDiagnostics('ok')

  return Response.json({ accepted: fresh.length, replayed: replayed.size })
}

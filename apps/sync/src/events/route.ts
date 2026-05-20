// HTTP fetch handler for POST /events — the AD-2 event ingestion endpoint.
//
// For each event in the request body:
//   1. authorize() — JWT scope + role gate.
//   2. Idempotency: if an event with this id already exists, accept and skip.
//   3. Assign server_ts (Date.now()) and server_seq (per-project monotonic).
//   4. Evaluate the AD-2 first-child-of-parent guard. The event always
//      lands in `events` (so history can surface it); only the projection
//      writes are skipped for stale siblings.
//   5. Dispatch to the kind-specific handler to build D1 statements.
//   6. Batch-commit in D1_BATCH_LIMIT chunks.
//   7. Broadcast event.applied frames to the project DO.
//
// Auth: Authorization: Bearer <sync-token JWT> (same token used for WS upgrades).
//       Each event is authorized independently so a single bad event doesn't
//       tank the whole batch.
//
// Idempotent: event.id is a client-generated UUIDv7. The events INSERT uses
//   INSERT OR IGNORE, so replaying a batch with the same IDs is safe. The
//   parent-chain guard is naturally idempotent — replaying the winning
//   event sees its own row as the existing one and continues to win.

import type { EventKind, RawEvent } from './types'
import type { RealtimeMessage, ProjectionTable } from './realtime'
import { authorize } from './authorize'
import { dispatchEvent } from './dispatch'
import { isWinningChild, type PersistedEvent } from './event-projection'
import { broadcastRealtime } from './broadcast'
import type { BroadcastEnv } from './broadcast'
import { branchingSearch } from '../lib/branching-search/algorithm'
import { loadCorpus } from '../lib/branching-search/corpus'
import { loadBranchingSearchSettings } from '../lib/branching-search/settings'

// Cloudflare D1 max statements per db.batch() call.
const D1_BATCH_LIMIT = 100

function isChainMutatingKind(kind: EventKind): boolean {
  return (
    kind === 'source.cell.create' ||
    kind === 'source.cell.commit' ||
    kind === 'source.cell.delete' ||
    kind === 'source.cell.reorder' ||
    kind === 'target.cell.create' ||
    kind === 'target.cell.commit' ||
    kind === 'target.cell.delete' ||
    kind === 'target.cell.reorder'
  )
}

function chainWinnerKey(event: RawEvent): string | null {
  if (!event.fileId || !event.cellId || !isChainMutatingKind(event.kind)) {
    return null
  }
  const side = event.kind.startsWith('target.') ? 'target' : 'source'
  return [
    event.projectId,
    event.fileId,
    event.cellId,
    event.parentId ?? '',
    side,
  ].join('\u001f')
}

export interface EventsRouteEnv {
  AQUILLA_DB?: D1Database
  SYNC_SECRET_KEY?: string
  /** Optional — when present, successful D1 commits broadcast ProjectSync frames. */
  ProjectSync?: DurableObjectNamespace
}

interface AcceptedEntry {
  id: string
}

interface RejectedEntry {
  id: string
  status: number
  reason: string
}

interface ExistingEventRow {
  server_ts: number
  server_seq: number
}

async function readExistingEvent(
  db: D1Database,
  eventId: string,
): Promise<ExistingEventRow | null> {
  const row = await db
    .prepare('SELECT server_ts, server_seq FROM events WHERE id = ?')
    .bind(eventId)
    .first<ExistingEventRow>()
  return row ?? null
}

/**
 * Reserve the next per-project monotonic server_seq. D1 doesn't expose a
 * cheap atomic counter primitive, so we read MAX+1 and INSERT inside the
 * same logical request. Two concurrent requests against the same project
 * can race — the UNIQUE INDEX idx_events_project_seq catches the duplicate
 * at INSERT time. Callers should be prepared for an occasional INSERT
 * failure and retry by rereading MAX.
 *
 * For the v1 traffic pattern (single editor per project at a time, modest
 * burst from offline reconnect) this is fine. If contention becomes an
 * issue we'll lift assignment into a project-scoped Durable Object.
 */
async function nextServerSeq(
  db: D1Database,
  projectId: string,
): Promise<number> {
  const row = await db
    .prepare('SELECT COALESCE(MAX(server_seq), 0) + 1 AS next_seq FROM events WHERE project_id = ?')
    .bind(projectId)
    .first<{ next_seq: number }>()
  return row?.next_seq ?? 1
}

/**
 * POST /events
 *
 * Body: { events: RawEvent[] }
 *
 * Returns:
 *   {
 *     accepted: [{ id: string }],
 *     rejected: [{ id: string, status: number, reason: string }]
 *   }
 *
 * Returns null if the URL doesn't match (chainable in the fetch dispatcher).
 */
export async function handleEventsWriteRequest(
  request: Request,
  env: EventsRouteEnv,
): Promise<Response | null> {
  // 1. URL match.
  const url = new URL(request.url)
  if (url.pathname !== '/events') return null

  // 2. Method must be POST.
  if (request.method !== 'POST') {
    return new Response('method not allowed', { status: 405 })
  }

  // 3. Env binding validation.
  if (!env.SYNC_SECRET_KEY) {
    return new Response('SYNC_SECRET_KEY not configured', { status: 500 })
  }
  if (!env.AQUILLA_DB) {
    return new Response('AQUILLA_DB binding not configured', { status: 500 })
  }

  const db = env.AQUILLA_DB

  // 4. Parse body.
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return new Response('invalid JSON body', { status: 400 })
  }

  if (
    typeof body !== 'object' ||
    body === null ||
    !('events' in body)
  ) {
    return new Response('body must be an object with an "events" key', { status: 400 })
  }

  const rawBody = body as Record<string, unknown>
  if (!Array.isArray(rawBody.events)) {
    return new Response('"events" must be an array', { status: 400 })
  }

  const rawEvents = rawBody.events as RawEvent[]

  if (rawEvents.length === 0) {
    return Response.json({ accepted: [], rejected: [] })
  }

  // 5. Token extraction.
  const authHeader = request.headers.get('Authorization') ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null

  // Server time base — Date.now() incremented monotonically so two commits
  // in the same request can't share a server_ts. Server_seq is the
  // canonical ordering key, but human-readable timestamps still benefit
  // from monotonicity within a batch.
  let nextServerTs = Date.now()

  // Cache per-project next-seq within this request. The route batches all
  // INSERTs at the end, so reading MAX(server_seq) inside the per-event
  // loop would always see the pre-batch value and assign duplicate seqs
  // to every event in the request. We seed from D1 on first use per
  // project then increment locally.
  const seqByProject = new Map<string, number>()
  async function reserveSeq(projectId: string): Promise<number> {
    const cached = seqByProject.get(projectId)
    const base = cached ?? (await nextServerSeq(db, projectId))
    const assigned = cached === undefined ? base : base + 1
    seqByProject.set(projectId, assigned)
    return assigned
  }

  function makeServerEventId(): string {
    return crypto.randomUUID()
  }

  async function buildValidationEndorsementStmts(
    event: RawEvent<'cell.validate'>,
    author: { username: string; userId: number },
  ): Promise<D1PreparedStatement[]> {
    if (!event.fileId || !event.cellId) return []
    const payload = event.payload as { editEventId?: string }
    if (!payload.editEventId) return []

    const target = await db
      .prepare(
        `SELECT event_id
           FROM cells
          WHERE project_id = ? AND file_id = ? AND cell_id = ? AND side = 'target'`,
      )
      .bind(event.projectId, event.fileId, event.cellId)
      .first<{ event_id: string }>()

    // Do not endorse stale validations against an old target edit.
    if (!target || target.event_id !== payload.editEventId) return []

    const corpus = await loadCorpus(env, { projectId: event.projectId })
    const queryCell = corpus.cells.find((cell) => cell.cellId === event.cellId)
    if (!queryCell?.sourceText || !queryCell.sourceEventId) return []

    const settings = await loadBranchingSearchSettings(env, event.projectId)
    const { results } = branchingSearch(queryCell.sourceText, corpus.cells, settings)
    const endorsedCellIds = results.map((result) => result.cellId)

    // AD-14 requires self-endorsement on validation. The branching search will
    // usually return the query cell; add it defensively if ranking does not.
    if (!endorsedCellIds.includes(event.cellId)) {
      endorsedCellIds.unshift(event.cellId)
    }

    const stmts: D1PreparedStatement[] = []
    for (const endorsedCellId of endorsedCellIds) {
      const endorsementId = makeServerEventId()
      const serverTs = nextServerTs++
      const serverSeq = await reserveSeq(event.projectId)
      const endorsementPayload = {
        endorsedCellId,
        endorsingCellId: event.cellId,
        validatorUserId: author.userId,
        retrievalQueryEventId: queryCell.sourceEventId,
      }

      stmts.push(
        db
          .prepare(
            `INSERT OR IGNORE INTO events (
              id, schema_version, project_id, file_id, cell_id, parent_id, kind,
              author, payload, client_ts, server_ts, server_seq
            ) VALUES (?, 1, ?, ?, ?, NULL, 'cell.endorsement', ?, ?, ?, ?, ?)`,
          )
          .bind(
            endorsementId,
            event.projectId,
            event.fileId,
            endorsedCellId,
            author.username,
            JSON.stringify(endorsementPayload),
            event.clientTs,
            serverTs,
            serverSeq,
          ),
      )
      stmts.push(
        db
          .prepare(
            `UPDATE cells
                SET endorsement_count = endorsement_count + 1
              WHERE project_id = ?
                AND cell_id = ?
                AND side = 'target'`,
          )
          .bind(event.projectId, endorsedCellId),
      )
    }
    return stmts
  }

  const pendingRevokedEndorsements = new Set<string>()
  async function buildEndorsementRevokeStmts(
    event: RawEvent<'cell.unvalidate'>,
    author: { username: string; userId: number },
  ): Promise<D1PreparedStatement[]> {
    if (!event.cellId) return []

    const rows = await db
      .prepare(
        `SELECT e.id
           FROM events e
          WHERE e.project_id = ?
            AND e.kind = 'cell.endorsement'
            AND json_extract(e.payload, '$.endorsingCellId') = ?
            AND json_extract(e.payload, '$.validatorUserId') = ?
            AND NOT EXISTS (
              SELECT 1
                FROM events r
               WHERE r.project_id = e.project_id
                 AND r.kind = 'cell.endorsement.revoke'
                 AND json_extract(r.payload, '$.endorsementEventId') = e.id
            )
          ORDER BY e.server_seq ASC`,
      )
      .bind(event.projectId, event.cellId, author.userId)
      .all<{ id: string }>()

    const stmts: D1PreparedStatement[] = []
    for (const row of rows.results ?? []) {
      if (pendingRevokedEndorsements.has(row.id)) continue
      pendingRevokedEndorsements.add(row.id)

      const revokeId = makeServerEventId()
      const serverTs = nextServerTs++
      const serverSeq = await reserveSeq(event.projectId)
      const revokePayload = { endorsementEventId: row.id }

      stmts.push(
        db
          .prepare(
            `INSERT OR IGNORE INTO events (
              id, schema_version, project_id, file_id, cell_id, parent_id, kind,
              author, payload, client_ts, server_ts, server_seq
            ) VALUES (?, 1, ?, ?, ?, NULL, 'cell.endorsement.revoke', ?, ?, ?, ?, ?)`,
          )
          .bind(
            revokeId,
            event.projectId,
            event.fileId ?? null,
            event.cellId,
            author.username,
            JSON.stringify(revokePayload),
            event.clientTs,
            serverTs,
            serverSeq,
          ),
      )
      stmts.push(
        db
          .prepare(
            `UPDATE cells
                SET endorsement_count = max(0, endorsement_count - 1)
              WHERE project_id = ?
                AND cell_id = (
                  SELECT json_extract(payload, '$.endorsedCellId')
                    FROM events
                   WHERE id = ? AND kind = 'cell.endorsement'
                )
                AND side = 'target'`,
          )
          .bind(event.projectId, row.id),
      )
    }
    return stmts
  }

  const accepted: AcceptedEntry[] = []
  const rejected: RejectedEntry[] = []

  // ── Per-event accumulation ─────────────────────────────────────────────

  interface PendingEntry {
    id: string
    stmtStart: number
    stmtCount: number
    eventFrame: Extract<RealtimeMessage, { t: 'event' }>
    dirtyEntry?: { project: string; file: string; tables: Set<ProjectionTable> }
  }

  const pendingStmts: D1PreparedStatement[] = []
  const pendingEntries: PendingEntry[] = []
  const seenEventIds = new Set<string>()
  const pendingChainWinners = new Set<string>()

  for (const rawEvent of rawEvents) {
    // Authorize.
    const authResult = await authorize(token, rawEvent, env.SYNC_SECRET_KEY)
    if (!authResult.ok) {
      rejected.push({
        id: rawEvent.id ?? '(unknown)',
        status: authResult.status,
        reason: authResult.reason,
      })
      continue
    }

    // Idempotency: same id within batch → accept silently.
    if (seenEventIds.has(rawEvent.id)) {
      accepted.push({ id: rawEvent.id })
      continue
    }
    seenEventIds.add(rawEvent.id)

    // Idempotency: same id across requests → accept silently.
    const existing = await readExistingEvent(db, rawEvent.id)
    if (existing !== null) {
      accepted.push({ id: rawEvent.id })
      continue
    }

    // Assign server_ts (monotone within request) and server_seq (per-project).
    const serverTs = nextServerTs++
    const serverSeq = await reserveSeq(rawEvent.projectId)

    // AD-2 parent-chain decision. The candidate hasn't been INSERTed yet,
    // so `isWinningChild` looks for a prior sibling with the same
    // (project_id, file_id, cell_id, parent_id). If none exists, this
    // candidate wins. The events INSERT below will land it as the chain
    // head and any future sibling with the same parent will see this row
    // as the existing winner.
    //
    // The guard applies only to events that advance `cells.event_id`
    // (the chain-mutating cell.* kinds). Validation kinds and file.create
    // do not compete for the chain head, so they always project.
    const candidate: PersistedEvent = {
      id: rawEvent.id,
      schemaVersion: rawEvent.schemaVersion,
      projectId: rawEvent.projectId,
      fileId: rawEvent.fileId ?? null,
      cellId: rawEvent.cellId ?? null,
      parentId: rawEvent.parentId ?? null,
      kind: rawEvent.kind,
      author: authResult.event.claims.username,
      payload: rawEvent.payload,
      clientTs: rawEvent.clientTs,
      serverTs,
      serverSeq,
    }
    const chainKey = chainWinnerKey(rawEvent)
    let updateProjection = true
    if (chainKey) {
      if (pendingChainWinners.has(chainKey)) {
        updateProjection = false
      } else {
        updateProjection = await isWinningChild(db, candidate)
        if (updateProjection) pendingChainWinners.add(chainKey)
      }
    }

    // Dispatch.
    const outcome = dispatchEvent(db, authResult.event, serverTs, {
      updateProjection,
      serverSeq,
    })
    if (!outcome.ok) {
      rejected.push({
        id: rawEvent.id ?? '(unknown)',
        status: outcome.status,
        reason: outcome.reason,
      })
      continue
    }

    const eventStmts = [...outcome.result.stmts]
    if (updateProjection && rawEvent.kind === 'cell.validate') {
      eventStmts.push(
        ...(await buildValidationEndorsementStmts(
          rawEvent as RawEvent<'cell.validate'>,
          authResult.event.claims,
        )),
      )
    }
    if (updateProjection && rawEvent.kind === 'cell.unvalidate') {
      eventStmts.push(
        ...(await buildEndorsementRevokeStmts(
          rawEvent as RawEvent<'cell.unvalidate'>,
          authResult.event.claims,
        )),
      )
    }

    const stmtsBefore = pendingStmts.length
    for (const stmt of eventStmts) {
      pendingStmts.push(stmt)
    }

    const frame = outcome.result.eventFrame
    let dirtyEntry: PendingEntry['dirtyEntry']
    if (frame.file) {
      dirtyEntry = {
        project: frame.project,
        file: frame.file,
        tables: new Set(outcome.result.dirtyTables),
      }
    }

    pendingEntries.push({
      id: rawEvent.id,
      stmtStart: stmtsBefore,
      stmtCount: pendingStmts.length - stmtsBefore,
      eventFrame: outcome.result.eventFrame,
      dirtyEntry,
    })
  }

  // ── Commit accumulated statements in batch-limit-sized chunks ──────────
  if (pendingStmts.length > 0) {
    interface PendingChunk {
      entries: PendingEntry[]
      stmts: D1PreparedStatement[]
    }

    const chunks: PendingChunk[] = []
    let currentChunk: PendingChunk = { entries: [], stmts: [] }

    for (const entry of pendingEntries) {
      const eventStmts = pendingStmts.slice(
        entry.stmtStart,
        entry.stmtStart + entry.stmtCount,
      )

      if (eventStmts.length > D1_BATCH_LIMIT) {
        rejected.push({
          id: entry.id,
          status: 500,
          reason: `event produced ${eventStmts.length} D1 statements, exceeding batch limit ${D1_BATCH_LIMIT}`,
        })
        continue
      }

      if (
        currentChunk.stmts.length > 0 &&
        currentChunk.stmts.length + eventStmts.length > D1_BATCH_LIMIT
      ) {
        chunks.push(currentChunk)
        currentChunk = { entries: [], stmts: [] }
      }

      currentChunk.entries.push(entry)
      currentChunk.stmts.push(...eventStmts)
    }

    if (currentChunk.stmts.length > 0) {
      chunks.push(currentChunk)
    }

    const committedEntries: PendingEntry[] = []

    try {
      for (const chunk of chunks) {
        await db.batch(chunk.stmts)
        committedEntries.push(...chunk.entries)
      }
    } catch (err) {
      const committed = new Set(committedEntries.map((entry) => entry.id))
      for (const entry of pendingEntries) {
        if (committed.has(entry.id)) {
          accepted.push({ id: entry.id })
        } else if (!rejected.some((r) => r.id === entry.id)) {
          rejected.push({
            id: entry.id,
            status: 500,
            reason: `D1 batch failed: ${String(err)}`,
          })
        }
      }

      return Response.json({ accepted, rejected }, { status: 200 })
    }

    for (const entry of committedEntries) {
      accepted.push({ id: entry.id })
    }

    // Broadcast — non-fatal.
    if (env.ProjectSync && env.SYNC_SECRET_KEY) {
      const broadcastEnv: BroadcastEnv = {
        ProjectSync: env.ProjectSync,
        SYNC_SECRET_KEY: env.SYNC_SECRET_KEY,
      }

      const broadcasts: Promise<void>[] = []
      for (const entry of committedEntries) {
        broadcasts.push(broadcastRealtime(broadcastEnv, entry.eventFrame))
      }

      await Promise.all(broadcasts)
    }
  }

  return Response.json({ accepted, rejected })
}

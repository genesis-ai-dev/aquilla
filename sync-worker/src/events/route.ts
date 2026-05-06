// HTTP fetch handler for POST /events — the CQRS event ingestion endpoint.
//
// Accepts a batch of raw events from authenticated clients, authorizes each
// individually, dispatches to kind-specific handlers, batches the resulting
// D1 statements, and returns a structured accepted/rejected result.
//
// Auth: Authorization: Bearer <sync-token JWT> (same token used for WS upgrades).
//       Each event is authorized independently so a single bad event doesn't
//       tank the whole batch.
//
// Idempotent: event.id is a client-generated UUIDv7. The events INSERT uses
//   INSERT OR IGNORE, so replaying a batch with the same IDs is safe.

import type { RawEvent } from './types'
import type { RealtimeMessage, ProjectionTable } from './realtime'
import { authorize } from './authorize'
import { dispatchEvent } from './dispatch'
import { broadcastRealtime } from './broadcast'
import type { BroadcastEnv } from './broadcast'
import { applyEventToLiveDoc } from './apply-event'
import type { CellCommitPayload } from './hydrate'

// Cloudflare D1 max statements per db.batch() call.
// Exceeding this limit causes D1 to throw at runtime with an unhelpful error.
const D1_BATCH_LIMIT = 100

export interface EventsRouteEnv {
  CODEX_DB?: D1Database
  SYNC_SECRET_KEY?: string
  /** Optional — when present, successful D1 commits broadcast Realtime frames. */
  FileSync?: DurableObjectNamespace
}

interface AcceptedEntry {
  id: string
}

interface RejectedEntry {
  id: string
  status: number
  reason: string
}

async function readExistingEventServerTs(
  db: D1Database,
  eventId: string,
): Promise<number | null> {
  const row = await db
    .prepare('SELECT server_ts FROM events WHERE id = ?')
    .bind(eventId)
    .first<{ server_ts: number }>()
  return typeof row?.server_ts === 'number' ? row.server_ts : null
}

async function readCellLastEditAt(
  db: D1Database,
  fileId: string | undefined,
  cellId: string | undefined,
): Promise<number | null> {
  if (!fileId || !cellId) return null
  const row = await db
    .prepare('SELECT last_edit_at FROM cells WHERE file_id = ? AND cell_id = ?')
    .bind(fileId, cellId)
    .first<{ last_edit_at: number }>()
  return typeof row?.last_edit_at === 'number' ? row.last_edit_at : null
}

/**
 * POST /events
 *
 * Body: { events: RawEvent[] }
 *
 * Auth: Authorization: Bearer <sync-token JWT> (the same token used to upgrade
 * the WS for live editing). The route validates each event independently
 * via authorize() so a single bad event doesn't tank a batch.
 *
 * Returns:
 *   {
 *     accepted: [{ id: string }],
 *     rejected: [{ id: string, status: number, reason: string }]
 *   }
 *
 * Idempotent on event.id (server-side INSERT OR IGNORE). Clients can safely
 * reflush their outbox.
 *
 * Returns null if the URL doesn't match (chainable in the fetch dispatcher).
 */
export async function handleEventsWriteRequest(
  request: Request,
  env: EventsRouteEnv,
): Promise<Response | null> {
  // 1. URL match: only handle /events. Return null to fall through to next handler.
  const url = new URL(request.url)
  if (url.pathname !== '/events') return null

  // 2. Method must be POST.
  if (request.method !== 'POST') {
    return new Response('method not allowed', { status: 405 })
  }

  // 3. Validate required env bindings.
  if (!env.SYNC_SECRET_KEY) {
    return new Response('SYNC_SECRET_KEY not configured', { status: 500 })
  }
  if (!env.CODEX_DB) {
    return new Response('CODEX_DB binding not configured', { status: 500 })
  }

  const db = env.CODEX_DB

  // 4. Parse JSON body. Reject malformed input.
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

  // 5. Empty batch is valid — nothing to do.
  if (rawEvents.length === 0) {
    return Response.json({ accepted: [], rejected: [] })
  }

  // 6. Extract bearer token from Authorization header.
  //    Token may be absent (will result in 401 from authorize()).
  const authHeader = request.headers.get('Authorization') ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null

  // 7. Monotonic server timestamps for this request.
  //    D1 projections use server_ts as their LWW key, so multiple commits to
  //    the same cell in one outbox flush must not share the same timestamp.
  let nextServerTs = Date.now()

  const accepted: AcceptedEntry[] = []
  const rejected: RejectedEntry[] = []

  // Accumulate D1 statements from successful dispatches.
  // We don't commit until all dispatches are done so a bad event further
  // in the batch doesn't leave a partial write.
  const pendingStmts: D1PreparedStatement[] = []

  // Track dirty tables per (project, file) scope for projection.dirty fan-out.
  interface DirtyEntry {
    project: string
    file: string
    tables: Set<ProjectionTable>
  }

  // One entry per successfully-dispatched event (in input order). The route
  // chunks D1 work on these event boundaries so an event INSERT is never
  // committed in one D1 batch while its projection statements wait in another.
  interface PendingEntry {
    id: string
    stmtStart: number
    stmtCount: number
    eventFrame: Extract<RealtimeMessage, { t: 'event' }>
    dirtyEntry?: DirtyEntry
    /** When the event is a cell.commit with a fileId, captured here so the
     *  post-commit hot-apply step can reach the live DO. Other kinds leave
     *  this undefined and are skipped. */
    commitForLiveDoc?: {
      projectId: string
      fileId: string
      cellId: string
      payload: CellCommitPayload
    }
  }
  const pendingEntries: PendingEntry[] = []

  const seenEventIds = new Set<string>()

  for (const rawEvent of rawEvents) {
    // Authorize each event independently.
    const authResult = await authorize(token, rawEvent, env.SYNC_SECRET_KEY)
    if (!authResult.ok) {
      rejected.push({
        id: rawEvent.id ?? '(unknown)',
        status: authResult.status,
        reason: authResult.reason,
      })
      continue
    }

    if (seenEventIds.has(rawEvent.id)) {
      accepted.push({ id: rawEvent.id })
      continue
    }
    seenEventIds.add(rawEvent.id)

    const existingServerTs = await readExistingEventServerTs(db, rawEvent.id)
    if (existingServerTs !== null) {
      accepted.push({ id: rawEvent.id })
      continue
    }

    const cellLastEditAt = await readCellLastEditAt(db, rawEvent.fileId, rawEvent.cellId)
    const serverTs = Math.max(nextServerTs++, (cellLastEditAt ?? 0) + 1)
    nextServerTs = Math.max(nextServerTs, serverTs + 1)

    // Dispatch to the kind-specific handler.
    const outcome = dispatchEvent(db, authResult.event, serverTs)
    if (!outcome.ok) {
      rejected.push({
        id: rawEvent.id ?? '(unknown)',
        status: outcome.status,
        reason: outcome.reason,
      })
      continue
    }

    // Accumulate statements and metadata for later commit.
    const stmtsBefore = pendingStmts.length
    for (const stmt of outcome.result.stmts) {
      pendingStmts.push(stmt)
    }

    // Accumulate dirty tables keyed by (project, file) scope.
    const frame = outcome.result.eventFrame
    let dirtyEntry: DirtyEntry | undefined
    if (frame.file) {
      dirtyEntry = {
        project: frame.project,
        file: frame.file,
        tables: new Set(outcome.result.dirtyTables),
      }
    }
    let commitForLiveDoc: PendingEntry['commitForLiveDoc']
    if (
      rawEvent.kind === 'cell.commit' &&
      rawEvent.fileId &&
      rawEvent.cellId
    ) {
      commitForLiveDoc = {
        projectId: rawEvent.projectId,
        fileId: rawEvent.fileId,
        cellId: rawEvent.cellId,
        payload: rawEvent.payload as CellCommitPayload,
      }
    }

    pendingEntries.push({
      id: rawEvent.id,
      stmtStart: stmtsBefore,
      stmtCount: pendingStmts.length - stmtsBefore,
      eventFrame: outcome.result.eventFrame,
      dirtyEntry,
      commitForLiveDoc,
    })
  }

  // 8. Commit accumulated statements in D1_BATCH_LIMIT-sized chunks.
  //    Only add to accepted AFTER successful commit (step 9).
  //    On partial failure, report uncommitted events as rejected.
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

    // All batches succeeded — accept every dispatched event (preserving order,
    // including duplicates — e.g. same event submitted twice in one request).
    for (const entry of committedEntries) {
      accepted.push({ id: entry.id })
    }

    // Broadcast event frames then projection.dirty messages — non-fatal.
    // Only attempt broadcast if FileSync is available (it won't be in
    // envs that have CODEX_DB but no FileSync binding).
    if (env.FileSync && env.SYNC_SECRET_KEY) {
      const broadcastEnv: BroadcastEnv = {
        FileSync: env.FileSync,
        SYNC_SECRET_KEY: env.SYNC_SECRET_KEY,
      }

      // Coalesce dirty tables per (project, file) before broadcast.
      const dirtyByScope = new Map<string, { project: string; file: string; tables: Set<ProjectionTable> }>()
      for (const entry of committedEntries) {
        if (!entry.dirtyEntry) continue
        const dirty = entry.dirtyEntry
        const key = `${dirty.project}|${dirty.file}`
        const existing = dirtyByScope.get(key)
        if (existing) {
          for (const t of dirty.tables) existing.tables.add(t)
        } else {
          dirtyByScope.set(key, { project: dirty.project, file: dirty.file, tables: new Set(dirty.tables) })
        }
      }

      // Fan out all event frames and coalesced projection.dirty messages in
      // parallel. broadcastRealtime is non-throwing so Promise.all is safe.
      const broadcasts: Promise<void>[] = []
      for (const entry of committedEntries) {
        broadcasts.push(broadcastRealtime(broadcastEnv, entry.eventFrame))
      }
      for (const { project, file, tables } of dirtyByScope.values()) {
        broadcasts.push(broadcastRealtime(broadcastEnv, {
          v: 1,
          t: 'projection.dirty',
          project,
          file,
          tables: [...tables],
        }))
      }

      // Hot-update: send each cell.commit's payload to its file's live DO so
      // imported cells appear in any open editor without a reload. The DO
      // applies in `new-only` mode, leaving cells already in the doc alone
      // (their CRDT state is governed by the live editing path). De-duped
      // by (project, file, cell): multiple commits to the same cell in one
      // batch only need the latest one applied to the live doc.
      const liveApplyByCell = new Map<string, NonNullable<PendingEntry['commitForLiveDoc']>>()
      for (const entry of committedEntries) {
        if (!entry.commitForLiveDoc) continue
        const key = `${entry.commitForLiveDoc.projectId}|${entry.commitForLiveDoc.fileId}|${entry.commitForLiveDoc.cellId}`
        liveApplyByCell.set(key, entry.commitForLiveDoc) // last write wins
      }
      for (const input of liveApplyByCell.values()) {
        broadcasts.push(applyEventToLiveDoc(broadcastEnv, input))
      }

      // broadcastRealtime / applyEventToLiveDoc are non-throwing; Promise.all
      // is safe here.
      await Promise.all(broadcasts)
    }
  }

  // 9. Return structured result.
  return Response.json({ accepted, rejected })
}

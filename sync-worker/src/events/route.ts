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

// Cloudflare D1 max statements per db.batch() call.
// Exceeding this limit causes D1 to throw at runtime with an unhelpful error.
const D1_BATCH_LIMIT = 100

export interface EventsRouteEnv {
  CODEX_DB?: D1Database
  SYNC_SECRET_KEY?: string
}

interface AcceptedEntry {
  id: string
}

interface RejectedEntry {
  id: string
  status: number
  reason: string
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

  // 7. One server timestamp for the entire batch.
  //    All events in a single request share the same server_ts; tie-breaking
  //    uses the input order within the batch.
  const serverTs = Date.now()

  const accepted: AcceptedEntry[] = []
  const rejected: RejectedEntry[] = []

  // Accumulate D1 statements from successful dispatches.
  // We don't commit until all dispatches are done so a bad event further
  // in the batch doesn't leave a partial write.
  const pendingStmts: D1PreparedStatement[] = []

  // One entry per successfully-dispatched event (in input order). Each entry
  // records how many statements belong to it so we can attribute D1 batch
  // failures to specific events for partial-success reporting.
  interface PendingEntry {
    id: string
    stmtCount: number
  }
  const pendingEntries: PendingEntry[] = []

  // TODO(Task B): accumulate eventFrames for Realtime broadcast after D1 commit.
  // When Task B is implemented, hook into this array to fan out
  // projection.dirty messages to all room participants for each dirty file.
  const pendingEventFrames: Array<Extract<RealtimeMessage, { t: 'event' }>> = []
  const pendingDirtyTables: Set<ProjectionTable> = new Set()

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
    pendingEntries.push({ id: rawEvent.id, stmtCount: pendingStmts.length - stmtsBefore })
    pendingEventFrames.push(outcome.result.eventFrame)
    for (const table of outcome.result.dirtyTables) {
      pendingDirtyTables.add(table)
    }
  }

  // 8. Commit accumulated statements in D1_BATCH_LIMIT-sized chunks.
  //    Only add to accepted AFTER successful commit (step 9).
  //    On partial failure, report uncommitted events as rejected.
  if (pendingStmts.length > 0) {
    // Track how many statements have committed so we can attribute failures.
    let stmtsCommitted = 0

    try {
      for (let i = 0; i < pendingStmts.length; i += D1_BATCH_LIMIT) {
        await db.batch(pendingStmts.slice(i, i + D1_BATCH_LIMIT))
        stmtsCommitted += Math.min(D1_BATCH_LIMIT, pendingStmts.length - i)
      }
    } catch (err) {
      // D1 batch failed mid-flight. Attribute partial success by comparing
      // each entry's statement range against stmtsCommitted.
      let stmtOffset = 0
      for (const entry of pendingEntries) {
        const entryEnd = stmtOffset + entry.stmtCount
        if (entryEnd <= stmtsCommitted) {
          // All statements for this event committed before the failure.
          accepted.push({ id: entry.id })
        } else {
          // Some or all statements for this event did not commit.
          rejected.push({
            id: entry.id,
            status: 500,
            reason: `D1 batch failed: ${String(err)}`,
          })
        }
        stmtOffset = entryEnd
      }

      return Response.json({ accepted, rejected }, { status: 200 })
    }

    // All batches succeeded — accept every dispatched event (preserving order,
    // including duplicates — e.g. same event submitted twice in one request).
    for (const entry of pendingEntries) {
      accepted.push({ id: entry.id })
    }
  }

  // 9. Return structured result.
  return Response.json({ accepted, rejected })
}

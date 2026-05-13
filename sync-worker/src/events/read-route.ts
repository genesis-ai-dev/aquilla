// HTTP fetch handler for GET /events — the CQRS event read endpoint.
//
// Reads the audit log from D1 with optional filters. Auth via sync-token JWT
// (viewer level is sufficient for reading history).

import { verifyTokenForFile } from "../auth"

export interface EventsReadEnv {
  AQUILLA_DB?: D1Database
  SYNC_SECRET_KEY?: string
}

/**
 * GET /events?fileId=...&cellId=...&before=...&limit=50
 *
 * Auth: Authorization: Bearer <sync-token JWT>. The token's `fileId` claim
 * must match the query's fileId. The token's `projectId` is used to scope
 * the query (no need to pass projectId as a query param — we take it from
 * the verified token claims).
 *
 * Query parameters (all from URL searchParams):
 *   fileId    — required. Restricts to this file's events.
 *   cellId    — optional. Further restricts to this cell.
 *   before    — optional. server_ts cutoff (events with server_ts < before).
 *   limit     — optional. Default 50. Max 200. Clamped, not 400'd.
 *
 * Response: { events: Array<{ id, kind, projectId, fileId, cellId, author, payload, clientTs, serverTs }> }
 * Ordered by server_ts DESC, limit applied.
 *
 * Returns null if the URL or method doesn't match (chainable in the fetch dispatcher).
 */
export async function handleEventsReadRequest(
  request: Request,
  env: EventsReadEnv,
): Promise<Response | null> {
  const url = new URL(request.url)

  // Only handle GET /events — return null so other handlers can pick up
  // non-matching paths or methods.
  if (url.pathname !== "/events") return null
  if (request.method !== "GET") return null

  // Validate env bindings before auth so startup misconfigurations surface
  // clearly (avoids a misleading 401 when the real problem is a missing env var).
  if (!env.SYNC_SECRET_KEY) {
    return new Response("SYNC_SECRET_KEY not configured", { status: 500 })
  }
  if (!env.AQUILLA_DB) {
    return new Response("AQUILLA_DB binding not configured", { status: 500 })
  }

  // Extract bearer token.
  const authHeader = request.headers.get("Authorization") ?? ""
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null
  if (!token) {
    return new Response("missing Authorization header", { status: 401 })
  }

  // Parse required fileId first (needed for token verification).
  const qFileId = url.searchParams.get("fileId")
  if (!qFileId) {
    return new Response("missing fileId", { status: 400 })
  }

  // Verify token — only requires fileId match; projectId comes from claims.
  const authResult = await verifyTokenForFile(token, qFileId, env.SYNC_SECRET_KEY)
  if (!authResult.ok) {
    return new Response(authResult.reason, { status: authResult.status })
  }

  const projectId = authResult.claims.projectId

  // Parse optional filters.
  const qCellId = url.searchParams.get("cellId") ?? null

  let before: number | null = null
  const qBefore = url.searchParams.get("before")
  if (qBefore !== null) {
    const parsed = parseInt(qBefore, 10)
    if (isNaN(parsed)) {
      return new Response("invalid before: must be an integer", { status: 400 })
    }
    before = parsed
  }

  const DEFAULT_LIMIT = 50
  const MIN_LIMIT = 1
  const MAX_LIMIT = 200
  let limit = DEFAULT_LIMIT
  const qLimit = url.searchParams.get("limit")
  if (qLimit !== null) {
    const parsed = parseInt(qLimit, 10)
    // Clamp rather than 400 for out-of-range values.
    if (!isNaN(parsed)) {
      limit = Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, parsed))
    }
  }

  // Build the SQL query dynamically based on which optional filters are present.
  const parts: string[] = [
    "SELECT id, schema_version, project_id, file_id, cell_id, kind, author, payload, client_ts, server_ts",
    "FROM events",
    "WHERE project_id = ? AND file_id = ?",
  ]
  const binds: unknown[] = [projectId, qFileId]

  if (qCellId !== null) {
    parts.push("AND cell_id = ?")
    binds.push(qCellId)
  }
  if (before !== null) {
    parts.push("AND server_ts < ?")
    binds.push(before)
  }

  parts.push("ORDER BY server_ts DESC, id DESC")
  parts.push("LIMIT ?")
  binds.push(limit)

  const sql = parts.join(" ")

  interface EventRowRaw {
    id: string
    schema_version: number
    project_id: string
    file_id: string | null
    cell_id: string | null
    kind: string
    author: string
    payload: string
    client_ts: number
    server_ts: number
  }

  const result = await env.AQUILLA_DB.prepare(sql)
    .bind(...binds)
    .all<EventRowRaw>()

  const events = result.results.map((row) => ({
    id: row.id,
    schemaVersion: row.schema_version,
    kind: row.kind,
    projectId: row.project_id,
    fileId: row.file_id,
    cellId: row.cell_id,
    author: row.author,
    payload: (() => {
      try {
        return JSON.parse(row.payload)
      } catch {
        return row.payload
      }
    })(),
    clientTs: row.client_ts,
    serverTs: row.server_ts,
  }))

  return Response.json({ events })
}

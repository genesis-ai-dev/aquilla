// Per-cell event history read route (Phase 2b).
//
//   GET /api/v1/projects/:projectId/files/:fileId/cells/:cellId/history
//
// Returns the events on this cell's chain (newest first). Walks the
// `(project_id, file_id, cell_id)` event log in `server_seq DESC` order and
// caps at MAX_LIMIT events — Bible-sized projects rarely accumulate hundreds
// of events on a single cell, but a malformed projection (cycle, runaway
// importer) could hit the wall safely.
//
// Auth: sync-token JWT scoped to `projectId`; minimum role viewer (100).

import { verifyTokenForProject } from "../auth"

export interface CellHistoryReadEnv {
  AQUILLA_DB?: D1Database
  SYNC_SECRET_KEY?: string
}

interface EventRowRaw {
  id: string
  parent_id: string | null
  kind: string
  author: string
  payload: string
  client_ts: number
  server_ts: number
  server_seq: number
}

interface CellHistoryEvent {
  id: string
  parentId: string | null
  kind: string
  author: string
  clientTs: number
  serverTs: number
  serverSeq: number
  /** Parsed JSON payload — payloads are kind-specific (see 03-data-model.md). */
  payload: unknown
}

const PATH_RE = /^\/api\/v1\/projects\/([^/]+)\/files\/([^/]+)\/cells\/([^/]+)\/history$/

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

export async function handleCellHistoryReadRequest(
  request: Request,
  env: CellHistoryReadEnv,
): Promise<Response | null> {
  const url = new URL(request.url)
  const match = url.pathname.match(PATH_RE)
  if (!match) return null
  if (request.method !== "GET") return null

  if (!env.SYNC_SECRET_KEY) {
    return new Response("SYNC_SECRET_KEY not configured", { status: 500 })
  }
  if (!env.AQUILLA_DB) {
    return new Response("AQUILLA_DB binding not configured", { status: 500 })
  }

  const projectId = decodeURIComponent(match[1])
  const fileId = decodeURIComponent(match[2])
  const cellId = decodeURIComponent(match[3])

  const authHeader = request.headers.get("Authorization") ?? ""
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null
  if (!token) {
    return new Response("missing Authorization header", { status: 401 })
  }

  const auth = await verifyTokenForProject(token, projectId, env.SYNC_SECRET_KEY)
  if (!auth.ok) {
    return new Response(auth.reason, { status: auth.status })
  }

  let limit = DEFAULT_LIMIT
  const qLimit = url.searchParams.get("limit")
  if (qLimit !== null) {
    const parsed = parseInt(qLimit, 10)
    if (!isNaN(parsed)) {
      limit = Math.min(MAX_LIMIT, Math.max(1, parsed))
    }
  }

  // server_seq DESC + id DESC for a deterministic stable order across rows
  // sharing the same seq (shouldn't happen given the UNIQUE idx, but the
  // tiebreak is cheap insurance). Walk only this cell's chain — both sides
  // of a paired cell share `cell_id` but live in distinct `file_id`s so
  // filtering on (project_id, file_id, cell_id) gives us exactly one side.
  const sql =
    "SELECT id, parent_id, kind, author, payload, client_ts, server_ts, server_seq " +
    "FROM events " +
    "WHERE project_id = ? AND file_id = ? AND cell_id = ? " +
    "ORDER BY server_seq DESC, id DESC " +
    "LIMIT ?"
  const result = await env.AQUILLA_DB.prepare(sql)
    .bind(projectId, fileId, cellId, limit)
    .all<EventRowRaw>()

  const events: CellHistoryEvent[] = result.results.map((row) => ({
    id: row.id,
    parentId: row.parent_id,
    kind: row.kind,
    author: row.author,
    clientTs: row.client_ts,
    serverTs: row.server_ts,
    serverSeq: row.server_seq,
    payload: (() => {
      try {
        return JSON.parse(row.payload)
      } catch {
        return row.payload
      }
    })(),
  }))

  return Response.json({ events })
}

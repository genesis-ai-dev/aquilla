// Per-file cell back-translation read route.
//
//   GET /api/v1/projects/:projectId/files/:fileId/backtranslations
//
// Returns the **latest** BT row per cell for a given file/project — the row
// whose target_event_id matches the cell's current cells.event_id is the
// "fresh" BT; the client compares returned targetEventId against cells.eventId
// to detect stale BTs without a second round-trip.
//
// Query params:
//   cellIds=a,b,c  — optional comma-separated cell ids to scope the response.
//                    Omit to fetch all BTs for the file.
//
// Auth: sync-token JWT scoped to projectId; viewer (100) and up — BTs are
// readable by anyone who can open the project; writing requires contributor+
// (enforced on the write side via role-policy.ts).

import { verifyTokenForProject } from "../auth"

export interface CellBacktranslationsReadEnv {
  AQUILLA_DB?: D1Database
  SYNC_SECRET_KEY?: string
}

const PATH_RE = /^\/api\/v1\/projects\/([^/]+)\/files\/([^/]+)\/backtranslations$/

interface BtRowRaw {
  cell_id: string
  target_event_id: string
  bt_text: string
  bt_html: string | null
  polished: number
  author: string
  event_id: string
  created_at: number
}

interface BtRowOut {
  cellId: string
  targetEventId: string
  btText: string
  btHtml: string | null
  polished: boolean
  author: string
  eventId: string
  createdAt: number
}

function mapRow(r: BtRowRaw): BtRowOut {
  return {
    cellId: r.cell_id,
    targetEventId: r.target_event_id,
    btText: r.bt_text,
    btHtml: r.bt_html,
    polished: r.polished === 1,
    author: r.author,
    eventId: r.event_id,
    createdAt: r.created_at,
  }
}

/**
 * GET /api/v1/projects/:projectId/files/:fileId/backtranslations
 *
 * Returns:
 *   { backtranslations: BtRowOut[] }
 *
 * Each entry is the most recent BT (highest created_at) per cell in the file.
 * The client compares `targetEventId` against `cells.eventId` to detect staleness.
 *
 * Returns null if the URL doesn't match (chainable in the fetch dispatcher).
 */
export async function handleCellBacktranslationsReadRequest(
  request: Request,
  env: CellBacktranslationsReadEnv,
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

  const authHeader = request.headers.get("Authorization") ?? ""
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null
  if (!token) return new Response("missing Authorization header", { status: 401 })

  const auth = await verifyTokenForProject(token, projectId, env.SYNC_SECRET_KEY)
  if (!auth.ok) return new Response(auth.reason, { status: auth.status })

  // Optional per-cell filter (mirrors cells-read-route cellIds param).
  const qCellIds = url.searchParams.get("cellIds")
  const cellIdsFilter = qCellIds
    ? qCellIds.split(",").map((s) => s.trim()).filter((s) => s.length > 0).slice(0, 100)
    : null

  // Select the latest BT per cell using a window-function approach:
  // group by cell_id and take the row with the maximum created_at.
  // SQLite supports this via a correlated subquery or ROW_NUMBER().
  // Using a simple "latest per group" CTE pattern for readability.
  const parts: string[] = [
    `SELECT cell_id, target_event_id, bt_text, bt_html, polished, author, event_id, created_at`,
    `FROM cell_backtranslations`,
    `WHERE project_id = ? AND file_id = ?`,
    `  AND created_at = (`,
    `    SELECT MAX(b2.created_at) FROM cell_backtranslations b2`,
    `    WHERE b2.project_id = cell_backtranslations.project_id`,
    `      AND b2.file_id    = cell_backtranslations.file_id`,
    `      AND b2.cell_id    = cell_backtranslations.cell_id`,
    `  )`,
  ]
  const binds: unknown[] = [projectId, fileId]

  if (cellIdsFilter && cellIdsFilter.length > 0) {
    const placeholders = cellIdsFilter.map(() => "?").join(", ")
    parts.push(`AND cell_id IN (${placeholders})`)
    binds.push(...cellIdsFilter)
  }

  const sql = parts.join(" ")
  const result = await env.AQUILLA_DB.prepare(sql).bind(...binds).all<BtRowRaw>()

  return Response.json({
    backtranslations: (result.results ?? []).map(mapRow),
  })
}

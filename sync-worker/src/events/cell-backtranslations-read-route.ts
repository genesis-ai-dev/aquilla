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
//   lane=<tag>     — target lane (legacy_tag). Absent or '' is the lane whose
//                    legacy_tag is ''. A NULL lane_id is that same lane, so
//                    rows written before the AQU-1616 backfill stay visible
//                    there and nowhere else.
//
// Auth: sync-token JWT scoped to projectId; viewer (100) and up — BTs are
// readable by anyone who can open the project; writing requires contributor+
// (enforced on the write side via role-policy.ts). AQU-730: when the read
// wall is on, the requested lane must be one the caller was granted.

import { verifyTokenForProject } from "../auth"
import { backtranslationLaneMatchBinds, backtranslationLaneMatchSql } from "./lane-id-sql"
import { canReadRequestedLane, visibleLanesForRead } from "./lane-read-wall"

export interface CellBacktranslationsReadEnv {
  AQUILLA_PG?: AquillaDb
  SYNC_SECRET_KEY?: string
  /** AQU-730: "1" enforces lane grants on this read. Unset = every lane. */
  LANE_READ_WALL?: string
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
  if (!env.AQUILLA_PG) {
    return new Response("AQUILLA_PG binding not configured", { status: 500 })
  }

  const projectId = decodeURIComponent(match[1])
  const fileId = decodeURIComponent(match[2])

  const authHeader = request.headers.get("Authorization") ?? ""
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null
  if (!token) return new Response("missing Authorization header", { status: 401 })

  const auth = await verifyTokenForProject(token, projectId, env.SYNC_SECRET_KEY)
  if (!auth.ok) return new Response(auth.reason, { status: auth.status })

  // Absent lane is the default lane, so a client that predates ?lane= still
  // sees the readings it saw before lanes (NULL lane_id included).
  const lane = url.searchParams.get("lane") ?? ""
  if (lane.length > 64) {
    return new Response("invalid lane: must be 64 characters or fewer", { status: 400 })
  }

  const visibleLanes = visibleLanesForRead(env.LANE_READ_WALL, auth.claims)
  const laneAllowed = await canReadRequestedLane(env.AQUILLA_PG, projectId, visibleLanes, lane)
  if (!laneAllowed) {
    return Response.json(
      { backtranslations: [] },
      { headers: { "Cache-Control": "private, no-store" } },
    )
  }

  // Optional per-cell filter (mirrors cells-read-route cellIds param).
  const qCellIds = url.searchParams.get("cellIds")
  const cellIdsFilter = qCellIds
    ? qCellIds.split(",").map((s) => s.trim()).filter((s) => s.length > 0).slice(0, 100)
    : null

  // Latest BT per cell WITHIN the requested lane. The MAX has to be lane-scoped
  // too: a newer reading on another lane must not hide this lane's row.
  const laneMatch = backtranslationLaneMatchSql()
  const laneMatchInner = backtranslationLaneMatchSql("b2")
  const parts: string[] = [
    `SELECT cell_id, target_event_id, bt_text, bt_html, polished, author, event_id, created_at`,
    `FROM cell_backtranslations`,
    `WHERE project_id = ? AND file_id = ?`,
    `  AND ${laneMatch}`,
    `  AND created_at = (`,
    `    SELECT MAX(b2.created_at) FROM cell_backtranslations b2`,
    `    WHERE b2.project_id = cell_backtranslations.project_id`,
    `      AND b2.file_id    = cell_backtranslations.file_id`,
    `      AND b2.cell_id    = cell_backtranslations.cell_id`,
    `      AND ${laneMatchInner}`,
    `  )`,
  ]
  const binds: unknown[] = [
    projectId,
    fileId,
    ...backtranslationLaneMatchBinds(projectId, lane),
    ...backtranslationLaneMatchBinds(projectId, lane),
  ]

  if (cellIdsFilter && cellIdsFilter.length > 0) {
    const placeholders = cellIdsFilter.map(() => "?").join(", ")
    parts.push(`AND cell_id IN (${placeholders})`)
    binds.push(...cellIdsFilter)
  }

  const sql = parts.join(" ")
  const result = await env.AQUILLA_PG.prepare(sql).bind(...binds).all<BtRowRaw>()

  return Response.json({
    backtranslations: (result.results ?? []).map(mapRow),
  })
}

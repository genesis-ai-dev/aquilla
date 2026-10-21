// Per-file hand-corrected statistical gloss read route (AQU-1408 §1).
//
//   GET /api/v1/projects/:projectId/files/:fileId/glosses
//
// Returns the **latest** corrected gloss per cell for a given file/project.
// The gloss a cell shows is computed in the browser from the project's own
// translated pairs; a row here is the text a contributor put in its place, and
// the client prefers it over the computed one. As with back-translations the
// row is pinned to `targetEventId`, so the client compares that against
// `cells.eventId` to tell a correction of the live text from a correction of
// something that has since been re-translated.
//
// Query params:
//   cellIds=a,b,c  — optional comma-separated cell ids to scope the response.
//   lane=<tag>     — target lane (legacy_tag). Absent or '' is the lane whose
//                    legacy_tag is ''; a NULL lane_id belongs to that lane.
//
// Auth: sync-token JWT scoped to projectId; viewer (100) and up — reading a
// gloss is reading the project. Writing one is contributor+, enforced on the
// write side in role-policy.ts. AQU-730: when the read wall is on, the
// requested lane must be one the caller was granted.

import { verifyTokenForProject } from "../auth"
import { backtranslationLaneMatchBinds, backtranslationLaneMatchSql } from "./lane-id-sql"
import { canReadRequestedLane, visibleLanesForRead } from "./lane-read-wall"

export interface CellGlossesReadEnv {
  AQUILLA_PG?: AquillaDb
  SYNC_SECRET_KEY?: string
  /** AQU-730: "1" enforces lane grants on this read. Unset = every lane. */
  LANE_READ_WALL?: string
}

const PATH_RE = /^\/api\/v1\/projects\/([^/]+)\/files\/([^/]+)\/glosses$/

interface GlossRowRaw {
  cell_id: string
  target_event_id: string
  gloss_text: string
  author: string
  event_id: string
  created_at: number
}

interface GlossRowOut {
  cellId: string
  targetEventId: string
  glossText: string
  author: string
  eventId: string
  createdAt: number
}

function mapRow(r: GlossRowRaw): GlossRowOut {
  return {
    cellId: r.cell_id,
    targetEventId: r.target_event_id,
    glossText: r.gloss_text,
    author: r.author,
    eventId: r.event_id,
    createdAt: r.created_at,
  }
}

/**
 * GET /api/v1/projects/:projectId/files/:fileId/glosses
 *
 * Returns `{ glosses: GlossRowOut[] }` — the most recent corrected gloss
 * (highest created_at) per cell in the file, within the requested lane.
 *
 * Returns null if the URL doesn't match (chainable in the fetch dispatcher).
 */
export async function handleCellGlossesReadRequest(
  request: Request,
  env: CellGlossesReadEnv,
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

  const lane = url.searchParams.get("lane") ?? ""
  if (lane.length > 64) {
    return new Response("invalid lane: must be 64 characters or fewer", { status: 400 })
  }

  const visibleLanes = visibleLanesForRead(env.LANE_READ_WALL, auth.claims)
  const laneAllowed = await canReadRequestedLane(env.AQUILLA_PG, projectId, visibleLanes, lane)
  if (!laneAllowed) {
    return Response.json(
      { glosses: [] },
      { headers: { "Cache-Control": "private, no-store" } },
    )
  }

  const qCellIds = url.searchParams.get("cellIds")
  const cellIdsFilter = qCellIds
    ? qCellIds.split(",").map((s) => s.trim()).filter((s) => s.length > 0).slice(0, 100)
    : null

  // Latest gloss per cell WITHIN the requested lane. The MAX is lane-scoped
  // too, for the same reason as the back-translation read: a newer correction
  // on another lane must not hide this lane's row.
  const laneMatch = backtranslationLaneMatchSql()
  const laneMatchInner = backtranslationLaneMatchSql("g2")
  const parts: string[] = [
    `SELECT cell_id, target_event_id, gloss_text, author, event_id, created_at`,
    `FROM cell_glosses`,
    `WHERE project_id = ? AND file_id = ?`,
    `  AND ${laneMatch}`,
    `  AND created_at = (`,
    `    SELECT MAX(g2.created_at) FROM cell_glosses g2`,
    `    WHERE g2.project_id = cell_glosses.project_id`,
    `      AND g2.file_id    = cell_glosses.file_id`,
    `      AND g2.cell_id    = cell_glosses.cell_id`,
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
  const result = await env.AQUILLA_PG.prepare(sql).bind(...binds).all<GlossRowRaw>()

  return Response.json({
    glosses: (result.results ?? []).map(mapRow),
  })
}

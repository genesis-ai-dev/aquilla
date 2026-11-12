// GET /api/v1/projects/:projectId/cells/by-ref — Smart Extensions apiRev 7.
//
// One round trip for "everything about this verse across these files": an
// editor extension that shows ULT, notes, questions and word links side by side
// asks for TIT 1:1 in N files instead of reading N whole books.
//
// Query:
//   files=<id>,<id>,…   REQUIRED, at most 50. Every query is file-scoped, so it
//                       runs on idx_cells_file_scan (project, file, side, lane,
//                       cell) with canonical_ref as a filter — no new index
//                       (verified with EXPLAIN in the worker test).
//   refs=<ref>|<ref>|…  exact canonical refs ("TIT 1:1"), at most 200, OR
//   prefix=<text>       refs starting with it ("TIT 1:" = a chapter), ≥ 2 chars
//   lane=<tag>          target lane (absent = the default lane '')
//
// Response: { cells: CellRowOut-with-fileId[], truncated } — source rows plus
// the lane's target rows, capped at MAX_ROWS. Lane read wall and member scopes
// apply exactly as on the per-file cells read.

import { verifyTokenForProject } from "../auth"
import { CELL_ROW_COLUMNS, mapCellRow, type CellRowRaw } from "./cell-row-serialize"
import { sourceOrTargetLaneSql, targetLaneDualReadBinds } from "./lane-id-sql"
import { grantedLaneIds, scopeReadClause, targetVisibilityClause, visibleLanesForRead } from "./lane-read-wall"

export interface CellsByRefEnv {
  AQUILLA_PG?: AquillaDb
  SYNC_SECRET_KEY?: string
  LANE_READ_WALL?: string
}

const PATH_RE = /^\/api\/v1\/projects\/([^/]+)\/cells\/by-ref$/
export const BY_REF_MAX_FILES = 50
export const BY_REF_MAX_REFS = 200
export const BY_REF_MAX_ROWS = 5000

/** postgres.js unsafe() does not infer array parameter types (cells-read-route
 *  does the same): bind an explicitly escaped array literal. */
export function pgTextArray(values: readonly string[]): string {
  return `{${values.map((v) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",")}}`
}

function bad(message: string, status = 400): Response {
  return new Response(message, { status })
}

export async function handleCellsByRefRequest(request: Request, env: CellsByRefEnv): Promise<Response | null> {
  const url = new URL(request.url)
  const match = PATH_RE.exec(url.pathname)
  if (!match || request.method !== "GET") return null
  if (!env.SYNC_SECRET_KEY) return bad("SYNC_SECRET_KEY not configured", 500)
  if (!env.AQUILLA_PG) return bad("AQUILLA_PG binding not configured", 500)
  const db = env.AQUILLA_PG
  const projectId = decodeURIComponent(match[1])

  const authHeader = request.headers.get("Authorization") ?? ""
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null
  if (!token) return bad("missing Authorization header", 401)
  const auth = await verifyTokenForProject(token, projectId, env.SYNC_SECRET_KEY)
  if (!auth.ok) return bad(auth.reason, auth.status)

  const files = (url.searchParams.get("files") ?? "").split(",").map((s) => s.trim()).filter(Boolean)
  if (files.length === 0) return bad("files is required")
  if (files.length > BY_REF_MAX_FILES) return bad(`at most ${BY_REF_MAX_FILES} files`)
  const refs = (url.searchParams.get("refs") ?? "").split("|").map((s) => s.trim()).filter(Boolean)
  const prefix = url.searchParams.get("prefix")
  if (refs.length === 0 && (prefix === null || prefix.trim().length < 2)) return bad("refs or prefix (at least 2 characters) is required")
  if (refs.length > BY_REF_MAX_REFS) return bad(`at most ${BY_REF_MAX_REFS} refs`)
  const lane = url.searchParams.get("lane") ?? ""
  if (lane.length > 64) return bad("invalid lane")

  const visibleLanes = visibleLanesForRead(env.LANE_READ_WALL, auth.claims)
  const laneIds = await grantedLaneIds(db, projectId, visibleLanes)
  const scopeClause = await scopeReadClause(db, projectId, auth.claims, laneIds)

  const parts: string[] = [
    `SELECT ${CELL_ROW_COLUMNS}, file_id FROM cells`,
    `WHERE project_id = ? AND file_id = ANY(?::text[])`,
  ]
  const binds: unknown[] = [projectId, pgTextArray(files)]
  if (refs.length > 0) {
    parts.push(`AND canonical_ref = ANY(?::text[])`)
    binds.push(pgTextArray(refs))
  } else {
    // LIKE with the user's text escaped: % and _ are literal here.
    parts.push(`AND canonical_ref LIKE ? ESCAPE '\\'`)
    binds.push(`${(prefix ?? "").replace(/[\\%_]/g, (c) => `\\${c}`)}%`)
  }
  parts.push(`AND tombstoned_at IS NULL`)
  parts.push(sourceOrTargetLaneSql())
  binds.push(...targetLaneDualReadBinds(projectId, lane))
  const wall = targetVisibilityClause({ laneIds, sideExpr: "side", laneIdExpr: "lane_id" })
  if (wall) {
    parts.push(wall.sql)
    binds.push(...wall.binds)
  }
  if (scopeClause) {
    parts.push(scopeClause.sql)
    binds.push(...scopeClause.binds)
  }
  parts.push(`ORDER BY file_id, canonical_ref, sequence_index NULLS LAST, cell_id LIMIT ?`)
  binds.push(BY_REF_MAX_ROWS + 1)

  const { results } = await db.prepare(parts.join(" ")).bind(...binds).all<CellRowRaw & { file_id: string }>()
  const truncated = results.length > BY_REF_MAX_ROWS
  const rows = (truncated ? results.slice(0, BY_REF_MAX_ROWS) : results).map((r) => ({ ...mapCellRow(r), fileId: r.file_id }))
  return Response.json({ cells: rows, truncated })
}

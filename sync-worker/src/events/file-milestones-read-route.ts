// Per-file hand-set milestone read route (AQU-2308).
//
//   GET /api/v1/projects/:projectId/files/:fileId/milestones
//
// Returns every hand-set milestone on one file: `{ milestones: [...] }`, in a
// stable order (name, then id) so two callers reading the same file agree.
//
// What it deliberately does NOT return is which cells each milestone covers.
// Only the two anchors are stored, and the run between them is resolved in the
// browser against the file's live cell order (db/shared/file-milestones.ts),
// which is what lets a cell inserted inside a range be covered without any
// write. Computing a span here would mean a second source of truth that could
// disagree with the navigator.
//
// Auth: sync-token JWT scoped to projectId; viewer (100) and up — reading a
// division is reading the project, and every member sees the same divisions in
// every lane, so there is no lane scoping on this read. Writing one is
// maintainer+, enforced on the write side in role-policy.ts.

import { verifyTokenForProject } from "../auth"

export interface FileMilestonesReadEnv {
  AQUILLA_PG?: AquillaDb
  SYNC_SECRET_KEY?: string
}

const PATH_RE = /^\/api\/v1\/projects\/([^/]+)\/files\/([^/]+)\/milestones$/

interface MilestoneRowRaw {
  milestone_id: string
  name: string
  start_cell_id: string
  end_cell_id: string
  author: string
  event_id: string
  created_at: number
  updated_at: number
}

interface MilestoneRowOut {
  id: string
  name: string
  startCellId: string
  endCellId: string
  author: string
  eventId: string
  createdAt: number
  updatedAt: number
}

function mapRow(r: MilestoneRowRaw): MilestoneRowOut {
  return {
    id: r.milestone_id,
    name: r.name,
    startCellId: r.start_cell_id,
    endCellId: r.end_cell_id,
    author: r.author,
    eventId: r.event_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

/**
 * GET /api/v1/projects/:projectId/files/:fileId/milestones
 *
 * Returns null if the URL doesn't match (chainable in the fetch dispatcher).
 */
export async function handleFileMilestonesReadRequest(
  request: Request,
  env: FileMilestonesReadEnv,
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

  const result = await env.AQUILLA_PG
    .prepare(
      `SELECT milestone_id, name, start_cell_id, end_cell_id,
              author, event_id, created_at, updated_at
         FROM file_milestones
        WHERE project_id = ? AND file_id = ?
        ORDER BY name ASC, milestone_id ASC`,
    )
    .bind(projectId, fileId)
    .all<MilestoneRowRaw>()

  return Response.json({
    milestones: (result.results ?? []).map(mapRow),
  })
}

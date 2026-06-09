// Stale-source read route (Phase 5 / AD-9).
//
//   GET /api/v1/projects/:projectId/files/:fileId/stale-source
//
// Returns the list of target-side cell ids whose source has advanced
// since the translator last committed. The query is the AD-9 pointer
// comparison from spec 03-data-model §"Source-project linking":
//
//   SELECT t.cell_id
//   FROM cells t
//   JOIN cells s
//     ON s.project_id = COALESCE(:upstream_project_id, t.project_id)
//    AND s.cell_id    = t.cell_id
//    AND s.side       = 'source'
//   WHERE t.project_id      = :project_id
//     AND t.file_id         = :file_id
//     AND t.side            = 'target'
//     AND t.source_event_id IS NOT NULL
//     AND s.event_id        != t.source_event_id;
//
// The upstream project id is resolved from `projects.source_project_id`
// — for linked target projects this points at the upstream; for self-
// contained or source-only projects it is NULL and we COALESCE back to
// the project's own id (so we still detect the rare in-project drift
// case where a target.cell.commit was followed by a same-project
// source.cell.commit).
//
// Auth: sync-token JWT scoped to `projectId`. Viewer (100)+ — same gate
// as cells-read; the indicator is purely a read-side derivation.

import { verifyTokenForProject } from "../auth"

export interface StaleSourceEnv {
  AQUILLA_PG?: AquillaDb
  SYNC_SECRET_KEY?: string
}

const PATH_RE = /^\/api\/v1\/projects\/([^/]+)\/files\/([^/]+)\/stale-source$/

export async function handleStaleSourceRequest(
  request: Request,
  env: StaleSourceEnv,
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
  if (!token) {
    return new Response("missing Authorization header", { status: 401 })
  }
  const auth = await verifyTokenForProject(token, projectId, env.SYNC_SECRET_KEY)
  if (!auth.ok) return new Response(auth.reason, { status: auth.status })

  // 1. Resolve upstream project id (may be null).
  //
  // `projects.source_project_id` lives in the same AQUILLA_PG shared with
  // auth-worker. Phase 1A's 0004_projects_source_link.sql added the
  // column; if a deployment hasn't applied that migration, the query
  // throws and we surface the staleness query as no-op (treat as
  // self-contained — `upstream = projectId`).
  let upstreamProjectId: string | null = null
  try {
    const row = await env.AQUILLA_PG.prepare(
      "SELECT source_project_id FROM projects WHERE id = ?",
    )
      .bind(projectId)
      .first<{ source_project_id: string | null }>()
    upstreamProjectId = row?.source_project_id ?? null
  } catch {
    // Migration 0004 not yet present — fall back to self-contained.
    upstreamProjectId = null
  }

  // 2. Run the AD-9 pointer comparison.
  //
  // The COALESCE is intentional: for self-contained / source-only
  // projects the JOIN reads source rows from the project itself; for
  // linked target projects it reads source rows from the upstream. Same
  // SQL, no branches.
  const sql = `
    SELECT t.cell_id AS cell_id
    FROM cells t
    JOIN cells s
      ON s.project_id = COALESCE(?, t.project_id)
     AND s.cell_id    = t.cell_id
     AND s.side       = 'source'
    WHERE t.project_id      = ?
      AND t.file_id         = ?
      AND t.side            = 'target'
      AND t.source_event_id IS NOT NULL
      AND s.event_id        != t.source_event_id
  `

  let staleCellIds: string[] = []
  try {
    const res = await env.AQUILLA_PG.prepare(sql)
      .bind(upstreamProjectId, projectId, fileId)
      .all<{ cell_id: string }>()
    staleCellIds = (res.results ?? []).map((r) => r.cell_id)
  } catch (err) {
    // Defensive: if the cells projection isn't fully shaped yet (e.g.,
    // 0003 not applied), the query fails on a missing column. Return an
    // empty list rather than 500 — staleness is a soft signal, the
    // editor must not break on its absence.
    console.warn("stale-source query failed:", err)
    staleCellIds = []
  }

  return Response.json({
    projectId,
    fileId,
    staleCellIds,
    upstreamProjectId,
  })
}

// Per-file cue-link read. (AQU-646 stage 4)
//
//   GET /api/v1/projects/:projectId/files/:fileId/cell-links
//
// Returns every live edge TOUCHING this file, from either side. That is the
// whole point of the one-request shape: a file is the subtitle side when you
// open the subtitles and the audio side when you ask about the cue sibling,
// and both callers want the same bipartite graph. One read of the subtitle
// file therefore answers "which cues perform this line?" and "which line does
// this cue perform?" without a second round trip or a reverse index in the
// client.
//
// Tombstoned edges (`linked = 0`) are filtered out here — an unlink is a
// tombstone so that replaying the import-time linker cannot resurrect it, but
// nothing downstream has any use for the record of a link that isn't.
//
// Auth: sync-token JWT scoped to projectId; viewer (100) and up — same as the
// cells and audio-attachment reads.

import { verifyTokenForProject } from "../auth"

export interface CellLinksReadEnv {
  AQUILLA_PG?: AquillaDb
  SYNC_SECRET_KEY?: string
}

const PATH_RE = /^\/api\/v1\/projects\/([^/]+)\/files\/([^/]+)\/cell-links$/

interface LinkRowRaw {
  kind: string
  from_file_id: string
  from_cell_id: string
  to_file_id: string
  to_cell_id: string
  origin: string
  confidence: number | null
}

interface LinkOut {
  kind: string
  fromFileId: string
  fromCellId: string
  toFileId: string
  toCellId: string
  origin: string
  confidence: number | null
}

export async function handleCellLinksReadRequest(
  request: Request,
  env: CellLinksReadEnv,
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

  // Two predicates rather than an OR across the columns, so each leg can use
  // its own partial index (idx_cell_links_from / _to).
  //
  // THE FAR SIDE MUST STILL EXIST. Replacing an episode's audio cues used to
  // mint a NEW sibling file, and nothing ever tombstoned the edges pointing at
  // the old one — while `from_file_id` (the subtitle file) never changes, so
  // every stale edge kept coming back on every read. Measured on a real project
  // 2026-08-14: 1,387 of 3,430 live edges pointed at replaced siblings. The
  // damage was not cosmetic — an index that is never empty means "these cues
  // have never been paired" can never be said, and a subtitle paired only with
  // dead cues reads as paired, so it never gets its unpaired mark.
  //
  // Only the FAR side is joined: the near side is the file being asked about,
  // which the caller is looking at, so it is live by construction.
  const res = await env.AQUILLA_PG.prepare(
    `SELECT cl.kind, cl.from_file_id, cl.from_cell_id, cl.to_file_id, cl.to_cell_id,
            cl.origin, cl.confidence
       FROM cell_links cl
       JOIN files f ON f.id = cl.to_file_id AND f.deleted_at IS NULL
      WHERE cl.project_id = ? AND cl.linked = 1 AND cl.from_file_id = ?
      UNION ALL
     SELECT cl.kind, cl.from_file_id, cl.from_cell_id, cl.to_file_id, cl.to_cell_id,
            cl.origin, cl.confidence
       FROM cell_links cl
       JOIN files f ON f.id = cl.from_file_id AND f.deleted_at IS NULL
      WHERE cl.project_id = ? AND cl.linked = 1 AND cl.to_file_id = ? AND cl.from_file_id <> ?`,
  )
    .bind(projectId, fileId, projectId, fileId, fileId)
    .all<LinkRowRaw>()

  const links: LinkOut[] = (res.results ?? []).map((r) => ({
    kind: r.kind,
    fromFileId: r.from_file_id,
    fromCellId: r.from_cell_id,
    toFileId: r.to_file_id,
    toCellId: r.to_cell_id,
    origin: r.origin,
    confidence: r.confidence,
  }))

  return Response.json({ links })
}

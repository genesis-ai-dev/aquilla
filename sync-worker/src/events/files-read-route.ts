// Project-scoped file read routes.
//
//   GET /api/v1/projects/:projectId/files
//   GET /api/v1/projects/:projectId/files/:fileId
//
// Both return the same shape (one record vs an array). Reads the `files`
// table directly — the rollup counters there are projected from the event
// log via writeProjection() on every onSave, so a /files response is the
// dashboard's view of the project without round-tripping through Y.Doc.
//
// Auth: Authorization: Bearer <sync-token JWT>. The token's `projectId`
// claim must match the path's :projectId. Token role is implicitly the
// project-membership check (identity mints tokens only for members).

import { verifyTokenForProject } from "../auth"

export interface FilesReadEnv {
  AQUILLA_PG?: AquillaDb
  SYNC_SECRET_KEY?: string
}

interface FileRowRaw {
  id: string
  project_id: string
  name: string
  role: string | null
  kind: string | null
  event_id: string
  meta: string
  cell_count: number
  approved_count: number
  filled_count: number
  word_count: number
  last_edit_at: number | null
  deleted_at: number | null
}

interface FileSummary {
  fileId: string
  projectId: string
  name: string
  /** Backward-compatible: derived from `kind ?? role ?? 'codex'`. */
  fileType: string
  role: string | null
  kind: string | null
  eventId: string
  sourceLanguage: string | null
  targetLanguage: string | null
  sourceTextDirection: 'ltr' | 'rtl' | null
  targetTextDirection: 'ltr' | 'rtl' | null
  /** Timeline-segment-model order lens, read from meta. Null ⇒ client treats
   *  it as 'sequence'. */
  orderedBy: string | null
  /** Timeline editor: core video URL for the preview, read from meta. Null ⇒
   *  no video linked. */
  coreMediaUrl: string | null
  cellCount: number
  approvedCount: number
  /** Target cells with content (TRIM(value) != ''): the "translated" count. */
  filledCount: number
  wordCount: number
  lastEditAt: number | null
  /** FRO-272: epoch-ms when this file was soft-deleted, or null if active. */
  deletedAt: number | null
}

function mapRow(row: FileRowRaw): FileSummary {
  let meta: {
    source_language?: string
    target_language?: string
    sourceLanguage?: string
    targetLanguage?: string
    source_text_direction?: string
    target_text_direction?: string
    sourceTextDirection?: string
    targetTextDirection?: string
    orderedBy?: string
    coreMediaUrl?: string
  } = {}
  try {
    meta = row.meta ? JSON.parse(row.meta) : {}
  } catch {
    meta = {}
  }
  return {
    fileId: row.id,
    projectId: row.project_id,
    name: row.name,
    fileType: row.kind ?? row.role ?? 'codex',
    role: row.role,
    kind: row.kind,
    eventId: row.event_id,
    sourceLanguage: meta.source_language ?? meta.sourceLanguage ?? null,
    targetLanguage: meta.target_language ?? meta.targetLanguage ?? null,
    sourceTextDirection: normalizeTextDirection(meta.source_text_direction ?? meta.sourceTextDirection),
    targetTextDirection: normalizeTextDirection(meta.target_text_direction ?? meta.targetTextDirection),
    orderedBy: meta.orderedBy ?? null,
    coreMediaUrl: meta.coreMediaUrl ?? null,
    cellCount: row.cell_count,
    approvedCount: row.approved_count,
    filledCount: row.filled_count,
    wordCount: row.word_count,
    lastEditAt: row.last_edit_at,
    deletedAt: row.deleted_at ?? null,
  }
}

function normalizeTextDirection(value: string | undefined): 'ltr' | 'rtl' | null {
  return value === 'ltr' || value === 'rtl' ? value : null
}

// Active listing:  GET /api/v1/projects/:projectId/files
// Single file:     GET /api/v1/projects/:projectId/files/:fileId
// Trash listing:   GET /api/v1/projects/:projectId/files?trash=1
const PATH_RE = /^\/api\/v1\/projects\/([^/]+)\/files(?:\/([^/]+))?$/

export async function handleFilesReadRequest(
  request: Request,
  env: FilesReadEnv,
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
  const fileId = match[2] ? decodeURIComponent(match[2]) : null

  const authHeader = request.headers.get("Authorization") ?? ""
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null
  if (!token) {
    return new Response("missing Authorization header", { status: 401 })
  }

  const auth = await verifyTokenForProject(token, projectId, env.SYNC_SECRET_KEY)
  if (!auth.ok) {
    return new Response(auth.reason, { status: auth.status })
  }

  const columns =
    "id, project_id, name, role, kind, event_id, meta, " +
    "cell_count, approved_count, filled_count, word_count, last_edit_at, deleted_at"

  // ?trash=1 returns soft-deleted files only; default returns active files only.
  const trash = url.searchParams.get("trash") === "1"

  if (fileId) {
    const sql = `SELECT ${columns} FROM files WHERE project_id = ? AND id = ?`
    const row = await env.AQUILLA_PG.prepare(sql)
      .bind(projectId, fileId)
      .first<FileRowRaw>()
    if (!row) return new Response("file not found", { status: 404 })
    return Response.json({ file: mapRow(row) })
  }

  const tombstoneFilter = trash ? "deleted_at IS NOT NULL" : "deleted_at IS NULL"
  const sql =
    `SELECT ${columns} FROM files WHERE project_id = ? AND ${tombstoneFilter} ` +
    `ORDER BY last_edit_at DESC NULLS LAST, name ASC`
  const result = await env.AQUILLA_PG.prepare(sql)
    .bind(projectId)
    .all<FileRowRaw>()
  return Response.json({ files: result.results.map(mapRow) })
}

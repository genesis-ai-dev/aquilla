// AQU-777: per-cell attachment read API.
//
//   GET /api/v1/projects/:projectId/attachments
//   Query params:
//     fileId  — REQUIRED. The drawer's unit of work is one open file.
//     cellId  — optional; narrows to a single cell.
//
// Returns { attachments: AttachmentRowOut[] } ordered by
// (cell_id ASC, created_at ASC, attachment_id ASC) so the drawer can group by
// cell in one pass without re-sorting, and repeated reads agree on the order of
// two attachments that landed in the same millisecond.
//
// No cursor, unlike comments-read-route: a file's attachments are bounded by
// how many images a team hand-picks onto its cells (tens, not thousands), the
// drawer renders every one of them at once by design, and a page boundary in
// the middle of a cell's group would have to be stitched back together client
// side for no benefit. `ATTACHMENTS_MAX_ROWS` is the backstop, and a file that
// somehow reaches it says so via `truncated` rather than silently losing rows.
//
// Auth: sync-token JWT scoped to projectId, same gate as the comments read
// route. Every query is double-scoped by the verified projectId from the JWT,
// so a token for project A cannot read project B's attachments.

import { verifyTokenForProject } from '../auth'

export interface CellAttachmentsReadEnv {
  AQUILLA_PG?: AquillaDb
  SYNC_SECRET_KEY?: string
}

interface AttachmentRowRaw {
  attachment_id: string
  project_id: string
  file_id: string
  cell_id: string
  object_name: string
  name: string
  mime_type: string | null
  size_bytes: number | null
  author_id: string
  author_label: string | null
  created_at: number
  /** The source cell's canonical reference ("GEN 1:1"), LEFT-JOINed in so the
   *  drawer can head each group with the verse address instead of an opaque
   *  cell id. Null when the cell has no canonical ref or no longer exists. */
  cell_ref: string | null
}

export interface AttachmentRowOut {
  attachmentId: string
  projectId: string
  fileId: string
  cellId: string
  objectName: string
  name: string
  mimeType: string | null
  sizeBytes: number | null
  authorId: string
  authorLabel: string | null
  createdAt: number
  cellRef: string | null
}

function toOut(row: AttachmentRowRaw): AttachmentRowOut {
  return {
    attachmentId: row.attachment_id,
    projectId: row.project_id,
    fileId: row.file_id,
    cellId: row.cell_id,
    objectName: row.object_name,
    name: row.name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
    authorId: row.author_id,
    authorLabel: row.author_label,
    createdAt: Number(row.created_at),
    cellRef: row.cell_ref,
  }
}

const PATH_RE = /^\/api\/v1\/projects\/([^/]+)\/attachments$/

/** Backstop, not a page size — see the header. */
export const ATTACHMENTS_MAX_ROWS = 2000

export async function handleCellAttachmentsReadRequest(
  request: Request,
  env: CellAttachmentsReadEnv,
): Promise<Response | null> {
  const url = new URL(request.url)
  const match = url.pathname.match(PATH_RE)
  if (!match) return null
  if (request.method !== 'GET') return null

  if (!env.SYNC_SECRET_KEY) {
    return new Response('SYNC_SECRET_KEY not configured', { status: 500 })
  }
  if (!env.AQUILLA_PG) {
    return new Response('AQUILLA_PG binding not configured', { status: 500 })
  }

  const projectId = decodeURIComponent(match[1])

  const authHeader = request.headers.get('Authorization') ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
  if (!token) {
    return new Response('missing Authorization header', { status: 401 })
  }

  const auth = await verifyTokenForProject(token, projectId, env.SYNC_SECRET_KEY)
  if (!auth.ok) {
    return new Response(auth.reason, { status: auth.status })
  }

  const fileId = url.searchParams.get('fileId')
  if (!fileId) {
    return new Response('fileId is required', { status: 400 })
  }
  const cellId = url.searchParams.get('cellId')

  // Always scope to the verified projectId first. The LEFT JOIN mirrors
  // comments-read-route's: keyed on the cells primary key so it is an index
  // seek per row, and LEFT so an attachment on a since-deleted cell still
  // surfaces (cell_ref → null) rather than vanishing from the drawer.
  const parts: string[] = [
    `SELECT a.attachment_id, a.project_id, a.file_id, a.cell_id, a.object_name,
            a.name, a.mime_type, a.size_bytes, a.author_id, a.author_label,
            a.created_at, c.canonical_ref AS cell_ref
       FROM cell_attachments a
       LEFT JOIN cells c
         ON c.project_id = a.project_id
        AND c.file_id = a.file_id
        AND c.cell_id = a.cell_id
        AND c.side = 'source'
      WHERE a.project_id = ? AND a.file_id = ? AND a.deleted_at IS NULL`,
  ]
  const binds: unknown[] = [projectId, fileId]
  if (cellId) {
    parts.push('AND a.cell_id = ?')
    binds.push(cellId)
  }
  parts.push('ORDER BY a.cell_id ASC, a.created_at ASC, a.attachment_id ASC')
  parts.push('LIMIT ?')
  // Over-fetch by one so `truncated` is honest rather than inferred from a
  // full page (which is ambiguous at exactly the limit).
  binds.push(ATTACHMENTS_MAX_ROWS + 1)

  const result = await env.AQUILLA_PG.prepare(parts.join('\n'))
    .bind(...binds)
    .all<AttachmentRowRaw>()

  const rows = result.results ?? []
  const truncated = rows.length > ATTACHMENTS_MAX_ROWS
  const page = truncated ? rows.slice(0, ATTACHMENTS_MAX_ROWS) : rows

  return Response.json({ attachments: page.map(toOut), truncated })
}

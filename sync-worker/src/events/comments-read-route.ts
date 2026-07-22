// Project-wide and cell-scoped comment read API.
//
//   GET /api/v1/projects/:projectId/comments
//   Query params (all optional):
//     fileId  — filter to a specific file
//     cellId  — filter to a specific cell (requires fileId)
//
// Returns { comments: CommentRow[] } ordered by created_at ASC.
//
// Auth: sync-token JWT scoped to projectId; minimum role COMMENTER (200).
// Every query is double-scoped by the verified projectId from the JWT so a
// token for project A cannot read comments from project B.

import { verifyTokenForProject } from '../auth'

export interface CommentsReadEnv {
  AQUILLA_PG?: AquillaDb
  SYNC_SECRET_KEY?: string
}

interface CommentRowRaw {
  comment_id: string
  project_id: string
  scope_kind: string
  file_id: string | null
  cell_id: string | null
  parent_comment_id: string | null
  body: string
  resolved: number
  author_id: string
  author_label: string | null
  created_at: number
  updated_at: number
  deleted_at: number | null
  // AQU-599: the source cell's canonical reference (verse address, e.g.
  // "GEN 1:1"), LEFT-JOINed in so the comments panel can show which cell each
  // comment belongs to instead of the opaque cellId. Null when the cell has no
  // canonical ref (non-scripture) or the cell no longer exists.
  cell_ref: string | null
}

export interface CommentRowOut {
  commentId: string
  projectId: string
  scopeKind: 'cell' | 'file' | 'project'
  fileId: string | null
  cellId: string | null
  parentCommentId: string | null
  body: string
  resolved: boolean
  authorId: string
  authorLabel: string | null
  createdAt: number
  updatedAt: number
  deletedAt: number | null
  /** AQU-599: human-readable cell reference resolved from the source cell. */
  cellRef: string | null
}

function toOut(row: CommentRowRaw): CommentRowOut {
  return {
    commentId: row.comment_id,
    projectId: row.project_id,
    scopeKind: row.scope_kind as 'cell' | 'file' | 'project',
    fileId: row.file_id,
    cellId: row.cell_id,
    parentCommentId: row.parent_comment_id,
    body: row.body,
    resolved: row.resolved === 1,
    authorId: row.author_id,
    authorLabel: row.author_label,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    cellRef: row.cell_ref,
  }
}

const PATH_RE = /^\/api\/v1\/projects\/([^/]+)\/comments$/

export async function handleCommentsReadRequest(
  request: Request,
  env: CommentsReadEnv,
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
  const cellId = url.searchParams.get('cellId')

  // Build the query. Always scope to the verified projectId first.
  // AQU-599: LEFT JOIN the source-side cell to surface its canonical reference
  // (verse address) so the comments panel can label each comment with the cell
  // it targets. Keyed on the cells primary key (project_id, file_id, cell_id,
  // side) so it's an index seek per comment; LEFT keeps comments whose cell was
  // deleted or has no canonical ref (cell_ref → null).
  const parts: string[] = [
    'SELECT',
    '  cm.comment_id, cm.project_id, cm.scope_kind, cm.file_id, cm.cell_id,',
    '  cm.parent_comment_id, cm.body, cm.resolved, cm.author_id, cm.author_label,',
    '  cm.created_at, cm.updated_at, cm.deleted_at,',
    '  c.canonical_ref AS cell_ref',
    'FROM comments cm',
    'LEFT JOIN cells c',
    '  ON c.project_id = cm.project_id',
    '  AND c.file_id = cm.file_id',
    '  AND c.cell_id = cm.cell_id',
    "  AND c.side = 'source'",
    'WHERE cm.project_id = ?',
  ]
  const binds: unknown[] = [projectId]

  if (fileId !== null && cellId !== null) {
    parts.push("AND cm.scope_kind = 'cell' AND cm.file_id = ? AND cm.cell_id = ?")
    binds.push(fileId, cellId)
  } else if (fileId !== null) {
    parts.push("AND cm.file_id = ?")
    binds.push(fileId)
  }

  parts.push('ORDER BY cm.created_at ASC')

  const sql = parts.join(' ')

  try {
    const result = await env.AQUILLA_PG.prepare(sql)
      .bind(...binds)
      .all<CommentRowRaw>()
    const comments: CommentRowOut[] = result.results.map(toOut)
    return Response.json({ comments })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return new Response(`comments read failed: ${message}`, { status: 500 })
  }
}

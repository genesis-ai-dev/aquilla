// Project-wide and cell-scoped comment read API.
//
//   GET /api/v1/projects/:projectId/comments
//   Query params (all optional):
//     fileId  — filter to a specific file
//     cellId  — filter to a specific cell (requires fileId)
//     limit   — page size (default 200, max 1000)
//     cursor  — opaque keyset cursor from a previous page's `nextCursor`
//
// Returns { comments: CommentRow[], nextCursor: string | null } ordered by
// (created_at ASC, comment_id ASC). `nextCursor` is null on the last page.
// Pre-pagination clients that ignore `nextCursor` still get the first 200
// rows — the shape only gained a field.
//
//   GET /api/v1/projects/:projectId/comments/counts
//
// Cheap aggregate for badges: { unresolved, byFile: { [fileId|""]: n } } —
// open (unresolved, non-deleted) root threads, grouped by file. Project-scoped
// threads land under the "" key. One indexed GROUP BY, no row transfer.
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
  // AQU-692: target-text snapshot captured when the thread was created. Null for
  // replies, non-cell scopes, and legacy rows created before the column existed.
  created_for_translated: string | null
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
  /** AQU-692: target-text snapshot at thread creation; null = unknown baseline. */
  createdForTranslated: string | null
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
    createdForTranslated: row.created_for_translated,
  }
}

const PATH_RE = /^\/api\/v1\/projects\/([^/]+)\/comments$/
const COUNTS_PATH_RE = /^\/api\/v1\/projects\/([^/]+)\/comments\/counts$/

export const COMMENTS_DEFAULT_PAGE = 200
const COMMENTS_MAX_PAGE = 1000

interface CommentsCursor {
  createdAt: number
  commentId: string
}

/** Opaque keyset cursor: base64url of `${created_at}:${comment_id}`. */
export function encodeCommentsCursor(c: CommentsCursor): string {
  return btoa(`${c.createdAt}:${c.commentId}`).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function decodeCommentsCursor(raw: string): CommentsCursor | null {
  try {
    const b64 = raw.replace(/-/g, '+').replace(/_/g, '/')
    const text = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
    const sep = text.indexOf(':')
    if (sep <= 0) return null
    const createdAt = Number(text.slice(0, sep))
    const commentId = text.slice(sep + 1)
    if (!Number.isFinite(createdAt) || !commentId) return null
    return { createdAt, commentId }
  } catch {
    return null
  }
}

function parseLimit(raw: string | null): number {
  const n = Math.floor(Number(raw))
  if (!raw || !Number.isFinite(n) || n < 1) return COMMENTS_DEFAULT_PAGE
  return Math.min(n, COMMENTS_MAX_PAGE)
}

export async function handleCommentsReadRequest(
  request: Request,
  env: CommentsReadEnv,
): Promise<Response | null> {
  const url = new URL(request.url)
  const countsMatch = url.pathname.match(COUNTS_PATH_RE)
  const match = countsMatch ?? url.pathname.match(PATH_RE)
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

  if (countsMatch) return handleCounts(env.AQUILLA_PG, projectId)

  const fileId = url.searchParams.get('fileId')
  const cellId = url.searchParams.get('cellId')
  const limit = parseLimit(url.searchParams.get('limit'))
  const cursorRaw = url.searchParams.get('cursor')
  const cursor = cursorRaw ? decodeCommentsCursor(cursorRaw) : null
  if (cursorRaw && !cursor) {
    return new Response('invalid cursor', { status: 400 })
  }

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
    '  cm.created_at, cm.updated_at, cm.deleted_at, cm.created_for_translated,',
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

  // Keyset: strictly after the last row of the previous page in
  // (created_at, comment_id) order. Two comments can share a created_at (a
  // batch flush stamps one serverTs), so the id tiebreak is what makes the
  // cursor exact rather than skipping or repeating a row.
  if (cursor) {
    parts.push('AND (cm.created_at > ? OR (cm.created_at = ? AND cm.comment_id > ?))')
    binds.push(cursor.createdAt, cursor.createdAt, cursor.commentId)
  }

  parts.push('ORDER BY cm.created_at ASC, cm.comment_id ASC')
  // Over-fetch by one to learn whether a next page exists without a COUNT.
  parts.push('LIMIT ?')
  binds.push(limit + 1)

  const sql = parts.join(' ')

  try {
    const result = await env.AQUILLA_PG.prepare(sql)
      .bind(...binds)
      .all<CommentRowRaw>()
    const rows = result.results
    const page = rows.length > limit ? rows.slice(0, limit) : rows
    const last = page[page.length - 1]
    const nextCursor =
      rows.length > limit && last
        ? encodeCommentsCursor({ createdAt: Number(last.created_at), commentId: last.comment_id })
        : null
    const comments: CommentRowOut[] = page.map(toOut)
    return Response.json({ comments, nextCursor })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('comments read failed:', message)
    return new Response('comments read failed', { status: 500 })
  }
}

export interface CommentCountsOut {
  /** Open root threads across the whole project. */
  unresolved: number
  /** Open root threads per file; project-scoped threads key on "". */
  byFile: Record<string, number>
}

async function handleCounts(db: AquillaDb, projectId: string): Promise<Response> {
  try {
    const result = await db
      .prepare(
        `SELECT COALESCE(file_id, '') AS file_id, COUNT(*)::integer AS n
           FROM comments
          WHERE project_id = ?
            AND parent_comment_id IS NULL
            AND resolved = 0
            AND deleted_at IS NULL
          GROUP BY COALESCE(file_id, '')`,
      )
      .bind(projectId)
      .all<{ file_id: string; n: number }>()
    const byFile: Record<string, number> = {}
    let unresolved = 0
    for (const row of result.results) {
      const n = Number(row.n)
      byFile[row.file_id] = n
      unresolved += n
    }
    const out: CommentCountsOut = { unresolved, byFile }
    return Response.json(out)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('comment counts failed:', message)
    return new Response('comment counts failed', { status: 500 })
  }
}

// Project-wide book-affirmation read API (AQU-727).
//
//   GET /api/v1/projects/:projectId/book-affirmations
//   Query params (optional):
//     bookCode — filter to a single affirmed book
//
// Returns { affirmations: BookAffirmationRow[] } ordered by book_code ASC.
//
// Auth: sync-token JWT scoped to projectId; any project member (viewer+) may
// read affirmation state — it is advisory, project-visible metadata. Every
// query is scoped by the verified projectId from the JWT so a token for
// project A cannot read affirmations from project B.

import { verifyTokenForProject } from '../auth'

export interface BookAffirmationsReadEnv {
  AQUILLA_PG?: AquillaDb
  SYNC_SECRET_KEY?: string
}

interface BookAffirmationRowRaw {
  project_id: string
  book_code: string
  affirmed_by: number
  affirmed_by_label: string
  event_id: string
  affirmed_at: number
  note: string | null
}

export interface BookAffirmationRowOut {
  projectId: string
  bookCode: string
  affirmedBy: number
  affirmedByLabel: string
  eventId: string
  affirmedAt: number
  note: string | null
}

function toOut(row: BookAffirmationRowRaw): BookAffirmationRowOut {
  return {
    projectId: row.project_id,
    bookCode: row.book_code,
    affirmedBy: row.affirmed_by,
    affirmedByLabel: row.affirmed_by_label,
    eventId: row.event_id,
    affirmedAt: row.affirmed_at,
    note: row.note,
  }
}

const PATH_RE = /^\/api\/v1\/projects\/([^/]+)\/book-affirmations$/

export async function handleBookAffirmationsReadRequest(
  request: Request,
  env: BookAffirmationsReadEnv,
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

  const bookCode = url.searchParams.get('bookCode')

  const parts: string[] = [
    'SELECT project_id, book_code, affirmed_by, affirmed_by_label,',
    '  event_id, affirmed_at, note',
    'FROM book_affirmations',
    'WHERE project_id = ?',
  ]
  const binds: unknown[] = [projectId]

  if (bookCode !== null) {
    parts.push('AND book_code = ?')
    binds.push(bookCode)
  }

  parts.push('ORDER BY book_code ASC')

  const sql = parts.join(' ')

  try {
    const result = await env.AQUILLA_PG.prepare(sql)
      .bind(...binds)
      .all<BookAffirmationRowRaw>()
    const affirmations: BookAffirmationRowOut[] = result.results.map(toOut)
    return Response.json({ affirmations })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return new Response(`book affirmations read failed: ${message}`, { status: 500 })
  }
}

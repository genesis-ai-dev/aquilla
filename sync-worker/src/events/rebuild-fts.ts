// FTS backfill endpoint.
//
// POST /admin/projects/:projectId/rebuild-fts
//
// Idempotent backfill of the cells_fts virtual table for a project. Runs a
// delete-then-insert pass in batches of 1000 rows (cursor-paginated by rowid)
// so it doesn't time out on large projects.
//
// Auth: Authorization: Bearer ${ADMIN_SECRET} — the dedicated operator
// credential shared with the projection-rebuild and every other admin endpoint.
// SYNC_SECRET_KEY is still accepted; see lib/admin-auth.ts for why.

import { isAuthorizedAdminBearer } from '../lib/admin-auth'

const REBUILD_FTS_PATH = /^\/admin\/projects\/([^/]+)\/rebuild-fts$/

export interface RebuildFtsEnv {
  AQUILLA_PG?: AquillaDb
  ADMIN_SECRET?: string
  SYNC_SECRET_KEY?: string
}

export async function handleRebuildFtsRequest(
  request: Request,
  env: RebuildFtsEnv,
): Promise<Response | null> {
  const url = new URL(request.url)
  const match = REBUILD_FTS_PATH.exec(url.pathname)
  if (!match) return null

  if (request.method !== 'POST') {
    return new Response('method not allowed', { status: 405 })
  }

  if (!env.SYNC_SECRET_KEY) {
    return new Response('SYNC_SECRET_KEY not configured', { status: 500 })
  }
  const auth = request.headers.get('Authorization') ?? ''
  if (!isAuthorizedAdminBearer(auth, env)) {
    return new Response('unauthorized', { status: 401 })
  }

  if (!env.AQUILLA_PG) {
    return new Response('AQUILLA_PG binding not configured', { status: 500 })
  }

  const projectId = decodeURIComponent(match[1])

  // Postgres: cells.value_tsv is a GENERATED column with a GIN index, so the
  // FTS index is always in sync with the data — there is nothing to rebuild.
  // Kept as a no-op endpoint for API compatibility (was the SQLite FTS5 backfill).
  return Response.json({
    ok: true,
    projectId,
    deletedRows: 0,
    insertedRows: 0,
    batches: 0,
    durationMs: 0,
    note: 'No-op on Postgres: FTS is auto-maintained by the cells.value_tsv generated column.',
  })
}

// FTS backfill endpoint.
//
// POST /admin/projects/:projectId/rebuild-fts
//
// Idempotent backfill of the cells_fts virtual table for a project. Runs a
// delete-then-insert pass in batches of 1000 rows (cursor-paginated by rowid)
// so it doesn't time out on large projects.
//
// Auth: Authorization: Bearer ${SYNC_SECRET_KEY} — same shared secret used by
// the projection-rebuild and all other admin endpoints.

const REBUILD_FTS_PATH = /^\/admin\/projects\/([^/]+)\/rebuild-fts$/

export interface RebuildFtsEnv {
  AQUILLA_DB?: D1Database
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
  if (auth !== `Bearer ${env.SYNC_SECRET_KEY}`) {
    return new Response('unauthorized', { status: 401 })
  }

  if (!env.AQUILLA_DB) {
    return new Response('AQUILLA_DB binding not configured', { status: 500 })
  }

  const db = env.AQUILLA_DB
  const projectId = decodeURIComponent(match[1])
  const startedAt = Date.now()

  // Pass 1 — delete any existing FTS rows for this project so the result is
  // idempotent. FTS5 external-content delete requires passing the OLD value
  // which we read from the cells table (still intact at this point).
  let deletedRows = 0
  let deleteLastRowid = -1
  while (true) {
    const { results } = await db
      .prepare(
        'SELECT rowid, value FROM cells WHERE project_id = ? AND rowid > ? ORDER BY rowid LIMIT 1000',
      )
      .bind(projectId, deleteLastRowid)
      .all<{ rowid: number; value: string }>()
    if (!results || results.length === 0) break
    const stmts = results.map((r) =>
      db
        .prepare('INSERT INTO cells_fts(cells_fts, rowid, value) VALUES (?, ?, ?)')
        .bind('delete', r.rowid, r.value),
    )
    await db.batch(stmts)
    deleteLastRowid = results[results.length - 1].rowid
    deletedRows += results.length
  }

  // Pass 2 — insert fresh FTS rows for every cell in the project.
  let insertedRows = 0
  let batches = 0
  let insertLastRowid = -1
  while (true) {
    const { results } = await db
      .prepare(
        'SELECT rowid, value FROM cells WHERE project_id = ? AND rowid > ? ORDER BY rowid LIMIT 1000',
      )
      .bind(projectId, insertLastRowid)
      .all<{ rowid: number; value: string }>()
    if (!results || results.length === 0) break
    const stmts = results.map((r) =>
      db.prepare('INSERT INTO cells_fts(rowid, value) VALUES (?, ?)').bind(r.rowid, r.value),
    )
    await db.batch(stmts)
    insertLastRowid = results[results.length - 1].rowid
    insertedRows += results.length
    batches += 1
  }

  const durationMs = Date.now() - startedAt

  return Response.json({
    ok: true,
    projectId,
    deletedRows,
    insertedRows,
    batches,
    durationMs,
    note: 'FTS rebuild is idempotent; safe to re-run. Delete pass removes stale FTS rows before insert pass.',
  })
}

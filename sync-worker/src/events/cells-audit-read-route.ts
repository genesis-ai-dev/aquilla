// GET /cells/audit-stats?fileId= — per-cell edit_count + content_hash for D1-backed UI.

import { verifyTokenForFile } from '../auth'

export interface CellsAuditReadEnv {
  CODEX_DB?: D1Database
  SYNC_SECRET_KEY?: string
}

export async function handleCellsAuditReadRequest(
  request: Request,
  env: CellsAuditReadEnv,
): Promise<Response | null> {
  const url = new URL(request.url)
  if (url.pathname !== '/cells/audit-stats') return null
  if (request.method !== 'GET') return null

  if (!env.SYNC_SECRET_KEY) {
    return new Response('SYNC_SECRET_KEY not configured', { status: 500 })
  }
  if (!env.CODEX_DB) {
    return new Response('CODEX_DB binding not configured', { status: 500 })
  }

  const token = (request.headers.get('Authorization') ?? '').startsWith('Bearer ')
    ? (request.headers.get('Authorization') ?? '').slice(7)
    : null
  if (!token) return new Response('missing Authorization header', { status: 401 })

  const fileId = url.searchParams.get('fileId')
  if (!fileId) return new Response('missing fileId', { status: 400 })

  const auth = await verifyTokenForFile(token, fileId, env.SYNC_SECRET_KEY)
  if (!auth.ok) return new Response(auth.reason, { status: auth.status })

  // edit_count column: added by sync-worker/codex-db-patches/001_edit_count.sql
  const sql = `
    SELECT cell_id, COALESCE(edit_count, 0) as edit_count, content_hash
    FROM cells
    WHERE file_id = ?
  `

  interface Row {
    cell_id: string
    edit_count: number
    content_hash: string
  }

  const res = await env.CODEX_DB.prepare(sql).bind(fileId).all<Row>()
  const cells = res.results.map((r) => ({
    cellId: r.cell_id,
    editCount: r.edit_count,
    contentHash: r.content_hash,
  }))
  return Response.json({ cells })
}

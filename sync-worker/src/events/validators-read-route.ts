// GET /cell-validators?fileId=&cellId=

import { verifyTokenForFile } from '../auth'

export interface ValidatorsReadEnv {
  CODEX_DB?: D1Database
  SYNC_SECRET_KEY?: string
}

export async function handleValidatorsReadRequest(
  request: Request,
  env: ValidatorsReadEnv,
): Promise<Response | null> {
  const url = new URL(request.url)
  if (url.pathname !== '/cell-validators') return null
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
  const cellId = url.searchParams.get('cellId')
  if (!fileId || !cellId) {
    return new Response('missing fileId or cellId', { status: 400 })
  }

  const auth = await verifyTokenForFile(token, fileId, env.SYNC_SECRET_KEY)
  if (!auth.ok) return new Response(auth.reason, { status: auth.status })

  const projectId = auth.claims.projectId

  const sql = `
    SELECT edit_event_id, username, is_active, decided_ts
    FROM cell_validators
    WHERE project_id = ? AND file_id = ? AND cell_id = ?
    ORDER BY decided_ts DESC
  `

  interface Row {
    edit_event_id: string
    username: string
    is_active: number
    decided_ts: number
  }

  const res = await env.CODEX_DB.prepare(sql)
    .bind(projectId, fileId, cellId)
    .all<Row>()

  const validators = res.results.map((r) => ({
    editEventId: r.edit_event_id,
    username: r.username,
    isActive: r.is_active === 1,
    decidedTs: r.decided_ts,
  }))

  return Response.json({ validators })
}

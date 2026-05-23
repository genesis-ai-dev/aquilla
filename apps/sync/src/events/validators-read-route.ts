// GET /cell-validators?fileId=&cellId=

import { verifyTokenForFile } from '../auth'

export interface ValidatorsReadEnv {
  AQUILLA_DB?: D1Database
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
  if (!env.AQUILLA_DB) {
    return new Response('AQUILLA_DB binding not configured', { status: 500 })
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

  // DELETE-on-unvalidate: a row's presence IS "active". No is_active column.
  const sql = `
    SELECT event_id, username, decided_ts
    FROM cell_validators
    WHERE project_id = ? AND file_id = ? AND cell_id = ?
    ORDER BY decided_ts DESC
  `

  interface Row {
    event_id: string
    username: string
    decided_ts: number
  }

  const res = await env.AQUILLA_DB.prepare(sql)
    .bind(projectId, fileId, cellId)
    .all<Row>()

  const validators = res.results.map((r) => ({
    editEventId: r.event_id,
    username: r.username,
    decidedTs: r.decided_ts,
  }))

  return Response.json({ validators })
}

// GET /cells/audit-stats?fileId=
//
// Returns per-cell audit data the UI needs to render validation status and
// staleness without walking the event log: chain-head event_id, content
// hash, last-edit timestamp, source pin (AD-9), and the active validators
// tied to the current edit.
//
// Two parallel queries — one over `cells` for stats, one over
// `cell_validators` for active validators — then joined in JS.

import { verifyTokenForFile } from '../auth'

export interface CellsAuditReadEnv {
  AQUILLA_DB?: D1Database
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
  if (!env.AQUILLA_DB) {
    return new Response('AQUILLA_DB binding not configured', { status: 500 })
  }

  const token = (request.headers.get('Authorization') ?? '').startsWith('Bearer ')
    ? (request.headers.get('Authorization') ?? '').slice(7)
    : null
  if (!token) return new Response('missing Authorization header', { status: 401 })

  const fileId = url.searchParams.get('fileId')
  if (!fileId) return new Response('missing fileId', { status: 400 })

  const auth = await verifyTokenForFile(token, fileId, env.SYNC_SECRET_KEY)
  if (!auth.ok) return new Response(auth.reason, { status: auth.status })

  const projectId = auth.claims.projectId

  // `event_id` is the chain head (AD-2); `source_event_id` is the AD-9
  // staleness pin. `last_edit_event_id` in the response keeps the old
  // field name for client compatibility but reads from `event_id`.
  const cellsSql = `
    SELECT
      cell_id,
      side,
      content_hash,
      last_edit_at,
      event_id        AS last_edit_event_id,
      source_event_id
    FROM cells
    WHERE project_id = ? AND file_id = ?
  `

  // No is_active filter: DELETE-on-unvalidate means every row is an active
  // validation. The JS join below still scopes to validators whose
  // `event_id` equals the cell's current chain head (event-anchored).
  const validatorsSql = `
    SELECT cell_id, event_id, username
    FROM cell_validators
    WHERE project_id = ? AND file_id = ?
  `

  interface CellRow {
    cell_id: string
    side: string
    content_hash: string | null
    last_edit_at: number | null
    last_edit_event_id: string
    source_event_id: string | null
  }
  interface ValidatorRow {
    cell_id: string
    event_id: string
    username: string
  }

  const [cellsRes, validatorsRes] = await Promise.all([
    env.AQUILLA_DB.prepare(cellsSql).bind(projectId, fileId).all<CellRow>(),
    env.AQUILLA_DB.prepare(validatorsSql).bind(projectId, fileId).all<ValidatorRow>(),
  ])

  // Bucket validators by cell_id → event_id → usernames[].
  const byCell = new Map<string, Map<string, string[]>>()
  for (const v of validatorsRes.results) {
    let perEdit = byCell.get(v.cell_id)
    if (!perEdit) {
      perEdit = new Map()
      byCell.set(v.cell_id, perEdit)
    }
    let names = perEdit.get(v.event_id)
    if (!names) {
      names = []
      perEdit.set(v.event_id, names)
    }
    names.push(v.username)
  }

  const cells = cellsRes.results.map((r) => {
    const activeValidators =
      byCell.get(r.cell_id)?.get(r.last_edit_event_id) ?? []
    return {
      cellId: r.cell_id,
      side: r.side,
      contentHash: r.content_hash,
      lastEditAt: r.last_edit_at,
      lastEditEventId: r.last_edit_event_id,
      sourceEventId: r.source_event_id,
      activeValidators,
    }
  })
  return Response.json({ cells })
}

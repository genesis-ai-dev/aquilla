// GET /cells/audit-stats?fileId=
//
// Returns per-cell audit data the UI needs to render validation status and
// history without walking the Y.Doc: edit count, content hash, last-edit
// event id (so clients can correlate with their outbox), and the active
// validators tied to that current edit.
//
// Two parallel queries — one over `cells` for stats, one over `cell_validators`
// for active validators — then joined in JS. Avoids a GROUP_CONCAT JOIN that
// would be harder to reason about with the test D1 fake.

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

  const projectId = auth.claims.projectId

  // projected_from = 'event:<eventId>' is set by event-projection.ts on each
  // cell.commit; substr(7) extracts the bare event id.
  const cellsSql = `
    SELECT
      cell_id,
      COALESCE(edit_count, 0) AS edit_count,
      content_hash,
      last_edit_at,
      CASE WHEN projected_from LIKE 'event:%'
        THEN substr(projected_from, 7)
        ELSE NULL
      END AS last_edit_event_id
    FROM cells
    WHERE file_id = ?
  `

  const validatorsSql = `
    SELECT cell_id, edit_event_id, username
    FROM cell_validators
    WHERE project_id = ? AND file_id = ? AND is_active = 1
  `

  interface CellRow {
    cell_id: string
    edit_count: number
    content_hash: string
    last_edit_at: number | null
    last_edit_event_id: string | null
  }
  interface ValidatorRow {
    cell_id: string
    edit_event_id: string
    username: string
  }

  const [cellsRes, validatorsRes] = await Promise.all([
    env.CODEX_DB.prepare(cellsSql).bind(fileId).all<CellRow>(),
    env.CODEX_DB.prepare(validatorsSql).bind(projectId, fileId).all<ValidatorRow>(),
  ])

  // Bucket validators by cell_id → edit_event_id → usernames[].
  const byCell = new Map<string, Map<string, string[]>>()
  for (const v of validatorsRes.results) {
    let perEdit = byCell.get(v.cell_id)
    if (!perEdit) {
      perEdit = new Map()
      byCell.set(v.cell_id, perEdit)
    }
    let names = perEdit.get(v.edit_event_id)
    if (!names) {
      names = []
      perEdit.set(v.edit_event_id, names)
    }
    names.push(v.username)
  }

  const cells = cellsRes.results.map((r) => {
    let activeValidators: string[] = []
    if (r.last_edit_event_id) {
      activeValidators = byCell.get(r.cell_id)?.get(r.last_edit_event_id) ?? []
    }
    return {
      cellId: r.cell_id,
      editCount: r.edit_count,
      contentHash: r.content_hash,
      lastEditAt: r.last_edit_at,
      lastEditEventId: r.last_edit_event_id,
      activeValidators,
    }
  })
  return Response.json({ cells })
}

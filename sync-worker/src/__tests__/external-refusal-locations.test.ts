// AQU-1571 — when the /events perimeter refuses an event, every Agent API commit
// engine reports WHICH file and line it refused: in `receipt.warnings` when some
// events landed, and in `error.details.rejected` when none did. The perimeter
// itself answers only `{ id, status, reason }`, so each engine maps the id back
// to the event it sent. EmitEvents is pinned against a real policy refusal in
// external-validation-guardrails.test.ts; this file pins the other engines
// (CommitChangeset via SetTranslation, and the structure engine).
//
// A real refusal of one chosen target commit is awkward to stage (lane write
// walls, live-role races), so the perimeter is wrapped: events on the cells in
// `refuse` come back refused exactly as the perimeter reports a refusal, and
// every other event goes through the real perimeter.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// commit path → events/route.ts → broadcast.ts → partyserver (cloudflare:*).
vi.mock('partyserver', () => ({
  getServerByName: vi.fn().mockResolvedValue({
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  }),
}))

const refuse = vi.hoisted(() => ({ kinds: new Set<string>(), cells: new Set<string>() }))

vi.mock('../events/route', async (importOriginal) => {
  const real = await importOriginal<typeof import('../events/route')>()
  type Sent = { id: string; kind: string; cellId?: string }
  return {
    ...real,
    handleEventsWriteRequest: async (
      req: Request,
      env: Parameters<typeof real.handleEventsWriteRequest>[1],
      ctx?: Parameters<typeof real.handleEventsWriteRequest>[2],
    ) => {
      const body = (await req.clone().json()) as { events: Sent[] }
      const refused = body.events.filter(
        (e) => refuse.kinds.has(e.kind) || (e.cellId !== undefined && refuse.cells.has(e.cellId)),
      )
      if (refused.length === 0) return real.handleEventsWriteRequest(req, env, ctx)
      const keep = body.events.filter((e) => !refused.includes(e))
      let out: { accepted: { id: string }[]; rejected: { id: string; status: number; reason: string }[] } = {
        accepted: [],
        rejected: [],
      }
      if (keep.length > 0) {
        const res = await real.handleEventsWriteRequest(
          new Request(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify({ events: keep }) }),
          env,
          ctx,
        )
        out = (await res!.json()) as typeof out
      }
      return Response.json({
        ...out,
        rejected: [
          ...out.rejected,
          ...refused.map((e) => ({ id: e.id, status: 403, reason: `lane 'es' not in scope for ${e.kind}` })),
        ],
      })
    },
  }
})

import { handleExternalChangesetsRequest } from '../external/changesets-route'
import { mintApiToken } from '../../../db/shared/api-credentials'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'

const SECRET = 'test-secret'
const PROJECT = 'proj-r'
const FILE = 'file-r'

function makeEnv(db: AquillaDb) {
  return { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET, BASE_URL: 'https://aquilla.app' }
}

let nextUserId = 700
let nextCred = 0

async function memberToken(tdb: TestDb, level: number): Promise<string> {
  const userId = nextUserId++
  await tdb.pg.query(
    `INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, 'h')`,
    [userId, `u${userId}`, `u${userId}@x.com`],
  )
  await tdb.pg.query(
    `INSERT INTO project_members (project_id, user_id, role_level) VALUES ($1, $2, $3)`,
    [PROJECT, userId, level],
  )
  const { token, tokenHash, tokenPrefix } = await mintApiToken()
  await tdb.pg.query(
    `INSERT INTO api_credentials (id, user_id, name, token_prefix, token_hash, mode, org_id, project_id)
     VALUES ($1, $2, 'test', $3, $4, 'act', NULL, $5)`,
    [`00000000-0000-0000-0000-${String(++nextCred).padStart(12, '0')}`, String(userId), tokenPrefix, tokenHash, PROJECT],
  )
  return token
}

interface Body {
  changeset?: { id: string }
  receipt?: { appliedCount: number; warnings: unknown[] }
  error?: { code: string; message: string; details?: { rejected?: unknown[]; receipt?: { warnings: unknown[] } } }
}

async function call(env: ReturnType<typeof makeEnv>, token: string, path: string, body?: unknown) {
  const res = (await handleExternalChangesetsRequest(
    new Request(`https://w/api/v1/external/projects/${PROJECT}/changesets${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
    env,
  ))!
  return { res, body: (await res.json()) as Body }
}

async function prepareAndCommit(env: ReturnType<typeof makeEnv>, token: string, commands: unknown[]) {
  const staged = await call(env, token, '', { commands })
  expect(staged.res.status, JSON.stringify(staged.body)).toBe(200)
  return call(env, token, `/${staged.body.changeset!.id}/commit`)
}

let tdb: TestDb
let env: ReturnType<typeof makeEnv>

beforeEach(async () => {
  nextUserId = 700
  nextCred = 0
  refuse.kinds.clear()
  refuse.cells.clear()
  tdb = await makeTestDb({
    projects: [{ id: PROJECT, name: 'P', created_by: 99, org_id: null }],
    files: [{ id: FILE, project_id: PROJECT, name: 'F', event_id: 'f-evt-1' }],
    cells: [
      {
        project_id: PROJECT, file_id: FILE, cell_id: 'a', side: 'source', target_lang: '',
        value: 'first', event_id: 'evt-a', anchor_cell_id: null, last_edit_at: 1, sequence_index: 0,
      },
      {
        project_id: PROJECT, file_id: FILE, cell_id: 'b', side: 'source', target_lang: '',
        value: 'second', event_id: 'evt-b', anchor_cell_id: 'a', last_edit_at: 1, sequence_index: 1,
      },
    ],
  })
  env = makeEnv(tdb.db)
})

describe('CommitChangeset (SetTranslation) — a refusal names its line', () => {
  it('a partly refused plan applies the rest and its receipt warning names the refused line', async () => {
    const token = await memberToken(tdb, 400)
    refuse.cells.add('b')

    const { res, body } = await prepareAndCommit(env, token, [
      { kind: 'SetTranslation', fileId: FILE, cellId: 'a', value: 'primero' },
      { kind: 'SetTranslation', fileId: FILE, cellId: 'b', value: 'segundo' },
    ])

    expect(res.status, JSON.stringify(body)).toBe(200)
    expect(body.receipt!.appliedCount).toBe(1)
    expect(body.receipt!.warnings).toContainEqual({
      code: 'rejected',
      fileId: FILE,
      cellId: 'b',
      message: expect.stringMatching(/not in scope/),
    })
    expect(body.receipt!.warnings).not.toContainEqual(expect.objectContaining({ fileId: '', cellId: '' }))
  })

  it('a fully refused plan fails, and each refusal in error.details names its line', async () => {
    const token = await memberToken(tdb, 400)
    refuse.cells.add('a')
    refuse.cells.add('b')

    const { res, body } = await prepareAndCommit(env, token, [
      { kind: 'SetTranslation', fileId: FILE, cellId: 'a', value: 'primero' },
      { kind: 'SetTranslation', fileId: FILE, cellId: 'b', value: 'segundo' },
    ])

    expect(res.status).toBe(403)
    expect(body.error!.code).toBe('permission_denied')
    const rejected = body.error!.details!.rejected as { fileId: string; cellId: string; status: number }[]
    expect(rejected.map((r) => [r.fileId, r.cellId, r.status]).sort()).toEqual([
      [FILE, 'a', 403],
      [FILE, 'b', 403],
    ])
  })
})

describe('Structure engine (InsertCell) — a refusal names its own event', () => {
  it('a partly refused structural edit names the refused event by its own file and cell', async () => {
    const token = await memberToken(tdb, 500)
    // InsertCell compiles to source.cell.create (the new row) + source.cell.reorder
    // (re-pointing the successor). Refuse only the reorder.
    refuse.kinds.add('source.cell.reorder')

    const { res, body } = await prepareAndCommit(env, token, [
      { kind: 'InsertCell', fileId: FILE, afterCellId: 'a', cellId: 'new-1', value: 'inserted' },
    ])

    expect(res.status, JSON.stringify(body)).toBe(500)
    expect(body.error!.code).toBe('job_failed')
    const warnings = body.error!.details!.receipt!.warnings as { code: string; fileId: string; cellId: string }[]
    const refusals = warnings.filter((w) => w.code === 'rejected')
    expect(refusals).toHaveLength(1)
    expect(refusals[0].fileId).toBe(FILE)
    // The reorder moves the successor of the inserted row, not the new row.
    expect(refusals[0].cellId).toBe('b')
  })

  it('a fully refused structural edit names each refused event in error.details', async () => {
    const token = await memberToken(tdb, 500)
    refuse.kinds.add('source.cell.create')
    refuse.kinds.add('source.cell.reorder')

    const { res, body } = await prepareAndCommit(env, token, [
      { kind: 'InsertCell', fileId: FILE, afterCellId: 'a', cellId: 'new-1', value: 'inserted' },
    ])

    expect(res.status).toBe(403)
    const rejected = body.error!.details!.rejected as { fileId: string; cellId: string }[]
    expect(rejected).toHaveLength(2)
    expect(rejected.every((r) => r.fileId === FILE && r.cellId !== '')).toBe(true)
    expect(rejected.map((r) => r.cellId)).toContain('new-1')
  })
})

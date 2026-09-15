// Tests for the cell-structure commands — InsertCell / DeleteCell / SplitCell
// (AQU-1234). What these pin:
//
//   - the compiled events are the STANDARD cell-lifecycle kinds, in the shape
//     the workspace emits, and the anchor chain still reads in document order
//     after each edit (the thing that silently breaks exports when it doesn't);
//   - a split divides source and — with targets: 'divide' — each lane's
//     translation, and BOTH halves come out unvalidated;
//   - the guards that make the round-trip requirement true: no structural edit
//     on a file carrying preserved export slots, no delete that would orphan a
//     cell's validators/comments/audio, no duplicate canonical ref;
//   - prepare-time rejection of an out-of-range split offset;
//   - drift between prepare and commit is plan_stale, never a silent re-cut.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// commit path → events/route.ts → broadcast.ts → partyserver (cloudflare:*).
vi.mock('partyserver', () => ({
  getServerByName: vi.fn().mockResolvedValue({
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  }),
}))

import { handleExternalChangesetsRequest } from '../external/changesets-route'
import { handleEventsWriteRequest } from '../events/route'
import { mintApiToken } from '../../../db/shared/api-credentials'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'
import { makeTestToken } from './helpers/auth'
import { ROLE } from '../events/role-policy'
import type { RawEvent } from '../events/types'

const SECRET = 'test-secret'
const PROJECT = 'proj-s'
const FILE = 'file-s'

function makeEnv(db: AquillaDb) {
  return { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET, BASE_URL: 'https://aquilla.app' }
}

let nextUserId = 400
let nextCred = 200

async function memberToken(tdb: TestDb, level: number): Promise<string> {
  const userId = nextUserId++
  const name = `u${userId}`
  await tdb.pg.query(
    `INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, 'h')`,
    [userId, name, `${name}@x.com`],
  )
  await tdb.pg.query(
    `INSERT INTO project_members (project_id, user_id, role_level) VALUES ($1, $2, $3)`,
    [PROJECT, userId, level],
  )
  const { token, tokenHash, tokenPrefix } = await mintApiToken()
  const credentialId = `00000000-0000-0000-0000-${String(++nextCred).padStart(12, '0')}`
  await tdb.pg.query(
    `INSERT INTO api_credentials (id, user_id, name, token_prefix, token_hash, mode, org_id, project_id)
     VALUES ($1, $2, 'test', $3, $4, 'act', NULL, $5)`,
    [credentialId, String(userId), tokenPrefix, tokenHash, PROJECT],
  )
  return token
}

interface ApiBody {
  changeset?: { id: string }
  summary?: Record<string, unknown>
  receipt?: { appliedCount: number; eventIds: string[] }
  error?: { code: string; message: string; details?: unknown }
}

async function prepare(
  env: ReturnType<typeof makeEnv>,
  token: string,
  command: unknown,
): Promise<{ res: Response; body: ApiBody }> {
  const res = (await handleExternalChangesetsRequest(
    new Request(`https://w/api/v1/external/projects/${PROJECT}/changesets`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands: Array.isArray(command) ? command : [command] }),
    }),
    env,
  ))!
  return { res, body: (await res.json()) as ApiBody }
}

async function commit(
  env: ReturnType<typeof makeEnv>,
  token: string,
  id: string,
): Promise<{ res: Response; body: ApiBody }> {
  const res = (await handleExternalChangesetsRequest(
    new Request(`https://w/api/v1/external/projects/${PROJECT}/changesets/${id}/commit`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    }),
    env,
  ))!
  return { res, body: (await res.json()) as ApiBody }
}

/** Stage + commit in one step; asserts both legs succeeded. */
async function apply(
  env: ReturnType<typeof makeEnv>,
  token: string,
  command: unknown,
): Promise<ApiBody> {
  const staged = await prepare(env, token, command)
  expect(staged.res.status, JSON.stringify(staged.body)).toBe(200)
  const done = await commit(env, token, staged.body.changeset!.id)
  expect(done.res.status, JSON.stringify(done.body)).toBe(200)
  return done.body
}

/** Push a real event through the perimeter so heads/chains stay honest. */
async function seedEvent(tdb: TestDb, event: RawEvent): Promise<void> {
  const tok = await makeTestToken(SECRET, {
    projectId: PROJECT,
    fileId: FILE,
    userId: 999,
    username: 'seeder',
    role: 700,
  })
  const res = await handleEventsWriteRequest(
    new Request('https://w/events', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: [event] }),
    }),
    { AQUILLA_PG: tdb.db, SYNC_SECRET_KEY: SECRET },
  )
  expect(res!.status).toBe(200)
}

interface CellRow {
  cell_id: string
  side: string
  target_lang: string
  value: string
  anchor_cell_id: string | null
  event_id: string
  validated: number
  type: string | null
  canonical_ref: string | null
}

async function cells(tdb: TestDb, side?: string): Promise<CellRow[]> {
  const { rows } = await tdb.pg.query<CellRow>(
    `SELECT cell_id, side, target_lang, value, anchor_cell_id, event_id, validated, type, canonical_ref
       FROM cells WHERE project_id = $1 AND file_id = $2
        ${side ? 'AND side = $3' : ''}
      ORDER BY cell_id, target_lang`,
    side ? [PROJECT, FILE, side] : [PROJECT, FILE],
  )
  return rows
}

/** Walk the anchor chain into document order — the order exporters read. */
function chainOrder(sourceRows: CellRow[]): string[] {
  const byAnchor = new Map<string | null, CellRow>()
  for (const r of sourceRows) byAnchor.set(r.anchor_cell_id, r)
  const out: string[] = []
  let cursor: string | null = null
  while (out.length <= sourceRows.length) {
    const next = byAnchor.get(cursor)
    if (!next) break
    out.push(next.cell_id)
    cursor = next.cell_id
  }
  return out
}

async function eventKinds(tdb: TestDb): Promise<string[]> {
  const { rows } = await tdb.pg.query<{ kind: string }>(
    `SELECT kind FROM events WHERE project_id = $1 AND file_id = $2 ORDER BY server_seq`,
    [PROJECT, FILE],
  )
  return rows.map((r) => r.kind)
}

let tdb: TestDb
let env: ReturnType<typeof makeEnv>

// Three source cells in chain order a → b → c, with `b` translated.
beforeEach(async () => {
  nextUserId = 400
  tdb = await makeTestDb({
    projects: [{ id: PROJECT, name: 'P', created_by: 98, org_id: null }],
    files: [{ id: FILE, project_id: PROJECT, name: 'File S', event_id: 'f-evt-1' }],
    users: [{ id: 999, username: 'seeder', email: 's@x.com', password_hash: 'h' }],
    project_members: [{ project_id: PROJECT, user_id: 999, role_level: 700 }],
    cells: [
      {
        project_id: PROJECT, file_id: FILE, cell_id: 'a', side: 'source', target_lang: '',
        value: 'first', event_id: 'evt-a', anchor_cell_id: null, last_edit_at: 1, sequence_index: 0,
      },
      {
        project_id: PROJECT, file_id: FILE, cell_id: 'b', side: 'source', target_lang: '',
        value: 'The quick brown fox jumps over the lazy dog', event_id: 'evt-b',
        anchor_cell_id: 'a', last_edit_at: 1, sequence_index: 1, type: 'verse',
      },
      {
        project_id: PROJECT, file_id: FILE, cell_id: 'c', side: 'source', target_lang: '',
        value: 'third', event_id: 'evt-c', anchor_cell_id: 'b', last_edit_at: 1, sequence_index: 2,
      },
      {
        project_id: PROJECT, file_id: FILE, cell_id: 'b', side: 'target', target_lang: '',
        value: 'El zorro marron rapido salta sobre el perro perezoso', event_id: 'evt-bt',
        last_edit_at: 1, validated: 1,
      },
    ],
  })
  env = makeEnv(tdb.db)
})

// ── InsertCell ───────────────────────────────────────────────────────────────

describe('InsertCell', () => {
  it('adds a row after a cell and re-points the successor so chain order holds', async () => {
    const token = await memberToken(tdb, ROLE.PROJECT_LEAD)
    await apply(env, token, {
      kind: 'InsertCell', fileId: FILE, afterCellId: 'a', cellId: 'new-1', value: 'inserted',
    })

    const source = await cells(tdb, 'source')
    expect(chainOrder(source)).toEqual(['a', 'new-1', 'b', 'c'])
    const inserted = source.find((r) => r.cell_id === 'new-1')!
    expect(inserted.value).toBe('inserted')
    expect(inserted.anchor_cell_id).toBe('a')

    // Standard event vocabulary — the same kinds the workspace's add-row emits.
    expect(await eventKinds(tdb)).toEqual(['source.cell.create', 'source.cell.reorder'])
  })

  it('inserts at the head of the file when afterCellId is omitted', async () => {
    const token = await memberToken(tdb, ROLE.PROJECT_LEAD)
    await apply(env, token, { kind: 'InsertCell', fileId: FILE, cellId: 'head-1', value: 'zero' })
    expect(chainOrder(await cells(tdb, 'source'))).toEqual(['head-1', 'a', 'b', 'c'])
  })

  it('stamps the origin marker so exporters can tell an added row from an imported one', async () => {
    const token = await memberToken(tdb, ROLE.PROJECT_LEAD)
    await apply(env, token, { kind: 'InsertCell', fileId: FILE, cellId: 'm-1', value: '' })
    const { rows } = await tdb.pg.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM cells WHERE project_id = $1 AND file_id = $2 AND cell_id = 'm-1' AND side = 'source'`,
      [PROJECT, FILE],
    )
    const origin = rows[0].metadata.aquillaOrigin as Record<string, unknown>
    expect(origin.kind).toBe('user-insert')
    expect(origin.via).toBe('agent-api')
  })

  it('rejects a caller-supplied origin marker — provenance is server-written', async () => {
    const token = await memberToken(tdb, ROLE.PROJECT_LEAD)
    const { res, body } = await prepare(env, token, {
      kind: 'InsertCell', fileId: FILE, value: 'x', metadata: { aquillaOrigin: { kind: 'user-insert' } },
    })
    expect(res.status).toBe(400)
    expect(body.error?.code).toBe('validation_failed')
  })

  it('rejects a canonical ref already used in the file — export overlays by ref', async () => {
    await tdb.pg.query(
      `UPDATE cells SET canonical_ref = 'GEN 1:1' WHERE project_id = $1 AND file_id = $2 AND cell_id = 'a' AND side = 'source'`,
      [PROJECT, FILE],
    )
    const token = await memberToken(tdb, ROLE.PROJECT_LEAD)
    const { res, body } = await prepare(env, token, {
      kind: 'InsertCell', fileId: FILE, value: 'x', canonicalRef: 'GEN 1:1',
    })
    expect(res.status).toBe(400)
    expect(body.error?.message).toContain('already used')
  })

  it('goes stale when somebody else claims the same position between prepare and commit', async () => {
    const token = await memberToken(tdb, ROLE.PROJECT_LEAD)
    const staged = await prepare(env, token, {
      kind: 'InsertCell', fileId: FILE, afterCellId: 'a', cellId: 'mine', value: 'mine',
    })
    expect(staged.res.status).toBe(200)

    // A concurrent insert at the SAME position. Applying the staged plan now
    // would leave this row anchored at 'a' behind the new one — reachable only
    // at the tail of the file.
    await seedEvent(tdb, {
      id: '01930000-0000-7000-8000-000000000010', schemaVersion: 1, kind: 'source.cell.create',
      projectId: PROJECT, fileId: FILE, cellId: 'theirs', parentId: null,
      author: 'seeder', payload: { cellId: 'theirs', anchorCellId: 'a', value: 'theirs' }, clientTs: 1,
    } as RawEvent)

    const done = await commit(env, token, staged.body.changeset!.id)
    expect(done.res.status).toBe(409)
    expect(done.body.error?.code).toBe('plan_stale')
    expect((await cells(tdb, 'source')).some((r) => r.cell_id === 'mine')).toBe(false)
  })

  it('rejects an afterCellId that does not exist', async () => {
    const token = await memberToken(tdb, ROLE.PROJECT_LEAD)
    const { res, body } = await prepare(env, token, {
      kind: 'InsertCell', fileId: FILE, afterCellId: 'nope', value: 'x',
    })
    expect(res.status).toBe(400)
    expect(body.error?.message).toContain('does not exist')
  })
})

// ── DeleteCell ───────────────────────────────────────────────────────────────

describe('DeleteCell', () => {
  it('removes the cell and its translations, closing the chain over the gap', async () => {
    const token = await memberToken(tdb, ROLE.PROJECT_LEAD)
    await apply(env, token, { kind: 'DeleteCell', fileId: FILE, cellId: 'b' })

    const all = await cells(tdb)
    expect(all.some((r) => r.cell_id === 'b')).toBe(false)
    expect(chainOrder(all.filter((r) => r.side === 'source'))).toEqual(['a', 'c'])
    expect(await eventKinds(tdb)).toEqual([
      'source.cell.reorder',
      'target.cell.delete',
      'source.cell.delete',
    ])
  })

  it('deletes the tail cell without a reorder', async () => {
    const token = await memberToken(tdb, ROLE.PROJECT_LEAD)
    await apply(env, token, { kind: 'DeleteCell', fileId: FILE, cellId: 'c' })
    expect(chainOrder(await cells(tdb, 'source'))).toEqual(['a', 'b'])
    expect(await eventKinds(tdb)).toEqual(['source.cell.delete'])
  })

  it('refuses a cell that still owns rows the delete would orphan', async () => {
    await tdb.pg.query(
      `INSERT INTO cell_validators (project_id, file_id, cell_id, target_lang, event_id, username, decided_ts)
       VALUES ($1, $2, 'b', '', 'evt-bt', 'seeder', 1)`,
      [PROJECT, FILE],
    )
    await tdb.pg.query(
      `INSERT INTO comments (comment_id, project_id, scope_kind, file_id, cell_id, body, author_id, created_at, updated_at)
       VALUES ('cm-1', $1, 'cell', $2, 'b', 'hi', 'seeder', 1, 1)`,
      [PROJECT, FILE],
    )
    const token = await memberToken(tdb, ROLE.PROJECT_LEAD)
    const { res, body } = await prepare(env, token, { kind: 'DeleteCell', fileId: FILE, cellId: 'b' })
    expect(res.status).toBe(400)
    expect(body.error?.code).toBe('validation_failed')
    expect((body.error?.details as { dependents: string[] }).dependents).toEqual(
      expect.arrayContaining(['validators', 'comments']),
    )
    // Nothing was applied.
    expect((await cells(tdb, 'source')).some((r) => r.cell_id === 'b')).toBe(true)
  })

  it('goes stale when the cell gains a comment between prepare and commit', async () => {
    const token = await memberToken(tdb, ROLE.PROJECT_LEAD)
    const staged = await prepare(env, token, { kind: 'DeleteCell', fileId: FILE, cellId: 'c' })
    expect(staged.res.status).toBe(200)

    await tdb.pg.query(
      `INSERT INTO comments (comment_id, project_id, scope_kind, file_id, cell_id, body, author_id, created_at, updated_at)
       VALUES ('cm-late', $1, 'cell', $2, 'c', 'wait', 'seeder', 1, 1)`,
      [PROJECT, FILE],
    )

    const done = await commit(env, token, staged.body.changeset!.id)
    expect(done.res.status).toBe(409)
    expect(done.body.error?.code).toBe('plan_stale')
    expect((await cells(tdb, 'source')).some((r) => r.cell_id === 'c')).toBe(true)
  })

  it('goes stale when the cell gains a translation between prepare and commit', async () => {
    const token = await memberToken(tdb, ROLE.PROJECT_LEAD)
    const staged = await prepare(env, token, { kind: 'DeleteCell', fileId: FILE, cellId: 'c' })
    expect(staged.res.status).toBe(200)

    await seedEvent(tdb, {
      id: '01930000-0000-7000-8000-000000000001', schemaVersion: 1, kind: 'target.cell.create',
      projectId: PROJECT, fileId: FILE, cellId: 'c', parentId: null,
      author: 'seeder', payload: { cellId: 'c', value: 'late' }, clientTs: 1,
    } as RawEvent)

    const done = await commit(env, token, staged.body.changeset!.id)
    expect(done.res.status).toBe(409)
    expect(done.body.error?.code).toBe('plan_stale')
    expect((await cells(tdb, 'source')).some((r) => r.cell_id === 'c')).toBe(true)
  })
})

// ── SplitCell ────────────────────────────────────────────────────────────────

const SPLIT_AT = 'The quick brown fox'.length

describe('SplitCell', () => {
  it("divides source and target at the given offsets and keeps both halves in order", async () => {
    const token = await memberToken(tdb, ROLE.PROJECT_LEAD)
    await apply(env, token, {
      kind: 'SplitCell', fileId: FILE, cellId: 'b', newCellId: 'b2',
      offset: SPLIT_AT, targets: 'divide',
      targetOffsets: [{ offset: 'El zorro marron rapido'.length }],
    })

    const all = await cells(tdb)
    const source = all.filter((r) => r.side === 'source')
    expect(chainOrder(source)).toEqual(['a', 'b', 'b2', 'c'])
    expect(source.find((r) => r.cell_id === 'b')!.value).toBe('The quick brown fox')
    expect(source.find((r) => r.cell_id === 'b2')!.value).toBe(' jumps over the lazy dog')
    // The second half inherits the original's type but never its canonical ref.
    expect(source.find((r) => r.cell_id === 'b2')!.type).toBe('verse')

    const targets = all.filter((r) => r.side === 'target')
    expect(targets.find((r) => r.cell_id === 'b')!.value).toBe('El zorro marron rapido')
    expect(targets.find((r) => r.cell_id === 'b2')!.value).toBe(' salta sobre el perro perezoso')
  })

  it('leaves BOTH halves unvalidated — the source they were checked against changed', async () => {
    const token = await memberToken(tdb, ROLE.PROJECT_LEAD)
    expect((await cells(tdb)).find((r) => r.side === 'target')!.validated).toBe(1)

    await apply(env, token, {
      kind: 'SplitCell', fileId: FILE, cellId: 'b', newCellId: 'b2',
      offset: SPLIT_AT, targets: 'divide',
      targetOffsets: [{ offset: 'El zorro marron rapido'.length }],
    })

    for (const row of (await cells(tdb)).filter((r) => r.side === 'target')) {
      expect(row.validated, `${row.cell_id} should be unvalidated after a split`).toBe(0)
    }
  })

  it("targets: 'blank' drops the existing translation rather than guessing a cut", async () => {
    const token = await memberToken(tdb, ROLE.PROJECT_LEAD)
    await apply(env, token, {
      kind: 'SplitCell', fileId: FILE, cellId: 'b', newCellId: 'b2', offset: SPLIT_AT, targets: 'blank',
    })
    const all = await cells(tdb)
    expect(all.filter((r) => r.side === 'target')).toHaveLength(0)
    expect(chainOrder(all.filter((r) => r.side === 'source'))).toEqual(['a', 'b', 'b2', 'c'])
  })

  it('compiles the standard cell-lifecycle kinds', async () => {
    const token = await memberToken(tdb, ROLE.PROJECT_LEAD)
    await apply(env, token, {
      kind: 'SplitCell', fileId: FILE, cellId: 'b', newCellId: 'b2', offset: SPLIT_AT, targets: 'blank',
    })
    expect(await eventKinds(tdb)).toEqual([
      'source.cell.commit',
      'source.cell.create',
      'source.cell.reorder',
      'target.cell.delete',
    ])
  })

  it('rejects an offset outside the source text at prepare', async () => {
    const token = await memberToken(tdb, ROLE.PROJECT_LEAD)
    for (const offset of [0, 999]) {
      const { res, body } = await prepare(env, token, {
        kind: 'SplitCell', fileId: FILE, cellId: 'b', offset, targets: 'blank',
      })
      expect(res.status, `offset ${offset} should be rejected`).toBe(400)
      expect(body.error?.code).toBe('validation_failed')
    }
    // Nothing staged, nothing applied.
    expect((await cells(tdb, 'source'))).toHaveLength(3)
  })

  it("rejects targets: 'divide' when a translated lane has no cut point", async () => {
    const token = await memberToken(tdb, ROLE.PROJECT_LEAD)
    const { res, body } = await prepare(env, token, {
      kind: 'SplitCell', fileId: FILE, cellId: 'b', offset: SPLIT_AT, targets: 'divide',
    })
    expect(res.status).toBe(400)
    expect(body.error?.message).toContain('no cut point')
  })

  it('rejects a target offset past the end of the translation', async () => {
    const token = await memberToken(tdb, ROLE.PROJECT_LEAD)
    const { res, body } = await prepare(env, token, {
      kind: 'SplitCell', fileId: FILE, cellId: 'b', offset: SPLIT_AT, targets: 'divide',
      targetOffsets: [{ offset: 9999 }],
    })
    expect(res.status).toBe(400)
    expect(body.error?.message).toContain('past the end')
  })

  it('refuses to cut a cell carrying structured source HTML', async () => {
    await tdb.pg.query(
      `UPDATE cells SET value_html = '<p>The quick <b>brown</b> fox…</p>'
        WHERE project_id = $1 AND file_id = $2 AND cell_id = 'b' AND side = 'source'`,
      [PROJECT, FILE],
    )
    const token = await memberToken(tdb, ROLE.PROJECT_LEAD)
    const { res, body } = await prepare(env, token, {
      kind: 'SplitCell', fileId: FILE, cellId: 'b', offset: SPLIT_AT, targets: 'blank',
    })
    expect(res.status).toBe(400)
    expect((body.error?.details as { reason: string }).reason).toBe('structured_source_html')
  })

  it('refuses a canonical-ref cell in a file kept for lossless export — the second half would vanish', async () => {
    await tdb.pg.query(
      `UPDATE cells SET canonical_ref = 'GEN 1:1' WHERE project_id = $1 AND file_id = $2 AND cell_id = 'b' AND side = 'source'`,
      [PROJECT, FILE],
    )
    await tdb.pg.query(
      `INSERT INTO file_source_blobs (file_id, project_id, format, raw_source, created_at)
       VALUES ($2, $1, 'usfm', '\\v 1 The quick brown fox…', 1)`,
      [PROJECT, FILE],
    )
    const token = await memberToken(tdb, ROLE.PROJECT_LEAD)
    const { res, body } = await prepare(env, token, {
      kind: 'SplitCell', fileId: FILE, cellId: 'b', offset: SPLIT_AT, targets: 'blank',
    })
    expect(res.status).toBe(400)
    expect((body.error?.details as { reason: string }).reason).toBe('lossless_source_ref')
  })

  it('goes stale when the source text moves between prepare and commit', async () => {
    const token = await memberToken(tdb, ROLE.PROJECT_LEAD)
    const staged = await prepare(env, token, {
      kind: 'SplitCell', fileId: FILE, cellId: 'b', offset: SPLIT_AT, targets: 'blank',
    })
    expect(staged.res.status).toBe(200)

    await seedEvent(tdb, {
      id: '01930000-0000-7000-8000-000000000002', schemaVersion: 1, kind: 'source.cell.commit',
      projectId: PROJECT, fileId: FILE, cellId: 'b', parentId: 'evt-b',
      author: 'seeder', payload: { value: 'somebody rewrote it' }, clientTs: 1,
    } as RawEvent)

    const done = await commit(env, token, staged.body.changeset!.id)
    expect(done.res.status).toBe(409)
    expect(done.body.error?.code).toBe('plan_stale')
    // The rewrite stands; no half-applied split.
    const source = await cells(tdb, 'source')
    expect(source.find((r) => r.cell_id === 'b')!.value).toBe('somebody rewrote it')
    expect(source).toHaveLength(3)
  })
})

// ── Round-trip, role, and batching guards (all three commands) ────────────────

describe('structure commands — guards', () => {
  const commands: Record<string, unknown> = {
    InsertCell: { kind: 'InsertCell', fileId: FILE, value: 'x' },
    DeleteCell: { kind: 'DeleteCell', fileId: FILE, cellId: 'c' },
    SplitCell: { kind: 'SplitCell', fileId: FILE, cellId: 'b', offset: 4, targets: 'blank' },
  }

  it('refuses every structural edit on a file whose cells carry preserved export slots', async () => {
    // An IDML/OOXML import: the exporters address these cells BY locator and
    // throw on any cell that lacks one, so no structural edit is safe here.
    await tdb.pg.query(
      `UPDATE cells SET metadata = $3::jsonb
        WHERE project_id = $1 AND file_id = $2 AND cell_id = 'b' AND side = 'source'`,
      [
        PROJECT,
        FILE,
        JSON.stringify({
          aquillaImport: { version: 1, sourceLocator: { kind: 'idml', memberPath: 'Stories/x.xml', blockPath: '/p[1]' } },
          idml: { version: 2, slotCount: 1, editableSlotIndexes: [0] },
        }),
      ],
    )
    const token = await memberToken(tdb, ROLE.PROJECT_LEAD)
    for (const [kind, command] of Object.entries(commands)) {
      const { res, body } = await prepare(env, token, command)
      expect(res.status, `${kind} should be refused`).toBe(400)
      expect((body.error?.details as { reason: string }).reason).toBe('preserved_export_slots')
    }
    // The file is untouched, so it still exports exactly as it imported.
    expect(await eventKinds(tdb)).toEqual([])
    expect(await cells(tdb, 'source')).toHaveLength(3)
  })

  it('requires project lead — a contributor credential is denied', async () => {
    const token = await memberToken(tdb, ROLE.CONTRIBUTOR)
    for (const [kind, command] of Object.entries(commands)) {
      const { res, body } = await prepare(env, token, command)
      expect(res.status, `${kind} should be denied for a contributor`).toBe(403)
      expect(body.error?.code).toBe('permission_denied')
    }
  })

  it('must be the sole command in its changeset', async () => {
    const token = await memberToken(tdb, ROLE.PROJECT_LEAD)
    const { res, body } = await prepare(env, token, [
      commands.InsertCell,
      { kind: 'SetTranslation', fileId: FILE, cellId: 'a', value: 'x' },
    ])
    expect(res.status).toBe(400)
    expect(body.error?.message).toContain('only command')
  })

  it('rejects a command naming a file that does not exist', async () => {
    const token = await memberToken(tdb, ROLE.PROJECT_LEAD)
    const { res, body } = await prepare(env, token, {
      kind: 'InsertCell', fileId: 'ghost', value: 'x',
    })
    expect(res.status).toBe(400)
    expect(body.error?.message).toContain('does not exist')
  })

  it('reports a server-computed effect summary the approval page can render', async () => {
    const token = await memberToken(tdb, ROLE.PROJECT_LEAD)
    const { body } = await prepare(env, token, {
      kind: 'SplitCell', fileId: FILE, cellId: 'b', offset: SPLIT_AT, targets: 'blank',
    })
    expect(body.summary?.structure).toEqual({
      command: 'SplitCell',
      fileId: FILE,
      cellsAdded: 1,
      cellsRemoved: 0,
      cellsReanchored: 1,
      targetsRemoved: 1,
      targetsRewritten: 0,
    })
  })
})

// AQU-1408 §1 — the `cell.gloss.set` event grammar.
//
// A corrected statistical gloss is a new kind of row, not a flag on the
// back-translation: `cell_backtranslations` is keyed
// (project, file, cell, target_event_id), so a gloss and an AI reading of the
// same commit would collide on its primary key, and the point of §4 is that a
// reader can tell the two apart. What is tested here is that the new kind
// behaves like its neighbour where it should (contributor floor,
// non-chain-mutating, lane-scoped, pinned to the commit it reads) and not
// where it should not (it writes cell_glosses, never cell_backtranslations).

import { describe, it, expect } from 'vitest'
import { buildEventProjectionStmts, type PersistedEvent } from '../events/event-projection'
import { dispatchEvent } from '../events/dispatch'
import { authorize } from '../events/authorize'
import { handleCellGlossesReadRequest } from '../events/cell-glosses-read-route'
import { makeTestToken } from './helpers/auth'
import type { EventKind } from '../events/types'

const SECRET = 'gloss-test-secret'

interface RecordedStmt {
  sql: string
  args: unknown[]
}

function makeRecordingDb() {
  const recorded: RecordedStmt[] = []
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          recorded.push({ sql: sql.replace(/\s+/g, ' ').trim(), args })
          return this
        },
      } as unknown as AquillaStatement
    },
  } as unknown as AquillaDb
  return { db, recorded }
}

function makeNoOpDb(): AquillaDb {
  function makePrepared() {
    return {
      bind() { return this },
      async first() { return null },
      async all() { return { results: [], success: true, meta: {} } },
      async run() { return { success: true, meta: {} } },
      raw: async () => [],
    } as unknown as AquillaStatement
  }
  return {
    prepare: makePrepared,
    async batch(ss: AquillaStatement[]) {
      return ss.map(() => ({ success: true, results: [], meta: {} }))
    },
    dump: async () => new ArrayBuffer(0),
    exec: async () => ({ count: 0, duration: 0 }),
  } as unknown as AquillaDb
}

function makeGlossEvent(overrides: Partial<PersistedEvent> = {}): PersistedEvent {
  return {
    id: 'evt-gloss-1',
    schemaVersion: 1,
    projectId: 'p1',
    fileId: 'f1',
    cellId: 'c1',
    parentId: null,
    kind: 'cell.gloss.set',
    author: 'alice',
    payload: {
      glossText: 'house of-him',
      targetEventId: 'evt-target-001',
    },
    clientTs: 10,
    serverTs: 100,
    serverSeq: 5,
    ...overrides,
  }
}

describe('cell.gloss.set projection', () => {
  it('upserts into cell_glosses only — not cells, cell_validators or cell_backtranslations', () => {
    const { db, recorded } = makeRecordingDb()
    const stmts: AquillaStatement[] = []
    const touches = buildEventProjectionStmts(db, makeGlossEvent(), stmts)

    expect(touches).toEqual(['cell_glosses'])
    expect(stmts).toHaveLength(1)

    const { sql } = recorded[0]
    expect(sql).toContain('INSERT INTO cell_glosses')
    expect(sql).toContain('ON CONFLICT(project_id, file_id, cell_id, target_event_id)')
    expect(sql).not.toContain('UPDATE cells')
    expect(sql).not.toContain('INSERT INTO cells')
    expect(sql).not.toContain('cell_validators')
    expect(sql).not.toContain('cell_backtranslations')
  })

  it('binds the correct column values', () => {
    const { db, recorded } = makeRecordingDb()
    buildEventProjectionStmts(db, makeGlossEvent(), [])
    const args = recorded[0].args
    // project_id, file_id, cell_id, target_event_id, gloss_text, author,
    // event_id, server_seq, created_at, then the lane resolve (project, tag).
    expect(args.slice(0, 9)).toEqual([
      'p1', 'f1', 'c1', 'evt-target-001', 'house of-him', 'alice', 'evt-gloss-1', 5, 100,
    ])
    expect(recorded[0].sql).toContain('lane_id')
    expect(args[9]).toBe('p1')
    expect(args[10]).toBe('')
  })

  it('resolves lane_id from targetLang, not from a lane name', () => {
    const { db, recorded } = makeRecordingDb()
    buildEventProjectionStmts(
      db,
      makeGlossEvent({ payload: { glossText: 'casa de-el', targetEventId: 'e', targetLang: 'es' } }),
      [],
    )
    expect(recorded[0].args[9]).toBe('p1')
    expect(recorded[0].args[10]).toBe('es')
  })

  // Withdrawing a correction has to travel, because other members are reading
  // the correction right now. Deleting the row instead would leave them on it
  // until they reloaded.
  it('writes an empty gloss rather than deleting the row, so a withdrawal syncs', () => {
    const { db, recorded } = makeRecordingDb()
    const touches = buildEventProjectionStmts(
      db,
      makeGlossEvent({ payload: { glossText: '', targetEventId: 'evt-target-001' } }),
      [],
    )
    expect(touches).toEqual(['cell_glosses'])
    expect(recorded[0].sql).toContain('INSERT INTO cell_glosses')
    expect(recorded[0].sql).not.toContain('DELETE')
    expect(recorded[0].args[4]).toBe('')
  })

  it('throws when fileId or cellId is missing', () => {
    const { db } = makeRecordingDb()
    expect(() => buildEventProjectionStmts(db, makeGlossEvent({ fileId: null }), []))
      .toThrow('missing fileId or cellId')
    expect(() => buildEventProjectionStmts(db, makeGlossEvent({ cellId: null }), []))
      .toThrow('missing fileId or cellId')
  })
})

async function authorizeGloss(roleLevel: number) {
  const token = await makeTestToken(SECRET, { projectId: 'proj-a', fileId: 'file-x', role: roleLevel })
  const raw = {
    id: 'evt-gloss-dispatch-1',
    schemaVersion: 1,
    kind: 'cell.gloss.set' as EventKind,
    projectId: 'proj-a',
    fileId: 'file-x',
    cellId: 'cell-1',
    parentId: null,
    author: 'alice',
    payload: { glossText: 'house of-him', targetEventId: 'evt-tgt-100' },
    clientTs: 1000,
  }
  return authorize(token, raw as never, SECRET)
}

// The ticket's words are "any contributor on the project ... not limited to
// admins or reviewers". Contributor(400) is that floor, and it is the same rung
// cell.backtranslation.set sits on.
describe('role gate: cell.gloss.set', () => {
  it('contributor (400) may correct the gloss', async () => {
    expect((await authorizeGloss(400)).ok).toBe(true)
  })

  it('project_lead (500) may correct the gloss', async () => {
    expect((await authorizeGloss(500)).ok).toBe(true)
  })

  it('reviewer (300) may not', async () => {
    const result = await authorizeGloss(300)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect([401, 403]).toContain(result.status)
  })

  it('viewer (100) may not', async () => {
    expect((await authorizeGloss(100)).ok).toBe(false)
  })
})

describe('dispatch: cell.gloss.set', () => {
  it('is non-chain-mutating: events INSERT + one cell_glosses upsert', async () => {
    const authResult = await authorizeGloss(400)
    if (!authResult.ok) throw new Error('auth failed')
    const outcome = dispatchEvent(makeNoOpDb(), authResult.event, 9999, { serverSeq: 2, updateProjection: true })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('unreachable')
    expect(outcome.result.stmts).toHaveLength(2)
    expect(outcome.result.dirtyTables).toContain('events')
    expect(outcome.result.dirtyTables).toContain('cell_glosses')
    expect(outcome.result.dirtyTables).not.toContain('cells')
    expect(outcome.result.dirtyTables).not.toContain('cell_validators')
  })
})

interface GlossRow {
  cell_id: string
  target_event_id: string
  gloss_text: string
  author: string
  event_id: string
  created_at: number
}

function makeReadDb(rows: GlossRow[]) {
  return {
    prepare() {
      return {
        bind() {
          return { all: async <T>() => ({ results: rows as unknown as T[] }) }
        },
      }
    },
  } as unknown as AquillaDb
}

async function readReq(
  env: { AQUILLA_PG?: AquillaDb; SYNC_SECRET_KEY?: string },
  token?: string,
  extra = '',
) {
  return handleCellGlossesReadRequest(
    new Request(`https://w/api/v1/projects/p1/files/f1/glosses${extra}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }),
    env,
  )
}

describe('GET /api/v1/projects/:p/files/:f/glosses', () => {
  it('returns null for unrelated paths', async () => {
    const res = await handleCellGlossesReadRequest(
      new Request('https://w/api/v1/projects/p1/files/f1/backtranslations'),
      { AQUILLA_PG: makeReadDb([]), SYNC_SECRET_KEY: SECRET },
    )
    expect(res).toBeNull()
  })

  it('401 without a token', async () => {
    const res = (await readReq({ AQUILLA_PG: makeReadDb([]), SYNC_SECRET_KEY: SECRET }))!
    expect(res.status).toBe(401)
  })

  // Reading the gloss is reading the project; only correcting it is gated.
  it('viewer (100) may read corrected glosses', async () => {
    const token = await makeTestToken(SECRET, { projectId: 'p1', fileId: 'f1', role: 100 })
    const res = (await readReq({ AQUILLA_PG: makeReadDb([]), SYNC_SECRET_KEY: SECRET }, token))!
    expect(res.status).toBe(200)
  })

  it('maps rows to the camelCase response shape', async () => {
    const token = await makeTestToken(SECRET, { projectId: 'p1', fileId: 'f1', role: 100 })
    const rows: GlossRow[] = [{
      cell_id: 'c1',
      target_event_id: 'evt-t-1',
      gloss_text: 'house of-him',
      author: 'alice',
      event_id: 'evt-gloss-1',
      created_at: 500,
    }]
    const res = (await readReq({ AQUILLA_PG: makeReadDb(rows), SYNC_SECRET_KEY: SECRET }, token))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as { glosses: Record<string, unknown>[] }
    expect(body.glosses).toEqual([{
      cellId: 'c1',
      targetEventId: 'evt-t-1',
      glossText: 'house of-him',
      author: 'alice',
      eventId: 'evt-gloss-1',
      createdAt: 500,
    }])
  })

  it('returns an empty array when nothing in the file has been corrected', async () => {
    const token = await makeTestToken(SECRET, { projectId: 'p1', fileId: 'f1', role: 100 })
    const res = (await readReq({ AQUILLA_PG: makeReadDb([]), SYNC_SECRET_KEY: SECRET }, token))!
    const body = (await res.json()) as { glosses: unknown[] }
    expect(body.glosses).toHaveLength(0)
  })

  it('400 when lane is longer than 64 characters', async () => {
    const token = await makeTestToken(SECRET, { projectId: 'p1', fileId: 'f1', role: 100 })
    const res = (await readReq(
      { AQUILLA_PG: makeReadDb([]), SYNC_SECRET_KEY: SECRET },
      token,
      `?lane=${'e'.repeat(65)}`,
    ))!
    expect(res.status).toBe(400)
  })

  it('500 without SYNC_SECRET_KEY configured', async () => {
    const res = (await readReq({ AQUILLA_PG: makeReadDb([]) }))!
    expect(res.status).toBe(500)
  })
})

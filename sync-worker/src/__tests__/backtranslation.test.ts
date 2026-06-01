// Tests for the cell.backtranslation.set event grammar:
//   - Role gate: contributor CAN set a BT; viewer CANNOT (401/403).
//   - Projection: event upserts into cell_backtranslations (not cells).
//   - cells.event_id is NOT touched by a BT set (non-chain-mutating).
//   - The read route returns the latest BT per cell.

import { describe, it, expect } from 'vitest'
import { buildEventProjectionStmts, type PersistedEvent } from '../events/event-projection'
import { dispatchEvent } from '../events/dispatch'
import { authorize } from '../events/authorize'
import { handleCellBacktranslationsReadRequest } from '../events/cell-backtranslations-read-route'
import { makeTestToken } from './helpers/auth'
import type { EventKind } from '../events/types'

const SECRET = 'bt-test-secret'

// ── Recording D1 stub (captures sql + args without hitting a real DB) ────────

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
      } as unknown as D1PreparedStatement
    },
  } as unknown as D1Database
  return { db, recorded }
}

function makeNoOpDb(): D1Database {
  function makePrepared(sql: string) {
    let boundArgs: unknown[] = []
    const stmt = {
      bind(...args: unknown[]) { boundArgs = args; return this },
      async first() { return null },
      async all() { return { results: [], success: true, meta: {} } },
      async run() { return { success: true, meta: {} } },
      raw: async () => [],
    } as unknown as D1PreparedStatement
    ;(stmt as any).__sql = sql
    ;(stmt as any).__getArgs = () => boundArgs
    return stmt
  }
  return {
    prepare: makePrepared,
    async batch(ss: D1PreparedStatement[]) {
      return ss.map(() => ({ success: true, results: [], meta: {} }))
    },
    dump: async () => new ArrayBuffer(0),
    exec: async () => ({ count: 0, duration: 0 }),
  } as unknown as D1Database
}

function makeBtEvent(overrides: Partial<PersistedEvent> = {}): PersistedEvent {
  return {
    id: 'evt-bt-1',
    schemaVersion: 1,
    projectId: 'p1',
    fileId: 'f1',
    cellId: 'c1',
    parentId: null,
    kind: 'cell.backtranslation.set',
    author: 'alice',
    payload: {
      btText: 'in the beginning',
      btHtml: '<em>in the beginning</em>',
      targetEventId: 'evt-target-001',
      polished: false,
    },
    clientTs: 10,
    serverTs: 100,
    serverSeq: 5,
    ...overrides,
  }
}

// ── Projection tests ──────────────────────────────────────────────────────────

describe('cell.backtranslation.set projection', () => {
  it('upserts into cell_backtranslations only — does NOT touch cells or cell_validators', () => {
    const { db, recorded } = makeRecordingDb()
    const stmts: D1PreparedStatement[] = []
    const touches = buildEventProjectionStmts(db, makeBtEvent(), stmts)

    // Only cell_backtranslations is touched — cells.event_id is NOT moved.
    expect(touches).toEqual(['cell_backtranslations'])
    expect(stmts).toHaveLength(1)

    const stmt = recorded[0]
    expect(stmt.sql).toContain('INSERT INTO cell_backtranslations')
    expect(stmt.sql).toContain('ON CONFLICT(project_id, file_id, cell_id, target_event_id)')
    // Must NOT touch cells table (chain-mutating operations).
    expect(stmt.sql).not.toContain('UPDATE cells')
    expect(stmt.sql).not.toContain('INSERT INTO cells')
    // Must NOT touch cell_validators (validation/endorsement are unaffected).
    expect(stmt.sql).not.toContain('cell_validators')
  })

  it('binds the correct column values', () => {
    const { db, recorded } = makeRecordingDb()
    const stmts: D1PreparedStatement[] = []
    buildEventProjectionStmts(
      db,
      makeBtEvent({
        payload: {
          btText: 'in the beginning',
          btHtml: '<em>in the beginning</em>',
          targetEventId: 'evt-target-001',
          polished: true,
        },
      }),
      stmts,
    )
    const args = recorded[0].args
    // project_id, file_id, cell_id, target_event_id, bt_text, bt_html, polished, author, event_id, server_seq, created_at
    expect(args[0]).toBe('p1')
    expect(args[1]).toBe('f1')
    expect(args[2]).toBe('c1')
    expect(args[3]).toBe('evt-target-001')
    expect(args[4]).toBe('in the beginning')
    expect(args[5]).toBe('<em>in the beginning</em>')
    expect(args[6]).toBe(1)   // polished = true → 1
    expect(args[7]).toBe('alice')
    expect(args[8]).toBe('evt-bt-1')  // event_id
    expect(args[9]).toBe(5)           // server_seq
    expect(args[10]).toBe(100)        // created_at = serverTs
  })

  it('serializes polished=false as 0', () => {
    const { db, recorded } = makeRecordingDb()
    const stmts: D1PreparedStatement[] = []
    buildEventProjectionStmts(db, makeBtEvent(), stmts)
    expect(recorded[0].args[6]).toBe(0)
  })

  it('passes btHtml=null when omitted from payload', () => {
    const { db, recorded } = makeRecordingDb()
    const stmts: D1PreparedStatement[] = []
    buildEventProjectionStmts(
      db,
      makeBtEvent({
        payload: {
          btText: 'hello',
          targetEventId: 'evt-t-2',
          polished: false,
        },
      }),
      stmts,
    )
    expect(recorded[0].args[5]).toBeNull()
  })

  it('throws when fileId or cellId is missing', () => {
    const { db } = makeRecordingDb()
    const stmts: D1PreparedStatement[] = []
    expect(() =>
      buildEventProjectionStmts(db, makeBtEvent({ fileId: null }), stmts),
    ).toThrow('missing fileId or cellId')
    expect(() =>
      buildEventProjectionStmts(db, makeBtEvent({ cellId: null }), stmts),
    ).toThrow('missing fileId or cellId')
  })
})

// ── Dispatch / role-gate tests ────────────────────────────────────────────────

async function makeAuthorizedBt(roleLevel: number) {
  const token = await makeTestToken(SECRET, { projectId: 'proj-a', fileId: 'file-x', role: roleLevel })
  const raw = {
    id: 'evt-bt-dispatch-1',
    schemaVersion: 1,
    kind: 'cell.backtranslation.set' as EventKind,
    projectId: 'proj-a',
    fileId: 'file-x',
    cellId: 'cell-1',
    parentId: null,
    author: 'alice',
    payload: {
      btText: 'hello world',
      targetEventId: 'evt-tgt-100',
      polished: false,
    },
    clientTs: 1000,
  }
  return authorize(token, raw as any, SECRET)
}

describe('role gate: cell.backtranslation.set', () => {
  it('contributor (400) is authorized to set a BT', async () => {
    const result = await makeAuthorizedBt(400)
    expect(result.ok).toBe(true)
  })

  it('reviewer (300) is NOT authorized to set a BT', async () => {
    const result = await makeAuthorizedBt(300)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    // 401 = unauthenticated; 403 = authenticated but insufficient role
    expect([401, 403]).toContain(result.status)
  })

  it('viewer (100) is NOT authorized to set a BT', async () => {
    const result = await makeAuthorizedBt(100)
    expect(result.ok).toBe(false)
  })

  it('project_lead (500) is authorized to set a BT', async () => {
    const result = await makeAuthorizedBt(500)
    expect(result.ok).toBe(true)
  })
})

describe('dispatch: cell.backtranslation.set', () => {
  it('routes to the cell handler and returns 1 stmt (events INSERT only when updateProjection=false)', async () => {
    const authResult = await makeAuthorizedBt(400)
    if (!authResult.ok) throw new Error('auth failed')
    const outcome = dispatchEvent(makeNoOpDb(), authResult.event, 9999, { updateProjection: false })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('unreachable')
    // updateProjection=false → only the events INSERT (AD-2 stale-sibling path)
    expect(outcome.result.stmts).toHaveLength(1)
  })

  it('routes to the cell handler and returns 2 stmts (events INSERT + bt upsert) when updateProjection=true', async () => {
    const authResult = await makeAuthorizedBt(400)
    if (!authResult.ok) throw new Error('auth failed')
    const outcome = dispatchEvent(makeNoOpDb(), authResult.event, 9999, { updateProjection: true })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('unreachable')
    // events INSERT + 1 cell_backtranslations upsert = 2
    expect(outcome.result.stmts).toHaveLength(2)
    expect(outcome.result.dirtyTables).toContain('events')
    expect(outcome.result.dirtyTables).toContain('cell_backtranslations')
  })

  it('does NOT include cells or cell_validators in dirtyTables', async () => {
    const authResult = await makeAuthorizedBt(400)
    if (!authResult.ok) throw new Error('auth failed')
    const outcome = dispatchEvent(makeNoOpDb(), authResult.event, 9999, { updateProjection: true })
    if (!outcome.ok) throw new Error('unreachable')
    expect(outcome.result.dirtyTables).not.toContain('cells')
    expect(outcome.result.dirtyTables).not.toContain('cell_validators')
  })
})

// ── Read route tests ──────────────────────────────────────────────────────────

interface BtRow {
  cell_id: string
  target_event_id: string
  bt_text: string
  bt_html: string | null
  polished: number
  author: string
  event_id: string
  created_at: number
}

function makeReadDb(rows: BtRow[]) {
  return {
    prepare() {
      return {
        bind() {
          return {
            all: async <T>() => ({ results: rows as unknown as T[] }),
          }
        },
      }
    },
  } as unknown as D1Database
}

async function readReq(
  env: { AQUILLA_DB?: D1Database; SYNC_SECRET_KEY?: string },
  token?: string,
  extra = '',
) {
  return handleCellBacktranslationsReadRequest(
    new Request(`https://w/api/v1/projects/p1/files/f1/backtranslations${extra}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }),
    env,
  )
}

describe('GET /api/v1/projects/:p/files/:f/backtranslations', () => {
  it('returns null for unrelated paths', async () => {
    const res = await handleCellBacktranslationsReadRequest(
      new Request('https://w/api/v1/projects/p1/files/f1/cells'),
      { AQUILLA_DB: makeReadDb([]), SYNC_SECRET_KEY: SECRET },
    )
    expect(res).toBeNull()
  })

  it('401 without a token', async () => {
    const res = (await readReq({ AQUILLA_DB: makeReadDb([]), SYNC_SECRET_KEY: SECRET }))!
    expect(res).not.toBeNull()
    expect(res.status).toBe(401)
  })

  it('viewer (100) CAN read BTs via the read route', async () => {
    const token = await makeTestToken(SECRET, { projectId: 'p1', fileId: 'f1', role: 100 })
    const rows: BtRow[] = [
      {
        cell_id: 'c1', target_event_id: 'evt-t-1', bt_text: 'hello', bt_html: null,
        polished: 0, author: 'alice', event_id: 'evt-bt-x', created_at: 100,
      },
    ]
    const res = (await readReq({ AQUILLA_DB: makeReadDb(rows), SYNC_SECRET_KEY: SECRET }, token))!
    expect(res.status).toBe(200)
  })

  it('maps rows to camelCase response shape', async () => {
    const token = await makeTestToken(SECRET, { projectId: 'p1', fileId: 'f1', role: 100 })
    const rows: BtRow[] = [
      {
        cell_id: 'c1', target_event_id: 'evt-t-1', bt_text: 'in the beginning',
        bt_html: '<em>in the beginning</em>', polished: 1, author: 'alice',
        event_id: 'evt-bt-1', created_at: 500,
      },
      {
        cell_id: 'c2', target_event_id: 'evt-t-2', bt_text: 'God created',
        bt_html: null, polished: 0, author: 'bob', event_id: 'evt-bt-2', created_at: 600,
      },
    ]
    const res = (await readReq({ AQUILLA_DB: makeReadDb(rows), SYNC_SECRET_KEY: SECRET }, token))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as { backtranslations: unknown[] }
    expect(body.backtranslations).toHaveLength(2)

    const first = body.backtranslations[0] as Record<string, unknown>
    expect(first.cellId).toBe('c1')
    expect(first.targetEventId).toBe('evt-t-1')
    expect(first.btText).toBe('in the beginning')
    expect(first.btHtml).toBe('<em>in the beginning</em>')
    expect(first.polished).toBe(true)
    expect(first.author).toBe('alice')
    expect(first.eventId).toBe('evt-bt-1')
    expect(first.createdAt).toBe(500)

    const second = body.backtranslations[1] as Record<string, unknown>
    expect(second.btHtml).toBeNull()
    expect(second.polished).toBe(false)
  })

  it('returns empty array when no BTs exist for the file', async () => {
    const token = await makeTestToken(SECRET, { projectId: 'p1', fileId: 'f1', role: 100 })
    const res = (await readReq({ AQUILLA_DB: makeReadDb([]), SYNC_SECRET_KEY: SECRET }, token))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as { backtranslations: unknown[] }
    expect(body.backtranslations).toHaveLength(0)
  })

  it('500 without SYNC_SECRET_KEY configured', async () => {
    const res = (await readReq({ AQUILLA_DB: makeReadDb([]) }))!
    expect(res).not.toBeNull()
    expect(res.status).toBe(500)
  })
})

// ── Non-chain-mutating contract: BT set does NOT touch cells.event_id ─────────

describe('cell.backtranslation.set does not move cells.event_id', () => {
  it('projection SQL does not contain UPDATE cells SET event_id', () => {
    const { db, recorded } = makeRecordingDb()
    const stmts: D1PreparedStatement[] = []
    buildEventProjectionStmts(db, makeBtEvent(), stmts)
    for (const r of recorded) {
      // No statement should advance the cells chain head.
      expect(r.sql).not.toMatch(/UPDATE cells SET.*event_id/i)
      expect(r.sql).not.toMatch(/INSERT INTO cells/i)
    }
  })

  it('projection SQL does not touch cell_validators (validations unaffected)', () => {
    const { db, recorded } = makeRecordingDb()
    const stmts: D1PreparedStatement[] = []
    buildEventProjectionStmts(db, makeBtEvent(), stmts)
    for (const r of recorded) {
      expect(r.sql).not.toContain('cell_validators')
      expect(r.sql).not.toContain('endorsement_count')
    }
  })
})

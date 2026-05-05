// Tests for handleCellCommit.
//
// Uses a minimal D1 stub that records (sql, args) pairs from prepare().bind()
// calls. We only need to inspect what statements were produced, not execute
// them against a real DB.

import { describe, it, expect } from 'vitest'
import { handleCellCommit } from '../events/handlers/cell-commit'
import { authorize } from '../events/authorize'
import { makeTestToken } from './helpers/auth'
import type { RawEvent } from '../events/types'

const SECRET = 'test-secret'

async function makeToken(): Promise<string> {
  return makeTestToken(SECRET, { projectId: 'proj-a', fileId: 'file-x' })
}

function makeRawCommit(overrides: Partial<RawEvent<'cell.commit'>> = {}): RawEvent<'cell.commit'> {
  return {
    id: 'evt-00000000-0000-7000-0000-000000000001',
    schemaVersion: 1,
    kind: 'cell.commit',
    projectId: 'proj-a',
    fileId: 'file-x',
    cellId: 'cell-1',
    author: 'alice',
    payload: { value: 'hello world', valueHtml: '<p>hello world</p>' },
    clientTs: 1000,
    ...overrides,
  }
}

// Minimal D1 stub that records prepared statements without executing SQL.
// We record (sql, args) pairs to verify statement content and ordering.
interface RecordedStmt {
  sql: string
  args: unknown[]
}

function makeRecordingD1(): { db: D1Database; recorded: () => RecordedStmt[] } {
  const stmts: RecordedStmt[] = []

  function makePrepared(sql: string) {
    let boundArgs: unknown[] = []
    const stmt = {
      bind(...args: unknown[]) {
        boundArgs = args
        return this
      },
      async first() { return null },
      async all() { return { results: [], success: true, meta: {} } },
      async run() { return { success: true, meta: {} } },
      raw: async () => [],
    } as unknown as D1PreparedStatement
    ;(stmt as any).__sql = sql
    ;(stmt as any).__getArgs = () => boundArgs
    return stmt
  }

  const db = {
    prepare(sql: string) {
      return makePrepared(sql)
    },
    async batch(ss: D1PreparedStatement[]) {
      for (const s of ss) {
        stmts.push({
          sql: (s as any).__sql ?? '',
          args: (s as any).__getArgs?.() ?? [],
        })
      }
      return ss.map(() => ({ success: true, results: [], meta: {} }))
    },
    dump: async () => new ArrayBuffer(0),
    exec: async () => ({ count: 0, duration: 0 }),
  } as unknown as D1Database

  return {
    db,
    recorded: () => stmts,
  }
}

// Extract (sql, args) from a D1PreparedStatement produced by handleCellCommit.
// handleCellCommit returns statements without batching them, so we read __sql/__getArgs.
function readStmt(stmt: D1PreparedStatement): RecordedStmt {
  return {
    sql: ((stmt as any).__sql ?? '') as string,
    args: ((stmt as any).__getArgs?.() ?? []) as unknown[],
  }
}

describe('handleCellCommit', () => {
  it('returns events INSERT with INSERT OR IGNORE and correct bind params', async () => {
    const { db } = makeRecordingD1()
    const token = await makeToken()
    const raw = makeRawCommit()
    const authResult = await authorize(token, raw, SECRET)
    expect(authResult.ok).toBe(true)
    if (!authResult.ok) throw new Error('auth failed')

    const serverTs = 9999
    const result = handleCellCommit(db, authResult.event, serverTs)

    // First statement is the events INSERT
    const eventsInsert = readStmt(result.stmts[0])
    expect(eventsInsert.sql).toMatch(/INSERT OR IGNORE INTO events/)
    expect(eventsInsert.args[0]).toBe(raw.id)            // id
    expect(eventsInsert.args[1]).toBe(raw.schemaVersion) // schema_version
    expect(eventsInsert.args[2]).toBe(raw.projectId)     // project_id
    expect(eventsInsert.args[3]).toBe(raw.fileId)        // file_id
    expect(eventsInsert.args[4]).toBe(raw.cellId)        // cell_id
    expect(eventsInsert.args[5]).toBe('cell.commit')     // kind
    expect(eventsInsert.args[6]).toBe(raw.author)        // author
    expect(eventsInsert.args[7]).toBe(JSON.stringify(raw.payload)) // payload (JSON)
    expect(eventsInsert.args[8]).toBe(raw.clientTs)      // client_ts
    expect(eventsInsert.args[9]).toBe(serverTs)          // server_ts
  })

  it('returns the cells UPSERT from buildEventProjectionStmts (second statement)', async () => {
    const { db } = makeRecordingD1()
    const token = await makeToken()
    const raw = makeRawCommit()
    const authResult = await authorize(token, raw, SECRET)
    expect(authResult.ok).toBe(true)
    if (!authResult.ok) throw new Error('auth failed')

    const result = handleCellCommit(db, authResult.event, 9999)

    // cell.commit produces exactly 2 statements: events INSERT + cells UPSERT
    expect(result.stmts).toHaveLength(2)
    const cellsUpsert = readStmt(result.stmts[1])
    expect(cellsUpsert.sql).toMatch(/INSERT INTO cells/)
    expect(cellsUpsert.sql).toMatch(/ON CONFLICT/)
  })

  it('events INSERT comes BEFORE the cells UPSERT in stmts order', async () => {
    const { db } = makeRecordingD1()
    const token = await makeToken()
    const raw = makeRawCommit()
    const authResult = await authorize(token, raw, SECRET)
    expect(authResult.ok).toBe(true)
    if (!authResult.ok) throw new Error('auth failed')

    const result = handleCellCommit(db, authResult.event, 9999)

    const first = readStmt(result.stmts[0])
    const second = readStmt(result.stmts[1])
    expect(first.sql).toMatch(/INSERT OR IGNORE INTO events/)
    expect(second.sql).toMatch(/INSERT INTO cells/)
  })

  it('returns eventFrame with correct shape and values', async () => {
    const { db } = makeRecordingD1()
    const token = await makeToken()
    const raw = makeRawCommit()
    const authResult = await authorize(token, raw, SECRET)
    expect(authResult.ok).toBe(true)
    if (!authResult.ok) throw new Error('auth failed')

    const serverTs = 12345
    const result = handleCellCommit(db, authResult.event, serverTs)

    expect(result.eventFrame).toEqual({
      v: 1,
      t: 'event',
      id: raw.id,
      kind: 'cell.commit',
      project: raw.projectId,
      file: raw.fileId,
      cell: raw.cellId,
      ts: serverTs,
    })
  })

  it('returns dirtyTables containing events and cells', async () => {
    const { db } = makeRecordingD1()
    const token = await makeToken()
    const raw = makeRawCommit()
    const authResult = await authorize(token, raw, SECRET)
    expect(authResult.ok).toBe(true)
    if (!authResult.ok) throw new Error('auth failed')

    const result = handleCellCommit(db, authResult.event, 9999)

    expect(result.dirtyTables).toContain('events')
    expect(result.dirtyTables).toContain('cells')
    expect(result.dirtyTables).toHaveLength(2)
  })

  it('uses serverTs (not clientTs) in both the events row and the cells projection', async () => {
    const { db } = makeRecordingD1()
    const token = await makeToken()
    const raw = makeRawCommit({ clientTs: 1111 })
    const authResult = await authorize(token, raw, SECRET)
    expect(authResult.ok).toBe(true)
    if (!authResult.ok) throw new Error('auth failed')

    const serverTs = 9999999
    const result = handleCellCommit(db, authResult.event, serverTs)

    // events INSERT: arg[9] is server_ts
    const eventsInsert = readStmt(result.stmts[0])
    expect(eventsInsert.args[9]).toBe(serverTs)
    expect(eventsInsert.args[9]).not.toBe(1111)

    // cells UPSERT: arg[6] is last_edit_at (comes from event.serverTs in event-projection)
    const cellsUpsert = readStmt(result.stmts[1])
    expect(cellsUpsert.args[6]).toBe(serverTs)
  })

  it('sets payload as JSON.stringify of the event payload object', async () => {
    const { db } = makeRecordingD1()
    const token = await makeToken()
    const payload = { value: 'test text', valueHtml: '<p>test text</p>', prevEventId: 'prev-evt' }
    const raw = makeRawCommit({ payload })
    const authResult = await authorize(token, raw, SECRET)
    expect(authResult.ok).toBe(true)
    if (!authResult.ok) throw new Error('auth failed')

    const result = handleCellCommit(db, authResult.event, 9999)

    const eventsInsert = readStmt(result.stmts[0])
    expect(eventsInsert.args[7]).toBe(JSON.stringify(payload))
    // Verify it's a string, not an object
    expect(typeof eventsInsert.args[7]).toBe('string')
  })
})

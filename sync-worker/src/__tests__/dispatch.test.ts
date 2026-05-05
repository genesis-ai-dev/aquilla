// Tests for dispatchEvent.
//
// Verifies that the dispatcher routes cell.commit to handleCellCommit and
// returns 501 for all other currently-known EventKinds. The exhaustiveness
// check in dispatch.ts (the `default: never` branch) ensures that any new
// EventKind added to types.ts will trigger a TypeScript compile error until
// a case is added to dispatchEvent.

import { describe, it, expect } from 'vitest'
import { dispatchEvent } from '../events/dispatch'
import { authorize } from '../events/authorize'
import { makeTestToken } from './helpers/auth'
import type { EventKind, RawEvent } from '../events/types'

const SECRET = 'test-secret'

async function makeToken(
  overrides: Record<string, unknown> = {},
): Promise<string> {
  return makeTestToken(SECRET, {
    projectId: 'proj-a',
    fileId: 'file-x',
    ...overrides,
  } as any)
}

// Produce an AuthorizedEvent for the given kind. Payload is filled in just
// enough to satisfy authorize() — the dispatcher doesn't validate payload
// shape (that's the handler's job).
async function makeAuthorized<K extends EventKind>(kind: K) {
  // Build a minimal payload per kind so that authorize() can validate the
  // token claims (it only checks kind, projectId, fileId, role — not payload).
  const payloads: Record<EventKind, unknown> = {
    'cell.commit': { value: 'hello', valueHtml: '<p>hello</p>' },
    'cell.validate': { editEventId: 'evt-1' },
    'cell.unvalidate': { editEventId: 'evt-1' },
    'thread.add': { threadId: 't1', content: 'a comment' },
    'thread.resolve': { threadId: 't1' },
    'cell.metadata.set': { field: 'cellLabel', value: 'v' },
  }

  // All kinds except project-level ones need a fileId. All our test events
  // are file-scoped, which covers all current EventKind values.
  const raw = {
    id: 'evt-00000000-0000-7000-0000-000000000001',
    schemaVersion: 1,
    kind,
    projectId: 'proj-a',
    fileId: 'file-x',
    cellId: 'cell-1',
    author: 'alice',
    payload: payloads[kind],
    clientTs: 1000,
  } as unknown as RawEvent<K>

  const token = await makeToken()
  const authResult = await authorize(token, raw, SECRET)
  if (!authResult.ok) {
    throw new Error(`authorize failed for kind ${kind}: ${authResult.reason}`)
  }
  return authResult.event
}

// Minimal no-op D1 stub — dispatch.test only cares about the DispatchOutcome
// shape, not what gets written to D1.
function makeNoOpD1(): D1Database {
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

describe('dispatchEvent', () => {
  it('cell.commit returns { ok: true, result: DispatchResult }', async () => {
    const db = makeNoOpD1()
    const authed = await makeAuthorized('cell.commit')
    const outcome = dispatchEvent(db, authed, Date.now())
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('expected ok')
    expect(outcome.result.stmts).toBeDefined()
    expect(Array.isArray(outcome.result.stmts)).toBe(true)
    expect(outcome.result.stmts.length).toBeGreaterThan(0)
    expect(outcome.result.eventFrame.t).toBe('event')
    expect(outcome.result.dirtyTables).toContain('events')
    expect(outcome.result.dirtyTables).toContain('cells')
  })

  it('cell.validate returns { ok: false, status: 501 }', async () => {
    const db = makeNoOpD1()
    const authed = await makeAuthorized('cell.validate')
    const outcome = dispatchEvent(db, authed, Date.now())
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('expected not ok')
    expect(outcome.status).toBe(501)
    expect(outcome.reason).toContain('cell.validate')
  })

  it('cell.unvalidate returns { ok: false, status: 501 }', async () => {
    const db = makeNoOpD1()
    const authed = await makeAuthorized('cell.unvalidate')
    const outcome = dispatchEvent(db, authed, Date.now())
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('expected not ok')
    expect(outcome.status).toBe(501)
    expect(outcome.reason).toContain('cell.unvalidate')
  })

  it('thread.add returns { ok: false, status: 501 }', async () => {
    const db = makeNoOpD1()
    const authed = await makeAuthorized('thread.add')
    const outcome = dispatchEvent(db, authed, Date.now())
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('expected not ok')
    expect(outcome.status).toBe(501)
    expect(outcome.reason).toContain('thread.add')
  })

  it('thread.resolve returns { ok: false, status: 501 }', async () => {
    const db = makeNoOpD1()
    const authed = await makeAuthorized('thread.resolve')
    const outcome = dispatchEvent(db, authed, Date.now())
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('expected not ok')
    expect(outcome.status).toBe(501)
    expect(outcome.reason).toContain('thread.resolve')
  })

  it('cell.metadata.set returns { ok: false, status: 501 }', async () => {
    const db = makeNoOpD1()
    const authed = await makeAuthorized('cell.metadata.set')
    const outcome = dispatchEvent(db, authed, Date.now())
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('expected not ok')
    expect(outcome.status).toBe(501)
    expect(outcome.reason).toContain('cell.metadata.set')
  })

  it('the caller does not need to know about specific kinds — dispatcher is the single mapping point', async () => {
    // This test verifies the design intent: a handler that uses dispatchEvent
    // only needs to check ok/not-ok; it doesn't switch on kind itself.
    // The dispatcher encapsulates all kind-to-handler routing.
    const db = makeNoOpD1()
    const authed = await makeAuthorized('cell.commit')
    const outcome = dispatchEvent(db, authed, Date.now())
    // The caller only needs to check outcome.ok and outcome.result
    // without importing or referencing any specific handler.
    if (outcome.ok) {
      expect(outcome.result).toBeDefined()
    } else {
      expect(outcome.status).toBeDefined()
      expect(outcome.reason).toBeDefined()
    }
  })
})

// Tests for dispatchEvent.

import { describe, it, expect } from 'vitest'
import { dispatchEvent } from '../events/dispatch'
import { authorize } from '../events/authorize'
import { makeTestToken } from './helpers/auth'
import type { EventKind, RawEvent } from '../events/types'

const SECRET = 'test-secret'

async function makeToken(role = 500): Promise<string> {
  return makeTestToken(SECRET, { projectId: 'proj-a', fileId: 'file-x', role })
}

async function makeAuthorized<K extends EventKind>(kind: K, role = 500) {
  const payloads: Record<EventKind, unknown> = {
    'source.cell.create': { cellId: 'cell-1', value: 'x' },
    'source.cell.commit': { value: 'x' },
    'source.cell.delete': {},
    'source.cell.reorder': { anchorCellId: null },
    'target.cell.create': { cellId: 'cell-1', value: 'x' },
    'target.cell.commit': { value: 'x' },
    'target.cell.delete': {},
    'target.cell.reorder': { anchorCellId: null },
    'cell.validate': { editEventId: 'evt-1' },
    'cell.unvalidate': { editEventId: 'evt-1' },
    'cell.audio.attach': { audioId: 'audio-1.wav', url: 'frontier-audio://audio-1.wav', slot: 'recording' },
    'cell.audio.select': { audioId: 'audio-1.wav', slot: 'recording' },
    'cell.audio.remove': { audioId: 'audio-1.wav' },
    'file.create': { name: 'Genesis', fileType: 'codex' },
    'comment.create': { commentId: 'cmt-1', scope: { kind: 'project' }, body: 'hi', parentCommentId: null },
    'comment.edit': { commentId: 'cmt-1', body: 'updated' },
    'comment.delete': { commentId: 'cmt-1' },
    'comment.resolve': { commentId: 'cmt-1', resolved: true },
  }

  const raw = {
    id: 'evt-00000000-0000-7000-0000-000000000001',
    schemaVersion: 1,
    kind,
    projectId: 'proj-a',
    fileId: 'file-x',
    cellId: kind === 'file.create' ? undefined : 'cell-1',
    parentId: null,
    author: 'alice',
    payload: payloads[kind],
    clientTs: 1000,
  } as unknown as RawEvent<K>

  const token = await makeToken(role)
  const authResult = await authorize(token, raw, SECRET)
  if (!authResult.ok) {
    throw new Error(`authorize failed for kind ${kind}: ${authResult.reason}`)
  }
  return authResult.event
}

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
  it('target.cell.create routes to the cell handler, returns events INSERT + cells UPSERT', async () => {
    const authed = await makeAuthorized('target.cell.create', 400)
    const outcome = dispatchEvent(makeNoOpD1(), authed, 9999, { updateProjection: true, serverSeq: 1 })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('unreachable')
    // 1 events INSERT + 1 FTS delete + 1 cells INSERT + 1 FTS insert
    // + 1 files-counter recompute = 5
    expect(outcome.result.stmts.length).toBe(5)
    expect(outcome.result.dirtyTables).toContain('events')
    expect(outcome.result.dirtyTables).toContain('cells')
    expect(outcome.result.dirtyTables).toContain('files')
  })

  it('cell.validate routes to the cell handler with validator UPSERT + validated recompute + endorsement_count recompute', async () => {
    const authed = await makeAuthorized('cell.validate', 300)
    const outcome = dispatchEvent(makeNoOpD1(), authed, 9999, { updateProjection: true, serverSeq: 1 })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('unreachable')
    // 1 events INSERT + 1 validator UPSERT + 1 validated recompute
    // + 1 endorsement_count recompute (AD-14 pass 1) + 1 files-counter
    // recompute (approved_count moves) = 5
    expect(outcome.result.stmts.length).toBe(5)
    expect(outcome.result.dirtyTables).toContain('cell_validators')
    expect(outcome.result.dirtyTables).toContain('files')
  })

  it('updateProjection=false produces only the events INSERT (AD-2 stale sibling)', async () => {
    const authed = await makeAuthorized('target.cell.commit', 400)
    const outcome = dispatchEvent(makeNoOpD1(), authed, 9999, { updateProjection: false, serverSeq: 1 })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('unreachable')
    expect(outcome.result.stmts.length).toBe(1)
    expect(outcome.result.dirtyTables).toEqual(['events'])
  })

  it('file.create routes to the file handler', async () => {
    const authed = await makeAuthorized('file.create', 500)
    const outcome = dispatchEvent(makeNoOpD1(), authed, 9999, { updateProjection: true, serverSeq: 1 })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('unreachable')
    expect(outcome.result.stmts.length).toBe(2) // events INSERT + files UPSERT
    expect(outcome.result.dirtyTables).toContain('files')
  })

  it('source.* kinds route to the cell handler (with side=source projection)', async () => {
    const authed = await makeAuthorized('source.cell.create', 500)
    const outcome = dispatchEvent(makeNoOpD1(), authed, 9999, { updateProjection: true, serverSeq: 1 })
    expect(outcome.ok).toBe(true)
  })
})

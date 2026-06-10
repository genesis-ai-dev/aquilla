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
    'cell.waive': { ruleId: 'rule-1', reason: 'intentional' },
    'cell.unwaive': { ruleId: 'rule-1' },
    'cell.audio.attach': { audioId: 'audio-1.wav', url: 'frontier-audio://audio-1.wav', slot: 'recording' },
    'cell.audio.select': { audioId: 'audio-1.wav', slot: 'recording' },
    'cell.audio.remove': { audioId: 'audio-1.wav' },
    'file.create': { name: 'Genesis', fileType: 'codex' },
    'file.rename': { name: 'Genesis (renamed)' },
    'file.delete': {},
    'file.restore': {},
    'cell.backtranslation.set': { btText: 'hello', targetEventId: 'evt-tgt-1', polished: false },
    'comment.create': { commentId: 'cmt-1', scope: { kind: 'project' }, body: 'hi', parentCommentId: null },
    'comment.edit': { commentId: 'cmt-1', body: 'updated' },
    'comment.delete': { commentId: 'cmt-1' },
    'comment.resolve': { commentId: 'cmt-1', resolved: true },
    'assignment.create': { assignmentId: 'as-1', scopeKind: 'books', scope: [{ fileId: 'file-x' }], scopeLabel: 'Genesis', assigneeUserId: 2 },
    'assignment.reassign': { assignmentId: 'as-1', assigneeUserId: 3 },
    'assignment.unassign': { assignmentId: 'as-1' },
  }

  const raw = {
    id: 'evt-00000000-0000-7000-0000-000000000001',
    schemaVersion: 1,
    kind,
    projectId: 'proj-a',
    fileId: 'file-x',
    cellId: kind === 'file.create' || kind === 'file.rename' || kind === 'file.delete' || kind === 'file.restore' ? undefined : 'cell-1',
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

function makeNoOpD1(): AquillaDb {
  function makePrepared(sql: string) {
    let boundArgs: unknown[] = []
    const stmt = {
      bind(...args: unknown[]) { boundArgs = args; return this },
      async first() { return null },
      async all() { return { results: [], success: true, meta: {} } },
      async run() { return { success: true, meta: {} } },
      raw: async () => [],
    } as unknown as AquillaStatement
    ;(stmt as any).__sql = sql
    ;(stmt as any).__getArgs = () => boundArgs
    return stmt
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

describe('dispatchEvent', () => {
  it('target.cell.create routes to the cell handler, returns events INSERT + cells UPSERT', async () => {
    const authed = await makeAuthorized('target.cell.create', 400)
    const outcome = dispatchEvent(makeNoOpD1(), authed, 9999, { updateProjection: true })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('unreachable')
    // 1 events INSERT + 1 cells UPSERT + 1 files-counter recompute = 3
    // (Postgres auto-maintains FTS via the value_tsv generated column).
    expect(outcome.result.stmts.length).toBe(3)
    expect(outcome.result.dirtyTables).toContain('events')
    expect(outcome.result.dirtyTables).toContain('cells')
    expect(outcome.result.dirtyTables).toContain('files')
  })

  it('cell.validate routes to the cell handler with validator UPSERT + validated recompute + endorsement_count recompute', async () => {
    const authed = await makeAuthorized('cell.validate', 300)
    const outcome = dispatchEvent(makeNoOpD1(), authed, 9999, { updateProjection: true })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('unreachable')
    // 1 events INSERT + 1 validator UPSERT + 1 ai_drafted clear (FRO-292)
    // + 1 validated recompute + 1 endorsement_count recompute (AD-14 pass 1)
    // + 1 files-counter recompute (approved_count moves) = 6
    expect(outcome.result.stmts.length).toBe(6)
    expect(outcome.result.dirtyTables).toContain('cell_validators')
    expect(outcome.result.dirtyTables).toContain('files')
  })

  it('updateProjection=false produces only the events INSERT (AD-2 stale sibling)', async () => {
    const authed = await makeAuthorized('target.cell.commit', 400)
    const outcome = dispatchEvent(makeNoOpD1(), authed, 9999, { updateProjection: false })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('unreachable')
    expect(outcome.result.stmts.length).toBe(1)
    expect(outcome.result.dirtyTables).toEqual(['events'])
  })

  it('file.create routes to the file handler', async () => {
    const authed = await makeAuthorized('file.create', 500)
    const outcome = dispatchEvent(makeNoOpD1(), authed, 9999, { updateProjection: true })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('unreachable')
    expect(outcome.result.stmts.length).toBe(2) // events INSERT + files UPSERT
    expect(outcome.result.dirtyTables).toContain('files')
  })

  it('file.rename routes to the file handler, returns events INSERT + files UPDATE', async () => {
    // CONTRIBUTOR (400) — label cleanup is normal editing flow, not structural.
    const authed = await makeAuthorized('file.rename', 400)
    const outcome = dispatchEvent(makeNoOpD1(), authed, 9999, { updateProjection: true })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('unreachable')
    expect(outcome.result.stmts.length).toBe(2) // events INSERT + files UPDATE
    expect(outcome.result.dirtyTables).toContain('events')
    expect(outcome.result.dirtyTables).toContain('files')
  })

  it('source.* kinds route to the cell handler (with side=source projection)', async () => {
    const authed = await makeAuthorized('source.cell.create', 500)
    const outcome = dispatchEvent(makeNoOpD1(), authed, 9999, { updateProjection: true })
    expect(outcome.ok).toBe(true)
  })
})

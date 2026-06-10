// Tests for file.delete / file.restore event kinds (FRO-272).
//
// Covers:
//  - dispatch routes file.delete/file.restore to the correct handlers
//  - role floor: PROJECT_LEAD (500) required; CONTRIBUTOR (400) rejected
//  - projection: file.delete stamps deleted_at; file.restore clears it
//  - listing exclusion: GET /files omits tombstoned files; ?trash=1 returns only tombstoned
//  - restore round-trip: delete → restore → file reappears in active listing

import { describe, it, expect } from 'vitest'
import { dispatchEvent } from '../events/dispatch'
import { authorize } from '../events/authorize'
import { handleFilesReadRequest } from '../events/files-read-route'
import { makeTestDb } from './helpers/pg-test-db'
import { makeTestToken } from './helpers/auth'
import type { EventKind, RawEvent } from '../events/types'

const SECRET = 'file-delete-test-secret'

async function makeToken(role = 500, projectId = 'proj-a', fileId = 'file-x'): Promise<string> {
  return makeTestToken(SECRET, { projectId, fileId, role })
}

async function makeAuthorized<K extends EventKind>(
  kind: K,
  role = 500,
  fileId = 'file-x',
  projectId = 'proj-a',
) {
  const raw = {
    id: 'evt-00000000-0000-7000-0000-000000000099',
    schemaVersion: 1,
    kind,
    projectId,
    fileId,
    cellId: undefined,
    parentId: null,
    author: 'alice',
    payload: {},
    clientTs: 1000,
  } as unknown as RawEvent<K>

  const token = await makeToken(role, projectId, fileId)
  const authResult = await authorize(token, raw, SECRET)
  if (!authResult.ok) {
    throw new Error(`authorize failed for kind ${kind}: ${authResult.reason}`)
  }
  return authResult.event
}

function makeNoOpDb() {
  function makePrepared(_sql: string) {
    let bound: unknown[] = []
    const stmt = {
      bind(...args: unknown[]) { bound = args; return this },
      async first() { return null },
      async all() { return { results: [], success: true, meta: {} } },
      async run() { return { success: true, meta: {} } },
      raw: async () => [],
    } as unknown as AquillaStatement
    ;(stmt as any).__getArgs = () => bound
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

function envWith(db: AquillaDb) {
  return { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET }
}

// ── Dispatch routing ──────────────────────────────────────────────────────────

describe('file.delete / file.restore dispatch routing', () => {
  it('file.delete routes to the handler, returns events INSERT + files UPDATE (2 stmts)', async () => {
    const authed = await makeAuthorized('file.delete', 500)
    const outcome = dispatchEvent(makeNoOpDb(), authed, 9999, { updateProjection: true })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('unreachable')
    expect(outcome.result.stmts.length).toBe(2) // events INSERT + files UPDATE
    expect(outcome.result.dirtyTables).toContain('events')
    expect(outcome.result.dirtyTables).toContain('files')
    expect(outcome.result.eventFrame.kind).toBe('file.delete')
  })

  it('file.restore routes to the handler, returns events INSERT + files UPDATE (2 stmts)', async () => {
    const authed = await makeAuthorized('file.restore', 500)
    const outcome = dispatchEvent(makeNoOpDb(), authed, 9999, { updateProjection: true })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('unreachable')
    expect(outcome.result.stmts.length).toBe(2)
    expect(outcome.result.dirtyTables).toContain('files')
    expect(outcome.result.eventFrame.kind).toBe('file.restore')
  })
})

// ── Role policy ───────────────────────────────────────────────────────────────

describe('file.delete / file.restore role floor (PROJECT_LEAD = 500)', () => {
  it('file.delete is rejected for CONTRIBUTOR (400)', async () => {
    // authorize() enforces the role gate; should fail with 403.
    const raw = {
      id: 'evt-role-test-01',
      schemaVersion: 1,
      kind: 'file.delete' as EventKind,
      projectId: 'proj-a',
      fileId: 'file-x',
      cellId: undefined,
      parentId: null,
      author: 'bob',
      payload: {},
      clientTs: 1000,
    } as unknown as RawEvent
    const token = await makeToken(400)
    const result = await authorize(token, raw, SECRET)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.status).toBe(403)
  })

  it('file.restore is rejected for CONTRIBUTOR (400)', async () => {
    const raw = {
      id: 'evt-role-test-02',
      schemaVersion: 1,
      kind: 'file.restore' as EventKind,
      projectId: 'proj-a',
      fileId: 'file-x',
      cellId: undefined,
      parentId: null,
      author: 'bob',
      payload: {},
      clientTs: 1000,
    } as unknown as RawEvent
    const token = await makeToken(400)
    const result = await authorize(token, raw, SECRET)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.status).toBe(403)
  })

  it('file.delete is allowed for PROJECT_LEAD (500)', async () => {
    const authed = await makeAuthorized('file.delete', 500)
    expect(authed.event.kind).toBe('file.delete')
  })
})

// ── Projection tombstone ──────────────────────────────────────────────────────

describe('file.delete / file.restore projection (PGlite)', () => {
  it('file.delete stamps deleted_at; file.restore clears it', async () => {
    const { db, rows } = await makeTestDb({
      files: [
        {
          id: 'file-x',
          project_id: 'proj-a',
          name: 'Genesis',
          file_type: 'codex',
          event_id: 'genesis-event',
        },
      ],
    })

    // Dispatch file.delete.
    const deleteAuthed = await makeAuthorized('file.delete', 500)
    const deleteOutcome = dispatchEvent(db, deleteAuthed, 42000, { updateProjection: true })
    expect(deleteOutcome.ok).toBe(true)
    if (!deleteOutcome.ok) throw new Error('unreachable')
    await db.batch(deleteOutcome.result.stmts)

    const afterDelete = await rows<{ id: string; deleted_at: number | null }>('files')
    const fileAfterDelete = afterDelete.find((r) => r.id === 'file-x')
    expect(fileAfterDelete).toBeDefined()
    expect(fileAfterDelete!.deleted_at).toBe(42000)

    // Dispatch file.restore.
    const restoreAuthed = await makeAuthorized('file.restore', 500)
    const restoreOutcome = dispatchEvent(db, restoreAuthed, 45000, { updateProjection: true })
    expect(restoreOutcome.ok).toBe(true)
    if (!restoreOutcome.ok) throw new Error('unreachable')
    await db.batch(restoreOutcome.result.stmts)

    const afterRestore = await rows<{ id: string; deleted_at: number | null }>('files')
    const fileAfterRestore = afterRestore.find((r) => r.id === 'file-x')
    expect(fileAfterRestore!.deleted_at).toBeNull()
  })

  it('file.delete is idempotent — double-delete leaves deleted_at unchanged', async () => {
    const { db, rows } = await makeTestDb({
      files: [{ id: 'file-x', project_id: 'proj-a', name: 'Genesis', file_type: 'codex', event_id: 'ev1' }],
    })

    const authed1 = await makeAuthorized('file.delete', 500)
    const o1 = dispatchEvent(db, authed1, 11000, { updateProjection: true })
    if (!o1.ok) throw new Error('unreachable')
    await db.batch(o1.result.stmts)

    // Second file.delete with a different event id should not overwrite deleted_at.
    const raw2 = {
      id: 'evt-delete-2',
      schemaVersion: 1,
      kind: 'file.delete' as EventKind,
      projectId: 'proj-a',
      fileId: 'file-x',
      parentId: null,
      author: 'alice',
      payload: {},
      clientTs: 2000,
    } as unknown as RawEvent
    const token = await makeToken(500)
    const auth2 = await authorize(token, raw2, SECRET)
    if (!auth2.ok) throw new Error(`authorize failed: ${auth2.reason}`)
    const o2 = dispatchEvent(db, auth2.event, 22000, { updateProjection: true })
    if (!o2.ok) throw new Error('unreachable')
    await db.batch(o2.result.stmts)

    const all = await rows<{ id: string; deleted_at: number | null }>('files')
    const f = all.find((r) => r.id === 'file-x')
    // First delete wins: deleted_at stays at 11000.
    expect(f!.deleted_at).toBe(11000)
  })
})

// ── Listing exclusion ─────────────────────────────────────────────────────────

describe('GET /files listing exclusion (PGlite)', () => {
  it('active listing omits tombstoned files; ?trash=1 returns only tombstoned', async () => {
    const { db } = await makeTestDb({
      files: [
        { id: 'file-active', project_id: 'proj-a', name: 'Active', file_type: 'codex', event_id: 'ev-a' },
        { id: 'file-deleted', project_id: 'proj-a', name: 'Deleted', file_type: 'codex', event_id: 'ev-d', deleted_at: 12345 },
      ],
    })

    const token = await makeToken(500, 'proj-a', 'any')

    // Normal listing → only active file.
    const reqActive = new Request('https://w/api/v1/projects/proj-a/files', {
      headers: { Authorization: `Bearer ${token}` },
    })
    const resActive = (await handleFilesReadRequest(reqActive, envWith(db)))!
    expect(resActive.status).toBe(200)
    const bodyActive = (await resActive.json()) as { files: Array<{ fileId: string }> }
    expect(bodyActive.files.map((f) => f.fileId)).toEqual(['file-active'])

    // Trash listing → only tombstoned file.
    const reqTrash = new Request('https://w/api/v1/projects/proj-a/files?trash=1', {
      headers: { Authorization: `Bearer ${token}` },
    })
    const resTrash = (await handleFilesReadRequest(reqTrash, envWith(db)))!
    expect(resTrash.status).toBe(200)
    const bodyTrash = (await resTrash.json()) as { files: Array<{ fileId: string; deletedAt: number }> }
    expect(bodyTrash.files).toHaveLength(1)
    expect(bodyTrash.files[0].fileId).toBe('file-deleted')
    expect(bodyTrash.files[0].deletedAt).toBe(12345)
  })

  it('restore round-trip: delete → restore → file reappears in active listing', async () => {
    const { db } = await makeTestDb({
      files: [
        { id: 'file-x', project_id: 'proj-a', name: 'Genesis', file_type: 'codex', event_id: 'ev1' },
      ],
    })

    // Soft-delete.
    const deleteAuthed = await makeAuthorized('file.delete', 500)
    const dOutcome = dispatchEvent(db, deleteAuthed, 5000, { updateProjection: true })
    if (!dOutcome.ok) throw new Error('unreachable')
    await db.batch(dOutcome.result.stmts)

    // Verify gone from active listing.
    const token = await makeToken(500, 'proj-a', 'file-x')
    const req1 = new Request('https://w/api/v1/projects/proj-a/files', {
      headers: { Authorization: `Bearer ${token}` },
    })
    const res1 = (await handleFilesReadRequest(req1, envWith(db)))!
    const body1 = (await res1.json()) as { files: unknown[] }
    expect(body1.files).toHaveLength(0)

    // Restore.
    const restoreAuthed = await makeAuthorized('file.restore', 500)
    const rOutcome = dispatchEvent(db, restoreAuthed, 6000, { updateProjection: true })
    if (!rOutcome.ok) throw new Error('unreachable')
    await db.batch(rOutcome.result.stmts)

    // File reappears in active listing.
    const req2 = new Request('https://w/api/v1/projects/proj-a/files', {
      headers: { Authorization: `Bearer ${token}` },
    })
    const res2 = (await handleFilesReadRequest(req2, envWith(db)))!
    const body2 = (await res2.json()) as { files: Array<{ fileId: string }> }
    expect(body2.files).toHaveLength(1)
    expect(body2.files[0].fileId).toBe('file-x')
  })
})

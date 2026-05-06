import { describe, it, expect } from 'vitest'
import { handleFileCreate } from '../events/handlers/file-create'
import { authorize } from '../events/authorize'
import { makeTestToken } from './helpers/auth'
import { makeInMemoryD1 } from './helpers/d1-fake'
import type { RawEvent } from '../events/types'

const SECRET = 'file-create-secret'

async function makeToken(role = 500) {
  return makeTestToken(SECRET, { projectId: 'p1', fileId: 'f-new', role })
}

function makeRaw(overrides: Partial<RawEvent<'file.create'>> = {}): RawEvent<'file.create'> {
  return {
    id: 'evt-fc-00000000-0000-7000-0000-000000000001',
    schemaVersion: 1,
    kind: 'file.create',
    projectId: 'p1',
    fileId: 'f-new',
    author: 'admin',
    payload: {
      name: 'Genesis',
      fileType: 'codex',
      sourceLanguage: 'eng',
      targetLanguage: 'spa',
    },
    clientTs: 1700,
    ...overrides,
  }
}

describe('handleFileCreate', () => {
  it('produces an events INSERT and a files UPSERT in order', async () => {
    const token = await makeToken()
    const raw = makeRaw()
    const result = await authorize(token, raw, SECRET)
    if (!result.ok) throw new Error(`auth failed: ${result.reason}`)

    const db = makeInMemoryD1()
    const out = handleFileCreate(db, result.event, 1700)

    expect(out.stmts).toHaveLength(2)
    expect(out.dirtyTables).toEqual(['events', 'files'])
    expect(out.eventFrame).toMatchObject({
      v: 1,
      t: 'event',
      id: raw.id,
      kind: 'file.create',
      project: 'p1',
      file: 'f-new',
      ts: 1700,
    })
  })

  it('through dispatch + d1-fake batches: file row appears with name/languages', async () => {
    const { dispatchEvent } = await import('../events/dispatch')
    const token = await makeToken()
    const raw = makeRaw()
    const result = await authorize(token, raw, SECRET)
    if (!result.ok) throw new Error(`auth failed: ${result.reason}`)

    const db = makeInMemoryD1()
    const outcome = dispatchEvent(db, result.event, 1700)
    if (!outcome.ok) throw new Error(`dispatch failed: ${outcome.reason}`)

    await db.batch(outcome.result.stmts)

    const tables = db._tables()
    expect(tables.events).toHaveLength(1)
    expect(tables.events[0]).toMatchObject({
      id: raw.id,
      kind: 'file.create',
      project_id: 'p1',
      file_id: 'f-new',
      cell_id: null,
      // Author is bound from the verified JWT claims, not raw.author —
      // makeTestToken defaults username to 'alice'.
      author: 'alice',
      server_ts: 1700,
    })
    expect(JSON.parse(tables.events[0].payload)).toEqual({
      name: 'Genesis',
      fileType: 'codex',
      sourceLanguage: 'eng',
      targetLanguage: 'spa',
    })

    expect(tables.files).toHaveLength(1)
    expect(tables.files[0]).toMatchObject({
      id: 'f-new',
      project_id: 'p1',
      name: 'Genesis',
      file_type: 'codex',
      source_language: 'eng',
      target_language: 'spa',
      cell_count: 0,
      approved_count: 0,
      word_count: 0,
    })
  })

  it('rejects when role is below PROJECT_LEAD', async () => {
    // Contributor (400) < PROJECT_LEAD (500) — this kind requires project lead.
    const token = await makeToken(400)
    const raw = makeRaw()
    const result = await authorize(token, raw, SECRET)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(403)
  })

  it('UPSERT preserves cell_count/approved_count/word_count when re-emitted', async () => {
    // Simulate: file.create lands, then cell.commits accumulate via the
    // projection path (cell_count increases). A re-emitted file.create
    // (e.g. an idempotent re-import) must NOT reset those counters.
    const { dispatchEvent } = await import('../events/dispatch')
    const token = await makeToken()
    const raw = makeRaw()
    const result = await authorize(token, raw, SECRET)
    if (!result.ok) throw new Error(`auth: ${result.reason}`)

    const db = makeInMemoryD1({
      files: [
        {
          id: 'f-new',
          project_id: 'p1',
          name: 'Old Name',
          file_type: 'codex',
          source_language: 'eng',
          target_language: 'spa',
          cell_count: 42,
          approved_count: 7,
          word_count: 333,
          last_edit_at: 9999,
        },
      ],
    })
    const outcome = dispatchEvent(db, result.event, 1800)
    if (!outcome.ok) throw new Error(`dispatch: ${outcome.reason}`)
    await db.batch(outcome.result.stmts)

    const file = db._tables().files.find((f) => f.id === 'f-new')!
    // Administrative fields updated.
    expect(file.name).toBe('Genesis')
    // Counters preserved.
    expect(file.cell_count).toBe(42)
    expect(file.approved_count).toBe(7)
    expect(file.word_count).toBe(333)
    expect(file.last_edit_at).toBe(9999)
  })

  it('throws when fileId is missing', async () => {
    const token = await makeToken()
    const raw = makeRaw({ fileId: undefined })
    const result = await authorize(token, raw, SECRET)
    if (!result.ok) {
      // The current authorize() pipeline allows fileId-less file.create through;
      // if that changes (and it should, eventually) update this assertion.
      // For now we test the handler in isolation:
    }

    const db = makeInMemoryD1()
    if (result.ok) {
      expect(() => handleFileCreate(db, result.event, 1700)).toThrow(/missing fileId/)
    } else {
      // Fine — auth catches it earlier. Either layer is acceptable.
      expect(result.status).toBeGreaterThanOrEqual(400)
    }
  })
})

import { describe, expect, it } from 'vitest'

import { handleBulkImportRequest } from '../events/import-route'
import { handleRebuildProjectionRequest } from '../events/rebuild'
import {
  handleImportReconcileRequest,
  planImportReconciliation,
  type ExistingImportCell,
} from '../events/import-reconcile-route'
import { makeTestToken } from './helpers/auth'
import { makeTestDb } from './helpers/pg-test-db'

const SECRET = 'reimport-secret'
const PROJECT_ID = 'project-reimport'
const FILE_ID = 'file-reimport'

async function token(): Promise<string> {
  return makeTestToken(SECRET, { projectId: PROJECT_ID, fileId: FILE_ID, role: 500 })
}

function env(db: AquillaDb) {
  return { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET }
}

function importMetadata(unitKey: string, physicalOrder: number) {
  return {
    aquillaImport: {
      version: 1,
      profileId: 'builtin:usfm-lossless',
      profileVersion: '1',
      unitKey,
      kind: 'verse',
      displayLabel: String(physicalOrder + 1),
      address: { scheme: 'scripture', book: 'GEN', chapter: 1, verse: String(physicalOrder + 1) },
      sourceLocator: { kind: 'usfm', ref: `GEN 1:${physicalOrder + 1}`, marker: 'v' },
      physicalOrder,
      fidelity: 'native',
    },
  }
}

describe('planImportReconciliation', () => {
  it('matches stable unit identity before changing cell ids and retains missing units', () => {
    const existing: ExistingImportCell[] = [{
      cellId: 'durable-cell', eventId: 'old-event', value: 'Old', valueHtml: null,
      type: 'verse', canonicalRef: 'GEN 1:1', anchorCellId: null,
      startMs: null, endMs: null, sequenceIndex: 0, medium: null,
      metadata: importMetadata('scripture:GEN 1:1', 0),
    }, {
      cellId: 'retained-cell', eventId: 'retained-event', value: 'Keep me', valueHtml: null,
      type: 'verse', canonicalRef: 'GEN 1:2', anchorCellId: 'durable-cell',
      startMs: null, endMs: null, sequenceIndex: 1, medium: null,
      metadata: importMetadata('scripture:GEN 1:2', 1),
    }]
    const plan = planImportReconciliation([{
      id: 'new-event', cellId: 'parser-generated-id', value: 'New', type: 'verse',
      canonicalRef: 'GEN 1:1', sequenceIndex: 0,
      metadata: importMetadata('scripture:GEN 1:1', 0),
    }], existing)

    expect(plan.cells[0]).toMatchObject({
      originalCellId: 'parser-generated-id',
      finalCellId: 'durable-cell',
      parentId: 'old-event',
      changed: true,
      matchKind: 'unit-key',
    })
    expect(plan.retainedMissing).toEqual(['retained-cell'])
  })

  it('rejects ambiguous identities instead of guessing', () => {
    const duplicate = (cellId: string): ExistingImportCell => ({
      cellId, eventId: `${cellId}-event`, value: cellId, valueHtml: null,
      type: 'verse', canonicalRef: null, anchorCellId: null,
      startMs: null, endMs: null, sequenceIndex: null, medium: null,
      metadata: importMetadata('scripture:GEN 1:1', 0),
    })
    expect(() => planImportReconciliation([{
      id: 'incoming-event', cellId: 'incoming-cell', value: 'New',
      metadata: importMetadata('scripture:GEN 1:1', 0),
    }], [duplicate('a'), duplicate('b')])).toThrow(/ambiguous duplicate unit key/)
  })
})

describe('POST /import/reconcile', () => {
  it('preserves target lanes and missing cells while updating stable units atomically', async () => {
    const auth = await token()
    const { db, rows } = await makeTestDb()
    const initial = new Request('https://worker/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}` },
      body: JSON.stringify({
        projectId: PROJECT_ID,
        fileId: FILE_ID,
        file: {
          id: 'file-genesis-event',
          name: 'Genesis',
          fileType: 'usfm',
          role: 'source',
          kind: 'usfm',
          bookCode: 'GEN',
          importFormat: 'usfm',
          parserVersion: 'builtin:usfm-lossless@1',
          importManifest: { version: 1, profileId: 'builtin:usfm-lossless', profileVersion: '1' },
        },
        cells: [{
          id: 'source-old-1', cellId: 'durable-1', value: 'Old verse one', type: 'verse',
          canonicalRef: 'GEN 1:1', sequenceIndex: 0,
          metadata: importMetadata('scripture:GEN 1:1', 0),
        }, {
          id: 'source-old-2', cellId: 'durable-2', anchorCellId: 'durable-1',
          value: 'Verse two must stay', type: 'verse', canonicalRef: 'GEN 1:2', sequenceIndex: 1,
          metadata: importMetadata('scripture:GEN 1:2', 1),
        }],
        targets: [{
          id: 'target-old-1', cellId: 'durable-1', parentId: 'source-old-1',
          value: 'Traduction existante', targetLang: 'fr',
        }],
      }),
    })
    expect((await handleBulkImportRequest(initial, env(db)))?.status).toBe(200)
    const initialFile = (await rows<any>('files'))[0]
    const initialMeta = typeof initialFile.meta === 'string' ? JSON.parse(initialFile.meta) : initialFile.meta
    await db.prepare(`UPDATE files SET meta = ? WHERE id = ? AND project_id = ?`)
      // Emulate metadata double-encoded by the former postgres.js JSON bind.
      .bind(JSON.stringify(JSON.stringify({ ...initialMeta, coreMediaUrl: 'https://media.example/core.mp4' })), FILE_ID, PROJECT_ID)
      .run()
    await db.prepare(
      `UPDATE cells SET metadata = metadata || '{"cast_name":"Narrator"}'::jsonb
        WHERE project_id = ? AND file_id = ? AND cell_id = ? AND side = 'source'`,
    ).bind(PROJECT_ID, FILE_ID, 'durable-1').run()
    await db.prepare(
      `UPDATE cells SET metadata = to_jsonb(metadata::text)
        WHERE project_id = ? AND file_id = ? AND cell_id = ? AND side = 'source'`,
    ).bind(PROJECT_ID, FILE_ID, 'durable-1').run()

    const request = new Request('https://worker/import/reconcile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}` },
      body: JSON.stringify({
        projectId: PROJECT_ID,
        fileId: FILE_ID,
        file: {
          id: 'file-reimport-event', name: 'A renamed upload that must not rename the file',
          fileType: 'usfm', role: 'source', kind: 'usfm', bookCode: 'GEN',
          importFormat: 'usfm', parserVersion: 'builtin:usfm-lossless@1',
          importManifest: { version: 1, profileId: 'builtin:usfm-lossless', profileVersion: '1', unitCount: 2 },
        },
        cells: [{
          id: 'source-new-1', cellId: 'parser-1', value: 'Updated verse one', type: 'verse',
          canonicalRef: 'GEN 1:1', sequenceIndex: 0,
          metadata: importMetadata('scripture:GEN 1:1', 0),
        }, {
          id: 'source-new-3', cellId: 'parser-3', anchorCellId: 'parser-1',
          value: 'New verse three', type: 'verse', canonicalRef: 'GEN 1:3', sequenceIndex: 1,
          metadata: importMetadata('scripture:GEN 1:3', 1),
        }],
        targets: [{
          id: 'target-imported-1', cellId: 'parser-1', parentId: 'source-new-1',
          value: 'Must not overwrite', targetLang: 'fr',
        }, {
          id: 'target-imported-3', cellId: 'parser-3', parentId: 'source-new-3',
          value: 'Nouvelle traduction', targetLang: 'fr',
        }],
      }),
    })
    const response = await handleImportReconcileRequest(request, env(db))
    const responseBody = await response?.json() as Record<string, unknown>
    if (response?.status !== 200) throw new Error(JSON.stringify(responseBody))
    expect(responseBody).toMatchObject({
      matched: 1,
      added: 1,
      changed: 2,
      retainedMissing: 1,
      importedTargets: 1,
    })

    const cells = await rows<any>('cells')
    const source = cells.filter((cell) => cell.side === 'source')
    const target = cells.filter((cell) => cell.side === 'target')
    expect(source).toHaveLength(3)
    expect(source.find((cell) => cell.cell_id === 'durable-1')).toMatchObject({
      value: 'Updated verse one', event_id: 'source-new-1',
    })
    expect(source.find((cell) => cell.cell_id === 'durable-1').metadata.cast_name).toBe('Narrator')
    expect(source.find((cell) => cell.cell_id === 'durable-2')).toMatchObject({
      value: 'Verse two must stay', event_id: 'source-old-2',
    })
    const added = source.find((cell) => cell.value === 'New verse three')
    expect(added.cell_id).toBe('parser-3')
    expect(target.find((cell) => cell.cell_id === 'durable-1')).toMatchObject({
      value: 'Traduction existante', source_event_id: 'source-old-1', target_lang: 'fr',
    })
    expect(target.find((cell) => cell.cell_id === 'parser-3')).toMatchObject({
      value: 'Nouvelle traduction', source_event_id: 'source-new-3', target_lang: 'fr',
    })

    const file = (await rows<any>('files'))[0]
    expect(file.name).toBe('Genesis')
    expect(file.event_id).toBe('file-reimport-event')
    expect(file.cell_count).toBe(3)
    expect(JSON.parse(file.meta).coreMediaUrl).toBe('https://media.example/core.mp4')

    const events = await rows<any>('events')
    expect(events.find((event) => event.id === 'source-new-1')).toMatchObject({
      parent_id: 'source-old-1', kind: 'source.cell.create', cell_id: 'durable-1',
    })

    // Event-log rebuild must reproduce the same merged file metadata and
    // source/target identities as the live transaction.
    const rebuild = await handleRebuildProjectionRequest(new Request(
      `https://worker/admin/projects/${PROJECT_ID}/rebuild-projection`,
      { method: 'POST', headers: { Authorization: `Bearer ${SECRET}` } },
    ), env(db))
    expect(rebuild?.status).toBe(200)
    const rebuiltCells = await rows<any>('cells')
    expect(rebuiltCells.find((cell) => cell.side === 'source' && cell.cell_id === 'durable-1'))
      .toMatchObject({ value: 'Updated verse one', event_id: 'source-new-1' })
    expect(rebuiltCells.find((cell) => cell.side === 'target' && cell.cell_id === 'durable-1'))
      .toMatchObject({ value: 'Traduction existante', source_event_id: 'source-old-1' })
    const rebuiltFile = (await rows<any>('files'))[0]
    expect(JSON.parse(rebuiltFile.meta).coreMediaUrl).toBe('https://media.example/core.mp4')

    // Exact HTTP replay converges without writing another branch.
    const replay = new Request('https://worker/import/reconcile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}` },
      body: JSON.stringify({
        projectId: PROJECT_ID,
        fileId: FILE_ID,
        file: { id: 'file-reimport-event', name: 'Genesis', fileType: 'usfm' },
        cells: [],
      }),
    })
    expect(await (await handleImportReconcileRequest(replay, env(db)))?.json()).toMatchObject({ replayed: true })
    expect((await rows<any>('events')).length).toBe(events.length)
  }, 120_000)

  it('rejects malformed cells and event-id reuse without writing anything', async () => {
    const auth = await token()
    const { db, rows } = await makeTestDb()
    const malformed = await handleImportReconcileRequest(new Request('https://worker/import/reconcile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}` },
      body: JSON.stringify({
        projectId: PROJECT_ID,
        fileId: FILE_ID,
        file: { id: 'file-event', name: 'File' },
        cells: [{ id: 'cell-event', cellId: 'cell', value: 42, metadata: {} }],
      }),
    }), env(db))
    expect(malformed?.status).toBe(400)
    expect(await rows('events')).toEqual([])

    const duplicate = await handleImportReconcileRequest(new Request('https://worker/import/reconcile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}` },
      body: JSON.stringify({
        projectId: PROJECT_ID,
        fileId: FILE_ID,
        file: { id: 'same-event', name: 'File' },
        cells: [{
          id: 'same-event', cellId: 'cell', value: 'Text',
          metadata: importMetadata('sequence:1', 0),
        }],
      }),
    }), env(db))
    expect(duplicate?.status).toBe(400)
    expect(await rows('events')).toEqual([])
  })

  it('rolls the entire re-import back when a concurrent source edit wins a cell claim', async () => {
    const auth = await token()
    const { db, rows } = await makeTestDb()
    const initial = await handleBulkImportRequest(new Request('https://worker/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}` },
      body: JSON.stringify({
        projectId: PROJECT_ID,
        fileId: FILE_ID,
        file: { id: 'file-initial', name: 'File', fileType: 'txt' },
        cells: [{
          id: 'source-initial', cellId: 'durable-cell', value: 'Original',
          metadata: importMetadata('sequence:Paragraph', 0),
        }],
      }),
    }), env(db))
    expect(initial?.status).toBe(200)
    await db.prepare(
      `INSERT INTO chain_claims (project_id, file_id, cell_id, parent_key, event_id)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(
      PROJECT_ID,
      FILE_ID,
      'durable-cell',
      'source-initial@side:source',
      'concurrent-source-edit',
    ).run()

    const response = await handleImportReconcileRequest(new Request('https://worker/import/reconcile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}` },
      body: JSON.stringify({
        projectId: PROJECT_ID,
        fileId: FILE_ID,
        file: { id: 'file-reimport-conflict', name: 'File', fileType: 'txt' },
        cells: [{
          id: 'source-reimport-conflict', cellId: 'parser-cell', value: 'Incoming',
          metadata: importMetadata('sequence:Paragraph', 0),
        }],
      }),
    }), env(db))

    expect(response?.status).toBe(409)
    expect(await response?.text()).toMatch(/file changed during re-import/)
    expect((await rows<any>('files'))[0]).toMatchObject({ event_id: 'file-initial' })
    expect((await rows<any>('cells')).find((cell) => cell.side === 'source'))
      .toMatchObject({ value: 'Original', event_id: 'source-initial' })
    expect((await rows<any>('events')).map((event) => event.id)).not.toContain('file-reimport-conflict')
  })
})

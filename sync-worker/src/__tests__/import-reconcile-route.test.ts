import { describe, expect, it } from 'vitest'

import { handleBulkImportRequest } from '../events/import-route'
import { buildEventProjectionStmts } from '../events/event-projection'
import { handleRebuildProjectionRequest } from '../events/rebuild'
import {
  handleImportReconcileRequest,
  planImportReconciliation,
  type ExistingImportCell,
  type ReconcileImportCell,
} from '../events/import-reconcile-route'
import { decideReviewCell } from '../events/import-reconcile-review'
import { makeTestToken } from './helpers/auth'
import { makeTestDb } from './helpers/pg-test-db'
import { MAX_IMPORT_REQUEST_BODY_BYTES } from '../../../shared/import-contract'

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

  // AQU-1394 — a docx whose every unit key shifted because a paragraph was
  // inserted at the top. Identity matching finds nothing; content matching has
  // to land each surviving paragraph back on its own cell, or the translations
  // already sitting on those cells are stranded.
  describe('content matching (AQU-1394)', () => {
    const paragraph = (index: number, value: string): ExistingImportCell => ({
      cellId: `cell-${index}`, eventId: `event-${index}`, value, valueHtml: null,
      type: 'paragraph', canonicalRef: null,
      anchorCellId: index === 0 ? null : `cell-${index - 1}`,
      startMs: null, endMs: null, sequenceIndex: index, medium: null,
      metadata: importMetadata(`docx:p${index}`, index),
    })
    const incoming = (index: number, value: string) => ({
      id: `incoming-event-${index}`, cellId: `incoming-cell-${index}`, value,
      anchorCellId: index === 0 ? null : `incoming-cell-${index - 1}`,
      type: 'paragraph', sequenceIndex: index,
      metadata: importMetadata(`docx:p${index}`, index),
    })

    it('adopts the old cell when the unit keys all shift', () => {
      const existing = [paragraph(0, 'Alpha.'), paragraph(1, 'Beta.'), paragraph(2, 'Gamma.')]
      const plan = planImportReconciliation(
        [incoming(0, 'Preface.'), incoming(1, 'Alpha.'), incoming(2, 'Beta.'), incoming(3, 'Gamma.')],
        existing,
      )

      // Every unit key still resolves, but each now names the paragraph above
      // it. None of those pairs is locked, so content matching hands each old
      // cell back to the paragraph that still reads the same, and only the
      // preface is left as new.
      expect(plan.cells.map((cell) => cell.finalCellId))
        .toEqual(['incoming-cell-0', 'cell-0', 'cell-1', 'cell-2'])
      expect(plan.cells.map((cell) => cell.matchKind))
        .toEqual(['new', 'content-exact', 'content-ice', 'content-ice'])
      expect(plan.cells.map((cell) => cell.matchBand))
        .toEqual(['new', 'exact', 'ice', 'ice'])
      expect(plan.cells.map((cell) => cell.parentId))
        .toEqual([null, 'event-0', 'event-1', 'event-2'])
      expect(plan.retainedMissing).toEqual([])
    })

    it('does not resurrect a cell whose paragraph was deleted', () => {
      const existing = [paragraph(0, 'Alpha.'), paragraph(1, 'Dropped.'), paragraph(2, 'Gamma.')]
      const plan = planImportReconciliation([incoming(0, 'Alpha.'), incoming(1, 'Gamma.')], existing)

      // "Alpha." is unchanged, so its unit-key pair is locked; "Gamma." follows
      // its text to cell-2 and the deleted paragraph's cell is retained.
      expect(plan.cells.map((cell) => cell.finalCellId)).toEqual(['cell-0', 'cell-2'])
      expect(plan.cells.map((cell) => cell.matchKind)).toEqual(['unit-key', 'content-exact'])
      expect(plan.cells.map((cell) => cell.matchBand)).toEqual(['exact', 'exact'])
      expect(plan.retainedMissing).toEqual(['cell-1'])
    })

    it('reads the previous order from the anchor chain, not the row order', () => {
      const shuffled = [paragraph(2, 'Gamma.'), paragraph(0, 'Alpha.'), paragraph(1, 'Beta.')]
      const plan = planImportReconciliation(
        [incoming(0, 'Alpha.'), incoming(1, 'Beta.'), incoming(2, 'Gamma.')],
        shuffled,
      )
      expect(plan.cells.map((cell) => cell.matchBand)).toEqual(['ice', 'ice', 'ice'])
    })

    it('keeps a heading when the story id and the apostrophe both change', () => {
      const existing = [paragraph(0, 'Israel\u02BCs covenant history')]
      existing[0]!.metadata = importMetadata(
        'idml:Stories/Story_u363.xml:/idPkg:Story[1]/Story[1]/ParagraphStyleRange[7]:0',
        0,
      )
      const next = incoming(0, "Israel's covenant history")
      next.metadata = importMetadata(
        'idml:Stories/Story_u452.xml:/idPkg:Story[1]/Story[1]/ParagraphStyleRange[7]:0',
        0,
      )
      const plan = planImportReconciliation([next], existing)
      expect(plan.cells[0]).toMatchObject({
        finalCellId: 'cell-0',
        matchKind: 'content-ice',
        parentId: 'event-0',
      })
      expect(plan.retainedMissing).toEqual([])
      expect(decideReviewCell(plan.cells[0]!, existing[0]!)).toMatchObject({
        writeSource: true,
        textChanged: false,
        repinQuiet: true,
      })
    })

    it('leaves a genuinely new file entirely new', () => {
      const plan = planImportReconciliation([incoming(0, 'Alpha.')], [])
      expect(plan.cells[0]).toMatchObject({ matchKind: 'new', matchBand: 'new', parentId: null })
    })
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

// AQU-1987 — Biblica added front matter (the Bible name, the book name) to the
// top of each book after those books had already been imported and translated.
// The ask is that a re-import ADDS those cells to the existing file instead of
// forcing a fresh import, and that it does so for a project that began in
// Aquilla, not only one mirrored from Codex.
//
// WHY these tests matter: every guarantee below is a property of the planner,
// so a regression here is silent — the re-import still "succeeds" and the
// damage (stranded translations, withdrawn validation, duplicated books) only
// shows up in a translator's file. Reconciliation is link-agnostic: these are
// plain existing cells with no upstream source link, which is the Aquilla-native
// (Russian BSB) case.
describe('front matter added by a re-import (AQU-1987)', () => {
  const structureMetadata = (ref: string, physicalOrder: number) => ({
    aquillaImport: {
      version: 1, profileId: 'builtin:usfm-lossless', profileVersion: '1',
      unitKey: `scripture-structure:${ref}`, kind: 'paratext', displayLabel: null,
      address: { scheme: 'scripture-structure', book: 'GEN', chapter: null },
      sourceLocator: { kind: 'usfm', ref },
      physicalOrder, fidelity: 'native',
    },
  })

  // The book as it stands in the project: a section heading and two verses,
  // already translated. No front matter.
  const BODY = [
    { value: 'The Creation', type: 'heading', ref: 'GEN 1:s1:1', unitKey: 'scripture-structure:GEN 1:s1:1' },
    { value: 'In the beginning God created the heavens and the earth.', type: 'verse', ref: 'GEN 1:1', unitKey: 'scripture:GEN 1:1' },
    { value: 'Now the earth was formless and empty.', type: 'verse', ref: 'GEN 1:2', unitKey: 'scripture:GEN 1:2' },
  ] as const

  // The three cells the republished source adds above it. `\h` and `\mt1` carry
  // the SAME text ("Genesis"), which is how Biblica's books actually read.
  const FRONT_MATTER = [
    { marker: 'toc1', value: 'The Holy Bible', ref: 'GEN:toc1:1' },
    { marker: 'h', value: 'Genesis', ref: 'GEN:h:1' },
    { marker: 'mt1', value: 'Genesis', ref: 'GEN:mt1:1' },
  ] as const

  const existingBody = (): ExistingImportCell[] => BODY.map((unit, index) => ({
    cellId: `cell-${index}`, eventId: `event-${index}`, value: unit.value, valueHtml: null,
    type: unit.type, canonicalRef: unit.ref, anchorCellId: index === 0 ? null : `cell-${index - 1}`,
    startMs: null, endMs: null, sequenceIndex: index, medium: null,
    metadata: {
      aquillaImport: {
        version: 1, profileId: 'builtin:usfm-lossless', profileVersion: '1',
        unitKey: unit.unitKey, kind: unit.type === 'verse' ? 'verse' : 'heading',
        displayLabel: null, physicalOrder: index, fidelity: 'native',
      },
    },
  }))

  /** The uploaded document, with or without the new front matter on top. */
  const uploaded = (withFrontMatter: boolean) => {
    const cells: ReconcileImportCell[] = []
    const push = (cellId: string, value: string, type: string, ref: string, metadata: unknown) => {
      cells.push({
        id: `incoming-event-${cells.length}`, cellId, value, type, canonicalRef: ref,
        anchorCellId: cells.length === 0 ? null : cells[cells.length - 1]!.cellId,
        sequenceIndex: cells.length, metadata: metadata as Record<string, unknown>,
      })
    }
    if (withFrontMatter) {
      for (const unit of FRONT_MATTER) {
        push(`incoming-${unit.marker}`, unit.value, 'paratext', unit.ref, structureMetadata(unit.ref, cells.length))
      }
    }
    for (const unit of BODY) {
      push(`incoming-body-${cells.length}`, unit.value, unit.type, unit.ref, {
        aquillaImport: {
          version: 1, profileId: 'builtin:usfm-lossless', profileVersion: '1',
          unitKey: unit.unitKey, kind: unit.type === 'verse' ? 'verse' : 'heading',
          displayLabel: null, physicalOrder: cells.length, fidelity: 'native',
        },
      })
    }
    return cells
  }

  it('adds the new heading cells at the head of the file', () => {
    const plan = planImportReconciliation(uploaded(true), existingBody())

    // Three genuinely new cells, then the book exactly as it was — and the
    // anchor chain runs through them, so the headings render at the START of
    // the book rather than being appended after the last verse.
    expect(plan.cells.map((cell) => cell.matchKind))
      .toEqual(['new', 'new', 'new', 'unit-key', 'unit-key', 'unit-key'])
    expect(plan.cells.map((cell) => cell.finalCellId))
      .toEqual(['incoming-toc1', 'incoming-h', 'incoming-mt1', 'cell-0', 'cell-1', 'cell-2'])
    expect(plan.cells.map((cell) => cell.incoming.anchorCellId))
      .toEqual([null, 'incoming-toc1', 'incoming-h', 'incoming-mt1', 'cell-0', 'cell-1'])
  })

  it('leaves every already-translated cell on its own cell id', () => {
    const existing = existingBody()
    const plan = planImportReconciliation(uploaded(true), existing)

    // Targets, comments, audio, assignments and validator votes are all keyed
    // by the logical cell id, so keeping the id IS keeping the translation.
    // Nothing is dropped either: no existing unit is left behind as missing.
    expect(plan.cells.slice(3).map((cell) => cell.parentId)).toEqual(['event-0', 'event-1', 'event-2'])
    expect(plan.retainedMissing).toEqual([])

    // Shifting down the page is not an edit. Each body cell is re-pinned
    // quietly: the new source head is written, but the text did not change, so
    // the lane is never flagged for review and the votes stand.
    const existingById = new Map(existing.map((cell) => [cell.cellId, cell]))
    for (const cell of plan.cells.slice(3)) {
      expect(decideReviewCell(cell, existingById.get(cell.finalCellId))).toMatchObject({
        textChanged: false,
        repinQuiet: true,
      })
    }
  })

  it('keeps two identically-worded headings as two separate new cells', () => {
    const plan = planImportReconciliation(uploaded(true), existingBody())

    // `\h Genesis` and `\mt1 Genesis` read the same. They are distinct units
    // with distinct unit keys, and collapsing them (or pairing one with the
    // other's cell) would lose a line the publisher needs translated.
    const headings = plan.cells.filter((cell) => cell.incoming.value === 'Genesis')
    expect(headings).toHaveLength(2)
    expect(new Set(headings.map((cell) => cell.finalCellId)).size).toBe(2)
    expect(headings.every((cell) => cell.matchKind === 'new')).toBe(true)
  })

  it('adds nothing and changes nothing when the source is unchanged', () => {
    const existing = existingBody()
    const plan = planImportReconciliation(uploaded(false), existing)
    const existingById = new Map(existing.map((cell) => [cell.cellId, cell]))

    expect(plan.cells.map((cell) => cell.finalCellId)).toEqual(['cell-0', 'cell-1', 'cell-2'])
    expect(plan.cells.some((cell) => cell.changed)).toBe(false)
    expect(plan.retainedMissing).toEqual([])
    // No source event at all — a no-op re-import must not churn the chain.
    for (const cell of plan.cells) {
      expect(decideReviewCell(cell, existingById.get(cell.finalCellId))).toEqual({
        writeSource: false, reanchor: false, patchMetadata: false, textChanged: false, repinQuiet: false,
      })
    }
  })

  // The Biblica source is InDesign, where a unit key is derived from the
  // paragraph's position in the story. Inserting front matter slides EVERY key
  // down, so identity matching finds nothing and content matching is the only
  // thing standing between the publisher and a book of stranded translations.
  it('keeps every cell when inserted front matter shifts every IDML unit key', () => {
    const idmlKey = (position: number) =>
      `idml:Stories/Story_u100.xml:/idPkg:Story[1]/Story[1]/ParagraphStyleRange[${position}]:0`
    const idmlMetadata = (position: number, physicalOrder: number) => ({
      aquillaImport: {
        version: 1, profileId: 'builtin:idml', profileVersion: '1',
        unitKey: idmlKey(position), kind: 'paratext', displayLabel: null,
        physicalOrder, fidelity: 'content-only',
      },
    })
    const bodyText = BODY.map((unit) => unit.value)
    const existing: ExistingImportCell[] = bodyText.map((value, index) => ({
      cellId: `cell-${index}`, eventId: `event-${index}`, value, valueHtml: null,
      type: 'paragraph', canonicalRef: null, anchorCellId: index === 0 ? null : `cell-${index - 1}`,
      startMs: null, endMs: null, sequenceIndex: index, medium: null,
      metadata: idmlMetadata(index + 1, index),
    }))
    const incoming: ReconcileImportCell[] = [...FRONT_MATTER.map((unit) => unit.value), ...bodyText]
      .map((value, index) => ({
        id: `incoming-event-${index}`, cellId: `incoming-cell-${index}`, value, type: 'paragraph',
        anchorCellId: index === 0 ? null : `incoming-cell-${index - 1}`,
        sequenceIndex: index, metadata: idmlMetadata(index + 1, index),
      }))

    const plan = planImportReconciliation(incoming, existing)
    expect(plan.cells.map((cell) => cell.finalCellId))
      .toEqual(['incoming-cell-0', 'incoming-cell-1', 'incoming-cell-2', 'cell-0', 'cell-1', 'cell-2'])
    expect(plan.cells.map((cell) => cell.matchKind))
      .toEqual(['new', 'new', 'new', 'content-exact', 'content-ice', 'content-ice'])
    expect(plan.retainedMissing).toEqual([])
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

  it('populates cells.lane_id from seeded lanes on reconcile insert', async () => {
    const auth = await token()
    const { db } = await makeTestDb()
    const sourceLaneId = 'src00001'
    const targetLaneId = 'tgt00001'

    // lane_id is NOT NULL, so the lanes have to exist before the first cell
    // write. Reconcile still has to stamp the same ids on the rows it inserts.
    await db.prepare(
      `INSERT INTO lanes (id, project_id, role, name, lang_code, legacy_tag, position)
       VALUES (?, ?, 'source', ?, ?, NULL, 0)`,
    ).bind(sourceLaneId, PROJECT_ID, 'Source', 'en').run()
    await db.prepare(
      `INSERT INTO lanes (id, project_id, role, name, lang_code, legacy_tag, position)
       VALUES (?, ?, 'target', ?, ?, ?, 1)`,
    ).bind(targetLaneId, PROJECT_ID, 'French', 'fr', 'fr').run()

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
        }],
      }),
    })
    expect((await handleBulkImportRequest(initial, env(db)))?.status).toBe(200)

    const request = new Request('https://worker/import/reconcile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}` },
      body: JSON.stringify({
        projectId: PROJECT_ID,
        fileId: FILE_ID,
        file: {
          id: 'file-reimport-event', name: 'Genesis',
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
          id: 'target-imported-3', cellId: 'parser-3', parentId: 'source-new-3',
          value: 'Nouvelle traduction', targetLang: 'fr',
        }],
      }),
    })
    const response = await handleImportReconcileRequest(request, env(db))
    const responseBody = await response?.json() as Record<string, unknown>
    if (response?.status !== 200) throw new Error(JSON.stringify(responseBody))
    expect(responseBody).toMatchObject({ added: 1, importedTargets: 1 })

    const { results } = await db.prepare(
      `SELECT c.side, COALESCE(l.legacy_tag, '') AS target_lang, c.lane_id
         FROM cells c
         LEFT JOIN lanes l ON l.project_id = c.project_id AND l.id = c.lane_id
        WHERE c.project_id = ? AND c.file_id = ?`,
    ).bind(PROJECT_ID, FILE_ID).all<{ side: string; target_lang: string; lane_id: string | null }>()
    const source = results.filter((row) => row.side === 'source')
    const target = results.filter((row) => row.side === 'target' && row.target_lang === 'fr')
    expect(source).toHaveLength(2)
    expect(target).toHaveLength(1)
    for (const row of source) expect(row.lane_id).toBe(sourceLaneId)
    for (const row of target) expect(row.lane_id).toBe(targetLaneId)
  }, 120_000)

  it('reviews a changed source, parks a removed unit, and leaves a move validated', async () => {
    const auth = await token()
    const { db } = await makeTestDb()
    const targetLaneId = 'tgt00001'
    await db.prepare(
      `INSERT INTO lanes (id, project_id, role, name, lang_code, legacy_tag, position)
       VALUES (?, ?, 'target', 'French', 'fr', 'fr', 0)`,
    ).bind(targetLaneId, PROJECT_ID).run()

    const initial = await handleBulkImportRequest(new Request('https://worker/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}` },
      body: JSON.stringify({
        projectId: PROJECT_ID,
        fileId: FILE_ID,
        file: { id: 'file-genesis-event', name: 'Genesis', fileType: 'usfm', bookCode: 'GEN' },
        cells: [{
          id: 'source-old-1', cellId: 'durable-1', value: 'Old verse one', type: 'verse',
          canonicalRef: 'GEN 1:1', sequenceIndex: 0,
          metadata: importMetadata('scripture:GEN 1:1', 0),
        }, {
          id: 'source-old-2', cellId: 'durable-2', anchorCellId: 'durable-1',
          value: 'Verse two must stay', type: 'verse', canonicalRef: 'GEN 1:2', sequenceIndex: 1,
          metadata: importMetadata('scripture:GEN 1:2', 1),
        }, {
          id: 'source-move', cellId: 'durable-move', anchorCellId: 'durable-2',
          value: 'Neighbor sentence stays.', type: 'verse', canonicalRef: 'GEN 1:4', sequenceIndex: 2,
          metadata: importMetadata('scripture:GEN 1:4', 2),
        }],
        targets: [{
          id: 'target-old-1', cellId: 'durable-1', parentId: 'source-old-1',
          value: 'Traduction existante', targetLang: 'fr',
        }, {
          id: 'target-move', cellId: 'durable-move', parentId: 'source-move',
          value: 'Voisin inchangé', targetLang: 'fr',
        }],
      }),
    }), env(db))
    expect(initial?.status).toBe(200)
    await db.prepare(
      `UPDATE cells SET validated = 1
        WHERE project_id = ? AND file_id = ? AND side = 'target' AND cell_id IN ('durable-1', 'durable-move')`,
    ).bind(PROJECT_ID, FILE_ID).run()
    for (const [cellId, eventId] of [['durable-1', 'target-old-1'], ['durable-move', 'target-move']] as const) {
      await db.prepare(
        `INSERT INTO cell_validators (project_id, file_id, cell_id, lane_id, event_id, username, decided_ts)
         VALUES (?, ?, ?, ?, ?, 'alice', ?)`,
      ).bind(PROJECT_ID, FILE_ID, cellId, targetLaneId, eventId, Date.now()).run()
    }

    const review = await handleImportReconcileRequest(new Request('https://worker/import/reconcile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}` },
      body: JSON.stringify({
        projectId: PROJECT_ID,
        fileId: FILE_ID,
        reviewChangedSource: true,
        file: { id: 'file-review-event', name: 'Genesis', fileType: 'usfm', bookCode: 'GEN' },
        cells: [{
          id: 'source-new-1', cellId: 'parser-1', value: 'Updated verse one', type: 'verse',
          canonicalRef: 'GEN 1:1', sequenceIndex: 0,
          metadata: importMetadata('scripture:GEN 1:1', 0),
        }, {
          id: 'source-new-3', cellId: 'parser-3', anchorCellId: 'parser-1',
          value: 'New verse three', type: 'verse', canonicalRef: 'GEN 1:3', sequenceIndex: 1,
          metadata: importMetadata('scripture:GEN 1:3', 1),
        }, {
          id: 'source-move-again', cellId: 'parser-move', anchorCellId: 'parser-3',
          value: 'Neighbor sentence stays.', type: 'verse', canonicalRef: 'GEN 1:4', sequenceIndex: 2,
          metadata: importMetadata('scripture:GEN 1:4', 2),
        }],
        targets: [{
          id: 'target-should-not-land', cellId: 'parser-1', parentId: 'source-new-1',
          value: 'Must not overwrite', targetLang: 'fr',
        }],
      }),
    }), env(db))
    if (review?.status !== 200) throw new Error(await review?.text() ?? 'no response')

    const { results } = await db.prepare(
      `SELECT cell_id, side, value, event_id, source_event_id, validated, hidden_at, metadata
         FROM cells WHERE project_id = ? AND file_id = ?`,
    ).bind(PROJECT_ID, FILE_ID).all<{
      cell_id: string
      side: string
      value: string
      event_id: string
      source_event_id: string | null
      validated: number
      hidden_at: number | null
      metadata: unknown
    }>()
    const sourceOf = (id: string) => results.find((row) => row.side === 'source' && row.cell_id === id)
    const targetOf = (id: string) => results.find((row) => row.side === 'target' && row.cell_id === id)
    const changed = sourceOf('durable-1')
    const changedTarget = targetOf('durable-1')
    const aquilla = (row: { metadata: unknown } | undefined) => {
      const raw = typeof row?.metadata === 'string' ? JSON.parse(row.metadata) as unknown : row?.metadata
      const record = raw && typeof raw === 'object' ? raw as { aquillaImport?: { reviewLanes?: string[]; reimportHidden?: boolean } } : {}
      return record.aquillaImport ?? {}
    }
    expect(changed?.value).toBe('Updated verse one')
    expect(changedTarget).toMatchObject({
      value: 'Traduction existante',
      validated: 0,
      source_event_id: changed?.event_id,
    })
    expect(aquilla(changed).reviewLanes).toContain(targetLaneId)
    expect(await db.prepare(
      `SELECT COUNT(*)::int AS n FROM cell_validators
        WHERE project_id = ? AND file_id = ? AND cell_id = 'durable-1'`,
    ).bind(PROJECT_ID, FILE_ID).first<{ n: number }>()).toMatchObject({ n: 0 })
    expect(targetOf('parser-3')).toBeUndefined()

    const parked = sourceOf('durable-2')
    expect(parked?.hidden_at).not.toBeNull()
    expect(aquilla(parked).reimportHidden).toBe(true)

    const moved = sourceOf('durable-move')
    const movedTarget = targetOf('durable-move')
    expect(moved?.event_id).toBe('source-move')
    expect(movedTarget).toMatchObject({
      value: 'Voisin inchangé',
      validated: 1,
      source_event_id: 'source-move',
    })
    expect(aquilla(moved).reviewLanes).toBeUndefined()

    const stmts: Parameters<AquillaDb['batch']>[0] = []
    buildEventProjectionStmts(db, {
      id: 'validate-review',
      schemaVersion: 1,
      projectId: PROJECT_ID,
      fileId: FILE_ID,
      cellId: 'durable-1',
      parentId: null,
      kind: 'cell.validate',
      author: 'carol',
      payload: { editEventId: changedTarget?.event_id ?? '', targetLang: 'fr' },
      clientTs: Date.now(),
      serverTs: Date.now(),
    }, stmts, { validationCount: 1 })
    await db.batch(stmts)
    const cleared = await db.prepare(
      `SELECT metadata FROM cells
        WHERE project_id = ? AND file_id = ? AND cell_id = 'durable-1' AND side = 'source'`,
    ).bind(PROJECT_ID, FILE_ID).first<{ metadata: unknown }>()
    expect(aquilla(cleared ?? undefined).reviewLanes).toBeUndefined()

    const returned = await handleImportReconcileRequest(new Request('https://worker/import/reconcile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}` },
      body: JSON.stringify({
        projectId: PROJECT_ID,
        fileId: FILE_ID,
        reviewChangedSource: true,
        file: { id: 'file-review-again', name: 'Genesis', fileType: 'usfm' },
        cells: [{
          id: 'source-keep-1', cellId: 'keep-1', value: 'Updated verse one', type: 'verse',
          canonicalRef: 'GEN 1:1', sequenceIndex: 0,
          metadata: importMetadata('scripture:GEN 1:1', 0),
        }, {
          id: 'source-back-2', cellId: 'parser-2', anchorCellId: 'keep-1',
          value: 'Verse two must stay', type: 'verse', canonicalRef: 'GEN 1:2', sequenceIndex: 1,
          metadata: importMetadata('scripture:GEN 1:2', 1),
        }, {
          id: 'source-keep-3', cellId: 'keep-3', anchorCellId: 'parser-2',
          value: 'New verse three', type: 'verse', canonicalRef: 'GEN 1:3', sequenceIndex: 2,
          metadata: importMetadata('scripture:GEN 1:3', 1),
        }, {
          id: 'source-keep-move', cellId: 'keep-move', anchorCellId: 'keep-3',
          value: 'Neighbor sentence stays.', type: 'verse', canonicalRef: 'GEN 1:4', sequenceIndex: 3,
          metadata: importMetadata('scripture:GEN 1:4', 2),
        }],
      }),
    }), env(db))
    if (returned?.status !== 200) throw new Error(await returned?.text() ?? 'no response')
    const shown = await db.prepare(
      `SELECT hidden_at, metadata FROM cells
        WHERE project_id = ? AND file_id = ? AND cell_id = 'durable-2' AND side = 'source'`,
    ).bind(PROJECT_ID, FILE_ID).first<{ hidden_at: number | null; metadata: unknown }>()
    expect(shown?.hidden_at).toBeNull()
    expect(aquilla(shown ?? undefined).reimportHidden).toBeUndefined()
  }, 120_000)

  it('forks an updated copy and leaves the original file untouched', async () => {
    const auth = await token()
    const { db } = await makeTestDb()
    const initial = await handleBulkImportRequest(new Request('https://worker/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}` },
      body: JSON.stringify({
        projectId: PROJECT_ID,
        fileId: FILE_ID,
        file: { id: 'file-genesis-event', name: 'Genesis', fileType: 'usfm' },
        cells: [{
          id: 'source-old-1', cellId: 'durable-1', value: 'Old verse one', type: 'verse',
          canonicalRef: 'GEN 1:1', sequenceIndex: 0,
          metadata: importMetadata('scripture:GEN 1:1', 0),
        }],
        targets: [{
          id: 'target-old-1', cellId: 'durable-1', parentId: 'source-old-1',
          value: 'Traduction existante', targetLang: 'fr',
        }],
      }),
    }), env(db))
    expect(initial?.status).toBe(200)

    const copyId = 'file-copy'
    const copyAuth = await makeTestToken(SECRET, { projectId: PROJECT_ID, fileId: copyId, role: 500 })
    const fork = await handleImportReconcileRequest(new Request('https://worker/import/reconcile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${copyAuth}` },
      body: JSON.stringify({
        projectId: PROJECT_ID,
        fileId: copyId,
        sourceFileId: FILE_ID,
        fork: true,
        reviewChangedSource: true,
        file: { id: 'file-copy-event', name: 'Genesis (updated)', fileType: 'usfm' },
        cells: [{
          id: 'source-new-1', cellId: 'parser-1', value: 'Updated verse one', type: 'verse',
          canonicalRef: 'GEN 1:1', sequenceIndex: 0,
          metadata: importMetadata('scripture:GEN 1:1', 0),
        }],
      }),
    }), env(db))
    if (fork?.status !== 200) throw new Error(await fork?.text() ?? 'no response')

    const original = await db.prepare(
      `SELECT value, event_id FROM cells
        WHERE project_id = ? AND file_id = ? AND cell_id = 'durable-1' AND side = 'source'`,
    ).bind(PROJECT_ID, FILE_ID).first<{ value: string; event_id: string }>()
    expect(original).toMatchObject({ value: 'Old verse one', event_id: 'source-old-1' })
    const copy = await db.prepare(
      `SELECT value FROM cells
        WHERE project_id = ? AND file_id = ? AND cell_id = 'durable-1' AND side = 'source'`,
    ).bind(PROJECT_ID, copyId).first<{ value: string }>()
    expect(copy).toMatchObject({ value: 'Updated verse one' })
    const copyTarget = await db.prepare(
      `SELECT value FROM cells
        WHERE project_id = ? AND file_id = ? AND cell_id = 'durable-1' AND side = 'target'`,
    ).bind(PROJECT_ID, copyId).first<{ value: string }>()
    expect(copyTarget).toMatchObject({ value: 'Traduction existante' })
  }, 120_000)
})

// AQU-1882 — the sibling of AQU-1858's gate on POST /import. The route used to
// `await request.json()` before it looked at the token, so an unauthenticated
// caller could spend the isolate's shared ~128 MB on a body that was always
// going to be refused. These tests assert the refusal happens without the body
// stream ever being pulled.
describe('POST /import/reconcile — gated before the body is read (AQU-1882)', () => {
  /** A body stream that records whether anything was ever pulled from it. */
  function unreadableBody(): { body: ReadableStream<Uint8Array>; pulled: () => boolean } {
    let pulled = false
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled = true
        controller.enqueue(new TextEncoder().encode('{}'))
        controller.close()
      },
    }, new CountQueuingStrategy({ highWaterMark: 0 }))
    return { body, pulled: () => pulled }
  }

  function streamingRequest(
    body: ReadableStream<Uint8Array>,
    headers: Record<string, string>,
  ): Request {
    return new Request('https://worker/import/reconcile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
      // Node/workerd both require this for a streamed request body.
      duplex: 'half',
    } as RequestInit)
  }

  it('rejects a missing token with 401 without touching the body', async () => {
    const { db } = await makeTestDb()
    const { body, pulled } = unreadableBody()

    const res = await handleImportReconcileRequest(streamingRequest(body, {}), env(db))

    expect(res?.status).toBe(401)
    expect(pulled()).toBe(false)
  })

  it('rejects a too-low role with 403 without touching the body', async () => {
    const { db } = await makeTestDb()
    const contributor = await makeTestToken(SECRET, {
      projectId: PROJECT_ID,
      fileId: FILE_ID,
      role: 400, // contributor — below PROJECT_LEAD
    })
    const { body, pulled } = unreadableBody()

    const res = await handleImportReconcileRequest(
      streamingRequest(body, { Authorization: `Bearer ${contributor}` }),
      env(db),
    )

    expect(res?.status).toBe(403)
    expect(pulled()).toBe(false)
  })

  it('rejects an oversize Content-Length with 413 without touching the body', async () => {
    const { db } = await makeTestDb()
    const auth = await token()
    const { body, pulled } = unreadableBody()

    const res = await handleImportReconcileRequest(
      streamingRequest(body, {
        Authorization: `Bearer ${auth}`,
        'content-length': String(MAX_IMPORT_REQUEST_BODY_BYTES + 1),
      }),
      env(db),
    )

    expect(res?.status).toBe(413)
    expect(await res?.json()).toMatchObject({ maxBytes: MAX_IMPORT_REQUEST_BODY_BYTES })
    expect(pulled()).toBe(false)
  })

  it('reads a chunked body with no Content-Length under the same byte cap', async () => {
    const { db } = await makeTestDb()
    const auth = await token()
    // One chunk over the ceiling, streamed with no declared length: the header
    // check cannot catch it, so the streaming counter has to.
    const oversize = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(MAX_IMPORT_REQUEST_BODY_BYTES + 1))
        controller.close()
      },
    })

    const res = await handleImportReconcileRequest(
      streamingRequest(oversize, { Authorization: `Bearer ${auth}` }),
      env(db),
    )

    expect(res?.status).toBe(413)
    expect(await res?.json()).toMatchObject({ maxBytes: MAX_IMPORT_REQUEST_BODY_BYTES })
  })

  it('still rejects a token scoped to another file with 403, once the body names it', async () => {
    const { db } = await makeTestDb()
    const otherFile = await makeTestToken(SECRET, {
      projectId: PROJECT_ID,
      fileId: 'some-other-file',
      role: 500,
    })

    const res = await handleImportReconcileRequest(
      new Request('https://worker/import/reconcile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${otherFile}` },
        body: JSON.stringify({
          projectId: PROJECT_ID,
          fileId: FILE_ID,
          file: { id: 'scoped-file-event', name: 'Genesis', fileType: 'usfm', role: 'source', kind: 'usfm' },
          cells: [],
        }),
      }),
      env(db),
    )

    expect(res?.status).toBe(403)
    expect(await res?.text()).toBe('token scoped to different file')
  })
})

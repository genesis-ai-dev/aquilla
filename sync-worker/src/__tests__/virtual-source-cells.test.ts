// AQU-2459 Phase B: Pure virtual source cells end-to-end integration tests.
//
// Proves the full contract on real Postgres (PGlite) + R2 manifest store:
//   1. Virtual import writes ZERO `side = 'source'` rows into Postgres `cells`
//      while keeping `files.*_count` and `file_section_progress` (file/section/book)
//      accurate in JS.
//   2. `GET /cells` serves source cells from the R2 manifest with `sourceContentHash`,
//      paired cleanly with sparse Postgres `side = 'target'` rows.
//   3. `POST /events` accepts `target.cell.commit` pinned with `sourceEventId` +
//      `sourceContentHash` against virtual source cells (0 Postgres source rows),
//      updates counters/progress without zeroing them, and `GET /stale-source`
//      flags edits via contentHash and clears staleness automatically on revert.
//   4. Sparse manual source edit materializes ONLY the 1 edited cell and folds
//      back to 0 source rows on the next revision.
//   5. Search (`GET /search`), USFM export (`buildUsfmExportPlan`), by-ref
//      (`GET /cells/by-ref`), section detail (`GET /progress/sections/:key`),
//      and projection rebuild (`POST /admin/rebuild`) all work with 0 source rows.
//   6. Project-level batch artifact binding & batch publish endpoints handle
//      multi-book Paratext projects in 1 request each.

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('partyserver', () => ({
  getServerByName: vi.fn().mockResolvedValue({
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  }),
}))

import { handleRevisionsRequest } from '../events/revisions-route'
import { handleBulkImportRequest } from '../events/import-route'
import { handleCellsReadRequest } from '../events/cells-read-route'
import { handleEventsWriteRequest } from '../events/route'
import { handleStaleSourceRequest } from '../events/stale-source-route'
import { handleSearchReadRequest } from '../events/search-route'
import { handleCellsByRefRequest } from '../events/cells-by-ref-route'
import { handleProgressReadRequest } from '../events/progress-read-route'
import { handleRebuildProjectionRequest } from '../events/rebuild'
import { handleSourceUploadRequest } from '../events/source-upload-route'
import { handleImportReconcileRequest } from '../events/import-reconcile-route'
import { buildUsfmExportPlan } from '../events/usfm-export-plan'
import { makeTestDb } from './helpers/pg-test-db'
import { makeTestToken } from './helpers/auth'
import { resetVirtualSourceCacheForTests } from '../../../db/shared/virtual-source-store'
import { ASSIGNMENT_MEMBER_CELLS_SQL } from '../../../db/shared/assignment-member-cells-sql'

const SECRET = 'virtual-test-secret'
const ADMIN = 'virtual-admin-secret'
const PROJECT = 'p-virt'
const FILE_GEN = '018f6b2e-1c2a-7a2e-9a0e-5c0c7a1d2b11'
const FILE_EXO = '018f6b2e-1c2a-7a2e-9a0e-5c0c7a1d2b22'
const SHA_1 = '1'.repeat(64)
const SHA_2 = '2'.repeat(64)
const SHA_3 = '3'.repeat(64)

function makeStubBucket() {
  const store = new Map<string, ArrayBuffer>()
  const toBuffer = async (value: unknown): Promise<ArrayBuffer> => {
    if (value instanceof ReadableStream) return new Response(value).arrayBuffer()
    if (typeof value === 'string') return new TextEncoder().encode(value).buffer as ArrayBuffer
    if (value instanceof Uint8Array) return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer
    return value as ArrayBuffer
  }
  return {
    async put(key: string, value: unknown) {
      const body = await toBuffer(value)
      store.set(key, body)
      return { size: body.byteLength }
    },
    async get(key: string) {
      const obj = store.get(key)
      if (!obj) return null
      return { arrayBuffer: async () => obj, text: async () => new TextDecoder().decode(obj) }
    },
    async delete(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k)
    },
  } as unknown as R2Bucket
}

const verseUnit = (i: number, ref: string, text: string, type = 'verse') => ({
  unitKey: ref,
  positional: false,
  text,
  canonicalRef: ref,
  type,
  sequenceIndex: i,
})

beforeEach(() => {
  resetVirtualSourceCacheForTests()
})

describe('AQU-2459 Phase B: pure virtual source cells', () => {
  it('writes ZERO source rows to Postgres, serves cells/progress/search/export/by-ref, and handles hash-based staleness + revert + rebuild', async () => {
    const { db, rows } = await makeTestDb({
      projects: [{ id: PROJECT, name: 'Paratext Virtual', created_by: 1 }],
      files: [
        {
          id: FILE_GEN,
          project_id: PROJECT,
          name: 'Genesis',
          event_id: 'ev-file-gen',
          meta: JSON.stringify({ parserVersion: 'builtin:usfm@1', fileType: 'usfm' }),
        },
      ],
    })
    await db
      .prepare(`INSERT INTO project_members (project_id, user_id, role_level) VALUES (?, 1, 600)`)
      .bind(PROJECT)
      .run()
    const bucket = makeStubBucket()
    const token = await makeTestToken(SECRET, { projectId: PROJECT, fileId: FILE_GEN, userId: 1, role: 600, username: 'ryder' })
    const env = {
      SNAPSHOTS: bucket,
      AQUILLA_PG: db,
      SYNC_SECRET_KEY: SECRET,
      ADMIN_SECRET: ADMIN,
    }

    const postRev = (body: unknown) =>
      handleRevisionsRequest(
        new Request(`https://x/api/v1/projects/${PROJECT}/files/${FILE_GEN}/revisions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
        }),
        env,
      )

    // 1. Fresh virtual revision 1 (with finalizeFollows=true, followed by /import finalize)
    const rev1Res = await postRev({
      artifactSha256: SHA_1,
      stamp: 'usfm@1',
      virtual: true,
      finalizeFollows: true,
      units: [
        verseUnit(0, 'GEN 1:s1:1', 'The Creation', 'heading'),
        verseUnit(1, 'GEN 1:1', 'In the beginning God created the heavens and the earth.'),
        verseUnit(2, 'GEN 1:2', 'Now the earth was formless and empty.'),
        verseUnit(3, 'GEN 2:1', 'Thus the heavens and the earth were completed.'),
      ],
    })
    expect(rev1Res?.status).toBe(200)

    const finRes = await handleBulkImportRequest(
      new Request('https://x/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ projectId: PROJECT, fileId: FILE_GEN, cells: [], complete: true }),
      }),
      env,
    )
    expect(finRes?.status).toBe(200)

    // ZERO source rows in Postgres `cells`!
    const pgSourceCells = (await rows<{ side: string }>('cells')).filter((c) => c.side === 'source')
    expect(pgSourceCells).toHaveLength(0)

    // File counters & virtual flag set accurately from JS manifest calculation.
    const [fileRow] = await rows<{ source_virtual: boolean; head_revision_n: number; cell_count: number; structural_cell_count: number }>('files')
    expect(fileRow.source_virtual).toBe(true)
    expect(fileRow.head_revision_n).toBe(1)
    expect(fileRow.cell_count).toBe(4)
    expect(fileRow.structural_cell_count).toBe(1)

    // 2. GET /cells reads from manifest in order with sourceContentHash.
    const cellsRes = await handleCellsReadRequest(
      new Request(`https://x/api/v1/projects/${PROJECT}/files/${FILE_GEN}/cells?paired=1`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
      env,
    )
    expect(cellsRes?.status).toBe(200)
    const cellsBody = (await cellsRes!.json()) as {
      cells: Array<{ cellId: string; side: string; canonicalRef: string; value: string; eventId: string; sourceContentHash?: string }>
      total: number
    }
    expect(cellsBody.total).toBe(4)
    expect(cellsBody.cells.map((c) => c.canonicalRef)).toEqual(['GEN 1:s1:1', 'GEN 1:1', 'GEN 1:2', 'GEN 2:1'])
    const v1 = cellsBody.cells[1]
    const v2 = cellsBody.cells[2]
    const v3 = cellsBody.cells[3]
    expect(v1.sourceContentHash).toBeTruthy()
    expect(v2.sourceContentHash).toBeTruthy()

    // 3. Commit targets pinned by sourceEventId + sourceContentHash via POST /events.
    const commitRes = await handleEventsWriteRequest(
      new Request('https://x/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          events: [
            {
              id: '018f6b2e-0000-7000-8000-000000000001',
              schemaVersion: 1,
              projectId: PROJECT,
              fileId: FILE_GEN,
              cellId: v1.cellId,
              parentId: null,
              kind: 'target.cell.commit',
              payload: {
                value: 'Au commencement Dieu créa les cieux et la terre.',
                sourceEventId: v1.eventId,
                sourceContentHash: v1.sourceContentHash,
                targetLang: '',
              },
              clientTs: Date.now(),
            },
            {
              id: '018f6b2e-0000-7000-8000-000000000002',
              schemaVersion: 1,
              projectId: PROJECT,
              fileId: FILE_GEN,
              cellId: v2.cellId,
              parentId: null,
              kind: 'target.cell.commit',
              payload: {
                value: 'La terre était informe et vide.',
                sourceEventId: v2.eventId,
                sourceContentHash: v2.sourceContentHash,
                targetLang: '',
              },
              clientTs: Date.now(),
            },
          ],
        }),
      }),
      env,
    )
    expect(commitRes?.status).toBe(200)
    const commitBody = (await commitRes!.json()) as { accepted: string[]; rejected: unknown[] }
    expect(commitBody.rejected).toEqual([])
    expect(commitBody.accepted).toHaveLength(2)

    // Counters updated cleanly via virtual-progress without zeroing cell_count!
    const [fileAfterCommit] = await rows<{ cell_count: number; filled_count: number }>('files')
    expect(fileAfterCommit.cell_count).toBe(4)
    expect(fileAfterCommit.filled_count).toBe(2)

    // Still ZERO source rows in Postgres!
    expect((await rows<{ side: string }>('cells')).filter((c) => c.side === 'source')).toHaveLength(0)

    // 4. USFM export, Search, By-Ref, and Section Progress Detail all work on virtual file!
    const exportPlan = await buildUsfmExportPlan(db, PROJECT, FILE_GEN, '', {}, bucket)
    expect(exportPlan.overrides.get('GEN 1:1')).toBe('Au commencement Dieu créa les cieux et la terre.')

    const searchRes = await handleSearchReadRequest(
      new Request(`https://x/api/v1/projects/${PROJECT}/search?q=formless`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
      env,
    )
    expect(searchRes?.status).toBe(200)
    const searchBody = (await searchRes!.json()) as { results: Array<{ cellId: string; side: string; pairedValue: string | null }>; total: number }
    expect(searchBody.total).toBe(1)
    expect(searchBody.results[0]).toMatchObject({
      cellId: v2.cellId,
      side: 'source',
      pairedValue: 'La terre était informe et vide.',
    })

    const byRefRes = await handleCellsByRefRequest(
      new Request(`https://x/api/v1/projects/${PROJECT}/cells/by-ref?files=${FILE_GEN}&refs=${encodeURIComponent('GEN 1:1')}`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
      env,
    )
    expect(byRefRes?.status).toBe(200)
    const byRefBody = (await byRefRes!.json()) as { cells: Array<{ side: string; canonicalRef: string }> }
    expect(byRefBody.cells.some((c) => c.side === 'source' && c.canonicalRef === 'GEN 1:1')).toBe(true)

    const sectionRes = await handleProgressReadRequest(
      new Request(`https://x/api/v1/projects/${PROJECT}/files/${FILE_GEN}/progress/sections/${encodeURIComponent('GEN 1')}`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
      env,
    )
    expect(sectionRes?.status).toBe(200)
    const sectionBody = (await sectionRes!.json()) as { verses: Array<{ cellId: string; filled: boolean }> }
    expect(sectionBody.verses.length).toBeGreaterThanOrEqual(2)
    expect(sectionBody.verses.find((v) => v.cellId === v1.cellId)?.filled).toBe(true)

    // 5. Revision 2 edits GEN 1:2, leaves GEN 1:1 unchanged, deletes GEN 2:1.
    const rev2Res = await postRev({
      artifactSha256: SHA_2,
      stamp: 'usfm@1',
      units: [
        verseUnit(0, 'GEN 1:s1:1', 'The Creation', 'heading'),
        verseUnit(1, 'GEN 1:1', 'In the beginning God created the heavens and the earth.'),
        verseUnit(2, 'GEN 1:2', 'Now the earth was completely formless and void.'),
      ],
    })
    expect(rev2Res?.status).toBe(200)
    expect((await rows<{ side: string }>('cells')).filter((c) => c.side === 'source')).toHaveLength(0)

    const stale2Res = await handleStaleSourceRequest(
      new Request(`https://x/api/v1/projects/${PROJECT}/files/${FILE_GEN}/stale-source`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
      env,
    )
    const stale2 = (await stale2Res!.json()) as { staleCellIds: string[]; tombstonedCellIds: string[] }
    expect(stale2.staleCellIds).toEqual([v2.cellId])
    expect(stale2.tombstonedCellIds).toEqual([v3.cellId])

    // 6. Revision 3 REVERTS GEN 1:2 back to original text → automatically fresh via contentHash!
    const rev3Res = await postRev({
      artifactSha256: SHA_3,
      stamp: 'usfm@1',
      units: [
        verseUnit(0, 'GEN 1:s1:1', 'The Creation', 'heading'),
        verseUnit(1, 'GEN 1:1', 'In the beginning God created the heavens and the earth.'),
        verseUnit(2, 'GEN 1:2', 'Now the earth was formless and empty.'),
      ],
    })
    expect(rev3Res?.status).toBe(200)

    const stale3Res = await handleStaleSourceRequest(
      new Request(`https://x/api/v1/projects/${PROJECT}/files/${FILE_GEN}/stale-source`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
      env,
    )
    const stale3 = (await stale3Res!.json()) as { staleCellIds: string[] }
    expect(stale3.staleCellIds).toEqual([])

    // 7. Manual sparse source edit materializes ONLY 1 row in Postgres, visible on GET /cells.
    const editSrcRes = await handleEventsWriteRequest(
      new Request('https://x/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          events: [
            {
              id: '018f6b2e-0000-7000-8000-000000000009',
              schemaVersion: 1,
              projectId: PROJECT,
              fileId: FILE_GEN,
              cellId: v1.cellId,
              parentId: v1.eventId,
              kind: 'source.cell.commit',
              payload: { value: 'In the very beginning God created the heavens and the earth.' },
              clientTs: Date.now(),
            },
          ],
        }),
      }),
      env,
    )
    expect(editSrcRes?.status).toBe(200)
    expect((await rows<{ side: string }>('cells')).filter((c) => c.side === 'source')).toHaveLength(1)

    const cellsAfterEdit = (await (
      await handleCellsReadRequest(
        new Request(`https://x/api/v1/projects/${PROJECT}/files/${FILE_GEN}/cells?side=source`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
        env,
      )
    )!.json()) as { cells: Array<{ cellId: string; value: string }> }
    expect(cellsAfterEdit.cells.find((c) => c.cellId === v1.cellId)?.value).toBe(
      'In the very beginning God created the heavens and the earth.',
    )

    // 8. Projection rebuild preserves virtual mode with 0 source rows for revisioned state!
    const rebuildRes = await handleRebuildProjectionRequest(
      new Request(`https://x/admin/projects/${PROJECT}/rebuild-projection`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${ADMIN}` },
      }),
      env,
    )
    expect(rebuildRes?.status).toBe(200)
    const [fileAfterRebuild] = await rows<{ source_virtual: boolean; cell_count: number; filled_count: number }>('files')
    expect(fileAfterRebuild.source_virtual).toBe(true)
    expect(fileAfterRebuild.cell_count).toBe(3)
    expect(fileAfterRebuild.filled_count).toBe(2)
  })

  it('batch artifact binding and batch publish handle multi-book Paratext projects in one request each', async () => {
    const { db, rows } = await makeTestDb({
      projects: [{ id: PROJECT, name: 'Paratext Batch', created_by: 1 }],
      files: [
        { id: FILE_GEN, project_id: PROJECT, name: 'Genesis', event_id: 'ev-1', deleted_at: 1000 },
        { id: FILE_EXO, project_id: PROJECT, name: 'Exodus', event_id: 'ev-2', deleted_at: 1000 },
      ],
    })
    const artifactId = '018f6b2e-1c2a-7a2e-9a0e-5c0c7a1d2b99'
    await db
      .prepare(
        `INSERT INTO artifacts (id, project_id, uploaded_by_user_id, name, size_bytes, sha256, r2_key, file_id, kind)
         VALUES (?::uuid, ?, '1', 'paratext.zip', 128, ?, 'k', ?, 'source')`,
      )
      .bind(artifactId, PROJECT, SHA_1, FILE_GEN)
      .run()

    const bucket = makeStubBucket()
    const token = await makeTestToken(SECRET, { projectId: PROJECT, fileId: FILE_GEN, role: 500, username: 'ryder' })
    const env = { SNAPSHOTS: bucket, AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET }

    // 1. Batch bind both books in ONE request.
    const bindRes = await handleSourceUploadRequest(
      new Request(`https://x/api/v1/projects/${PROJECT}/source-bindings/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          artifactId,
          bindingRole: 'support',
          profileId: 'builtin:paratext-project',
          profileVersion: '1',
          fidelity: 'preserved-only',
          bindings: [
            { fileId: FILE_GEN, memberPath: '01GEN.SFM' },
            { fileId: FILE_EXO, memberPath: '02EXO.SFM' },
          ],
        }),
      }),
      env,
    )
    expect(bindRes?.status).toBe(200)
    const bindings = await rows<{ file_id: string; member_path: string }>('artifact_bindings')
    expect(bindings.map((b) => [b.file_id, b.member_path]).sort()).toEqual([
      [FILE_GEN, '01GEN.SFM'],
      [FILE_EXO, '02EXO.SFM'],
    ])

    // 2. Batch publish both books in ONE request.
    const pubRes = await handleBulkImportRequest(
      new Request(`https://x/api/v1/projects/${PROJECT}/import/publish-batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          files: [
            { fileId: FILE_GEN, publishEventId: '018f6b2e-0000-7000-8000-0000000000a1' },
            { fileId: FILE_EXO, publishEventId: '018f6b2e-0000-7000-8000-0000000000a2' },
          ],
        }),
      }),
      env,
    )
    expect(pubRes?.status).toBe(200)
    const filesAfter = await rows<{ id: string; deleted_at: number | null }>('files')
    expect(filesAfter.every((f) => f.deleted_at === null)).toBe(true)
  })

  it('supports bilingual virtual imports (0 source rows + hash-pinned targets), virtual assignments, tombstones, and reconcile', async () => {
    const { db, rows } = await makeTestDb({
      projects: [{ id: PROJECT, name: 'Bilingual Virtual', created_by: 1 }],
      files: [
        {
          id: FILE_GEN,
          project_id: PROJECT,
          name: 'Genesis',
          event_id: 'ev-file-gen',
          meta: JSON.stringify({ parserVersion: 'builtin:paratext-bilingual@1', fileType: 'usfm' }),
        },
      ],
    })
    await db
      .prepare(`INSERT INTO project_members (project_id, user_id, role_level) VALUES (?, 1, 600)`)
      .bind(PROJECT)
      .run()
    await db
      .prepare(`INSERT INTO project_settings (project_id, settings) VALUES (?, ?)`)
      .bind(PROJECT, JSON.stringify({ cellEditingFloor: 'project_lead' }))
      .run()
    const bucket = makeStubBucket()
    const token = await makeTestToken(SECRET, { projectId: PROJECT, fileId: FILE_GEN, userId: 1, role: 600, username: 'ryder' })
    const env = { SNAPSHOTS: bucket, AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET }

    // 1. Fresh bilingual virtual import: rev 1 preserves caller cellIds, then target-only /import chunk pins hashes.
    const rev1Res = await handleRevisionsRequest(
      new Request(`https://x/api/v1/projects/${PROJECT}/files/${FILE_GEN}/revisions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          artifactSha256: SHA_1,
          stamp: 'builtin:paratext-bilingual@1',
          virtual: true,
          finalizeFollows: true,
          units: [
            { ...verseUnit(0, 'GEN 1:1', 'In the beginning God created the heavens.'), cellId: 'cell-gen-1-1' },
            { ...verseUnit(1, 'GEN 1:2', 'Now the earth was formless.'), cellId: 'cell-gen-1-2' },
            { ...verseUnit(2, 'GEN 2:1', 'Thus the heavens were finished.'), cellId: 'cell-gen-2-1' },
          ],
        }),
      }),
      env,
    )
    expect(rev1Res?.status).toBe(200)
    const rev1Body = (await rev1Res!.json()) as { eventId: string; revisionN: number }
    expect(rev1Body.revisionN).toBe(1)
    expect(rev1Body.eventId).toBeTruthy()

    const targetChunkRes = await handleBulkImportRequest(
      new Request('https://x/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          projectId: PROJECT,
          fileId: FILE_GEN,
          cells: [],
          targets: [
            {
              id: '018f6b2e-0000-7000-8000-0000000000b1',
              cellId: 'cell-gen-1-1',
              parentId: rev1Body.eventId,
              value: 'Au commencement Dieu créa les cieux.',
            },
            {
              id: '018f6b2e-0000-7000-8000-0000000000b2',
              cellId: 'cell-gen-1-2',
              parentId: rev1Body.eventId,
              value: 'La terre était informe.',
            },
          ],
        }),
      }),
      env,
    )
    expect(targetChunkRes?.status).toBe(200)

    const finRes = await handleBulkImportRequest(
      new Request('https://x/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ projectId: PROJECT, fileId: FILE_GEN, cells: [], complete: true }),
      }),
      env,
    )
    expect(finRes?.status).toBe(200)

    // 0 Postgres source rows, 2 target rows with source_content_hash stamped!
    const allPgCells = await rows<{ side: string; cell_id: string; source_content_hash: string | null }>('cells')
    expect(allPgCells.filter((c) => c.side === 'source')).toHaveLength(0)
    const targetRows = allPgCells.filter((c) => c.side === 'target')
    expect(targetRows).toHaveLength(2)
    expect(targetRows.every((r) => typeof r.source_content_hash === 'string' && r.source_content_hash.length > 0)).toBe(true)

    // 2. Virtual assignment (chapter-scoped on GEN 1) resolves into assignment_cells & assignment_member_cells!
    const assignRes = await handleEventsWriteRequest(
      new Request('https://x/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          events: [
            {
              id: '018f6b2e-0000-7000-8000-0000000000c1',
              schemaVersion: 1,
              projectId: PROJECT,
              fileId: FILE_GEN,
              cellId: null,
              parentId: null,
              kind: 'assignment.create',
              payload: {
                assignmentId: 'assign-gen-1',
                assigneeUserId: 1,
                scopeKind: 'chapter',
                scopeLabel: 'GEN 1',
                scope: [{ fileId: FILE_GEN, chapter: 'GEN 1' }],
              },
              clientTs: Date.now(),
            },
          ],
        }),
      }),
      env,
    )
    expect(assignRes?.status).toBe(200)
    const assignBody = (await assignRes!.json()) as { accepted: string[]; rejected: unknown[] }
    expect(assignBody.rejected).toEqual([])
    expect(assignBody.accepted).toHaveLength(1)
    const memberCells = await db
      .prepare(`SELECT cell_id, canonical_ref FROM ${ASSIGNMENT_MEMBER_CELLS_SQL} ac WHERE assignment_id = ? ORDER BY cell_id`)
      .bind('assign-gen-1')
      .all<{ cell_id: string; canonical_ref: string }>()
    expect(memberCells.results.map((r) => r.cell_id)).toEqual(['cell-gen-1-1', 'cell-gen-1-2'])

    // 3. Virtual source.cell.delete writes a tombstoned sparse overlay (does NOT resurrect from R2 manifest)
    //    and hides the tombstoned cell from both GET /cells and assignment_member_cells!
    const delRes = await handleEventsWriteRequest(
      new Request('https://x/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          events: [
            {
              id: '018f6b2e-0000-7000-8000-0000000000d1',
              schemaVersion: 1,
              projectId: PROJECT,
              fileId: FILE_GEN,
              cellId: 'cell-gen-1-2',
              parentId: rev1Body.eventId,
              kind: 'source.cell.delete',
              payload: {},
              clientTs: Date.now(),
            },
          ],
        }),
      }),
      env,
    )
    expect(delRes?.status).toBe(200)
    const cellsAfterDelete = (await (
      await handleCellsReadRequest(
        new Request(`https://x/api/v1/projects/${PROJECT}/files/${FILE_GEN}/cells?side=source`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
        env,
      )
    )!.json()) as { cells: Array<{ cellId: string }> }
    expect(cellsAfterDelete.cells.map((c) => c.cellId)).toEqual(['cell-gen-1-1', 'cell-gen-2-1'])

    const memberCellsAfterDelete = await db
      .prepare(`SELECT cell_id FROM ${ASSIGNMENT_MEMBER_CELLS_SQL} ac WHERE assignment_id = ? ORDER BY cell_id`)
      .bind('assign-gen-1')
      .all<{ cell_id: string }>()
    expect(memberCellsAfterDelete.results.map((r) => r.cell_id)).toEqual(['cell-gen-1-1'])

    // 4. Reconcile on a virtual file (`reviewChangedSource: true`) reads virtual rows, commits changes cleanly.
    const reconcileRes = await handleImportReconcileRequest(
      new Request('https://x/import/reconcile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          projectId: PROJECT,
          fileId: FILE_GEN,
          file: { id: '018f6b2e-0000-7000-8000-0000000000e1', name: 'Genesis', fileType: 'usfm' },
          reviewChangedSource: true,
          cells: [
            {
              id: '018f6b2e-0000-7000-8000-0000000000e2',
              cellId: 'cell-gen-1-1',
              anchorCellId: null,
              value: 'In the very beginning God created the heavens.',
              canonicalRef: 'GEN 1:1',
              type: 'verse',
              sequenceIndex: 0,
              metadata: { aquillaImport: { unitKey: 'GEN 1:1' } },
            },
            {
              id: '018f6b2e-0000-7000-8000-0000000000e3',
              cellId: 'cell-gen-2-1',
              anchorCellId: 'cell-gen-1-1',
              value: 'Thus the heavens were finished.',
              canonicalRef: 'GEN 2:1',
              type: 'verse',
              sequenceIndex: 1,
              metadata: { aquillaImport: { unitKey: 'GEN 2:1' } },
            },
          ],
          clientTs: Date.now(),
        }),
      }),
      env,
    )
    expect(reconcileRes?.status).toBe(200)
    const reconcileBody = (await reconcileRes!.json()) as { matched: number; changed: number; exact: number; ice: number }
    expect(reconcileBody.matched).toBe(2)
    expect(reconcileBody.exact + reconcileBody.ice).toBe(1)
    const cellsAfterReconcile = (await (
      await handleCellsReadRequest(
        new Request(`https://x/api/v1/projects/${PROJECT}/files/${FILE_GEN}/cells?side=source`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
        env,
      )
    )!.json()) as { cells: Array<{ cellId: string; value: string }> }
    expect(cellsAfterReconcile.cells.find((c) => c.cellId === 'cell-gen-1-1')?.value).toBe(
      'In the very beginning God created the heavens.',
    )
    expect(cellsAfterReconcile.cells.find((c) => c.cellId === 'cell-gen-2-1')?.value).toBe(
      'Thus the heavens were finished.',
    )
  })
})

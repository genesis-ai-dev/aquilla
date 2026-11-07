// POST /api/v1/projects/:p/files/:f/revisions (AQU-2459)
//
// Why these tests: a revision must be ONE event (not N), must keep cell ids
// across an insertion and an edit, must leave the AD-9 pin valid on unchanged
// cells, and must adopt a legacy file without changing a single id.

import { describe, expect, it } from 'vitest'
import { handleRevisionsRequest, revisionEventId, ADOPTED_STAMP } from '../events/revisions-route'
import { handleBulkImportRequest } from '../events/import-route'
import { handleStaleSourceRequest } from '../events/stale-source-route'
import { handleRebuildProjectionRequest } from '../events/rebuild'
import { makeTestDb } from './helpers/pg-test-db'
import { makeTestToken } from './helpers/auth'
import { revisionCellId } from '../../../db/shared/file-revision'

const SECRET = 'test-secret'
const PROJECT = 'p1'
const FILE = '018f6b2e-1c2a-7a2e-9a0e-5c0c7a1d2b47'
const SHA_A = 'a'.repeat(64)
const SHA_B = 'b'.repeat(64)
const SHA_C = 'c'.repeat(64)

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
    _allKeys() {
      return Array.from(store.keys())
    },
    _json(key: string) {
      const obj = store.get(key)
      return obj ? (JSON.parse(new TextDecoder().decode(obj)) as Record<string, unknown>) : null
    },
  }
}

const para = (i: number, text: string) => ({ unitKey: `docx:p[${i}]`, positional: true, text, sequenceIndex: i })

async function setup() {
  const { db, rows } = await makeTestDb({
    projects: [{ id: PROJECT, name: 'P', created_by: 1 }],
    files: [{ id: FILE, project_id: PROJECT, name: 'doc.docx', event_id: 'ev-file', meta: JSON.stringify({ parserVersion: 'builtin:docx@1' }) }],
  })
  const token = await makeTestToken(SECRET, { projectId: PROJECT, fileId: FILE, role: 500 })
  const bucket = makeStubBucket()
  const env = { SNAPSHOTS: bucket, AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET } as unknown as Parameters<typeof handleRevisionsRequest>[1]
  const post = (body: unknown, overrides: { token?: string } = {}) =>
    handleRevisionsRequest(
      new Request(`https://x/api/v1/projects/${PROJECT}/files/${FILE}/revisions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${overrides.token ?? token}` },
        body: JSON.stringify(body),
      }),
      env,
    )
  const sourceCells = async () =>
    (await rows<{ cell_id: string; value: string; event_id: string; anchor_cell_id: string | null; tombstoned_at: number | null; side: string }>('cells'))
      .filter((c) => c.side === 'source')
  return { db, rows, token, bucket, env, post, sourceCells }
}

describe('POST /files/:f/revisions', () => {
  it('refuses a caller below project lead and a malformed body', async () => {
    const { post } = await setup()
    const low = await makeTestToken(SECRET, { projectId: PROJECT, fileId: FILE, role: 400 })
    expect((await post({ artifactSha256: SHA_A, stamp: 'docx@1', units: [] }, { token: low }))?.status).toBe(403)
    expect((await post({ artifactSha256: 'nope', stamp: 'docx@1', units: [] }))?.status).toBe(400)
    expect((await post({ artifactSha256: SHA_A, stamp: 'docx@1', units: [{ unitKey: 'k' }] }))?.status).toBe(400)
  })

  it('revision 1 of a fresh file: one event, deterministic ids, cells in order, manifest in R2', async () => {
    const { post, rows, bucket, sourceCells } = await setup()
    const res = await post({ artifactSha256: SHA_A, stamp: 'docx@1', units: [para(0, 'One'), para(1, 'Two'), para(2, 'Three')] })
    expect(res?.status).toBe(200)
    const body = (await res!.json()) as { revisionN: number; eventId: string; adopted: boolean; counts: Record<string, number> }
    expect(body.revisionN).toBe(1)
    expect(body.adopted).toBe(false)
    expect(body.counts).toEqual({ equal: 0, changed: 0, moved: 0, inserted: 3, deleted: 0 })
    expect(body.eventId).toBe(revisionEventId(FILE, 1, SHA_A, 'docx@1'))

    const events = await rows<{ kind: string; id: string }>('events')
    expect(events.map((e) => e.kind)).toEqual(['file.revision'])

    const cells = await sourceCells()
    expect(cells).toHaveLength(3)
    const byId = new Map(cells.map((c) => [c.cell_id, c]))
    const id0 = revisionCellId(FILE, 1, 'docx:p[0]')
    const id1 = revisionCellId(FILE, 1, 'docx:p[1]')
    expect(byId.get(id0)?.value).toBe('One')
    expect(byId.get(id1)?.anchor_cell_id).toBe(id0)
    expect(byId.get(id0)?.event_id).toBe(body.eventId)

    const revs = await rows<{ revision_n: number; manifest_r2_key: string; unit_count: number }>('file_revisions')
    expect(revs).toHaveLength(1)
    expect(revs[0].unit_count).toBe(3)
    const manifest = bucket._json(revs[0].manifest_r2_key) as { units: Array<{ cellId: string; eventId: string }> }
    expect(manifest.units.map((u) => u.cellId)).toEqual([id0, id1, revisionCellId(FILE, 1, 'docx:p[2]')])
    const files = await rows<{ head_revision_n: number | null; cell_count: number }>('files')
    expect(files[0].head_revision_n).toBe(1)
    expect(files[0].cell_count).toBe(3)
  })

  it('the same artifact + stamp again is a no-op', async () => {
    const { post, rows } = await setup()
    await post({ artifactSha256: SHA_A, stamp: 'docx@1', units: [para(0, 'One')] })
    const res = await post({ artifactSha256: SHA_A, stamp: 'docx@1', units: [para(0, 'One')] })
    expect(await res!.json()).toEqual({ noop: true, revisionN: 1 })
    expect((await rows('events')).length).toBe(1)
  })

  it('revision 2: an insert shifts no ids, an edit keeps its id and takes the new event, a delete tombstones', async () => {
    const { post, rows, sourceCells } = await setup()
    const first = (await (await post({
      artifactSha256: SHA_A,
      stamp: 'docx@1',
      units: [para(0, 'Chapter one'), para(1, 'The quick brown fox jumps over the lazy dog.'), para(2, 'A second paragraph about weather.'), para(3, 'The end.')],
    }))!.json()) as { eventId: string }
    const before = new Map((await sourceCells()).map((c) => [c.value, c]))

    const res = await post({
      artifactSha256: SHA_B,
      stamp: 'docx@1',
      origin: 'reimport',
      units: [
        para(0, 'Chapter one'),
        para(1, 'Brand new paragraph.'),
        para(2, 'The quick brown fox jumps over the sleepy dog.'),
        para(3, 'The end.'),
      ],
    })
    const body = (await res!.json()) as { revisionN: number; eventId: string; counts: Record<string, number> }
    expect(body.revisionN).toBe(2)
    expect(body.counts).toEqual({ equal: 2, changed: 1, moved: 0, inserted: 1, deleted: 1 })
    expect((await rows<{ kind: string }>('events')).map((e) => e.kind)).toEqual(['file.revision', 'file.revision'])

    const after = await sourceCells()
    const live = after.filter((c) => c.tombstoned_at == null)
    expect(live).toHaveLength(4)
    const byValue = new Map(live.map((c) => [c.value, c]))
    // Unchanged cells: same id, same event id (the AD-9 pin stays valid).
    expect(byValue.get('Chapter one')?.cell_id).toBe(before.get('Chapter one')?.cell_id)
    expect(byValue.get('Chapter one')?.event_id).toBe(first.eventId)
    expect(byValue.get('The end.')?.cell_id).toBe(before.get('The end.')?.cell_id)
    // Edited cell: same id, new event id.
    const fox = byValue.get('The quick brown fox jumps over the sleepy dog.')!
    expect(fox.cell_id).toBe(before.get('The quick brown fox jumps over the lazy dog.')?.cell_id)
    expect(fox.event_id).toBe(body.eventId)
    // Inserted cell: a revision-2 id, anchored after "Chapter one".
    const inserted = byValue.get('Brand new paragraph.')!
    expect(inserted.cell_id).toBe(revisionCellId(FILE, 2, 'docx:p[1]'))
    expect(inserted.anchor_cell_id).toBe(byValue.get('Chapter one')?.cell_id)
    expect(fox.anchor_cell_id).toBe(inserted.cell_id)
    // Deleted cell: tombstoned, still present.
    const gone = after.find((c) => c.value === 'A second paragraph about weather.')
    expect(gone?.tombstoned_at).not.toBeNull()
    expect((await rows<{ cell_count: number }>('files'))[0].cell_count).toBe(4)
  })

  it('a target pinned to revision 1 reads stale only on the edited cell', async () => {
    const { post, db, token, sourceCells } = await setup()
    await post({ artifactSha256: SHA_A, stamp: 'docx@1', units: [para(0, 'Alpha text here'), para(1, 'Beta text here')] })
    const cells = await sourceCells()
    const alpha = cells.find((c) => c.value === 'Alpha text here')!
    const beta = cells.find((c) => c.value === 'Beta text here')!
    // Translate both, pinned to the revision-1 source head.
    for (const c of [alpha, beta]) {
      await db
        .prepare(
          `INSERT INTO cells (project_id, file_id, cell_id, side, value, event_id, source_event_id, lane_id, validated, word_count, content_hash, last_editor, last_edit_at)
           SELECT ?, ?, ?, 'target', ?, ?, ?, (SELECT id FROM lanes WHERE project_id = ? AND role = 'target' LIMIT 1), 0, 1, 'h', 'alice', 1`,
        )
        .bind(PROJECT, FILE, c.cell_id, `tr-${c.value}`, `tgt-${c.cell_id}`, c.event_id, PROJECT)
        .run()
    }
    await post({ artifactSha256: SHA_B, stamp: 'docx@1', units: [para(0, 'Alpha text here'), para(1, 'Beta text here, edited')] })
    const res = await handleStaleSourceRequest(
      new Request(`https://x/api/v1/projects/${PROJECT}/files/${FILE}/stale-source`, { headers: { Authorization: `Bearer ${token}` } }),
      { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET } as never,
    )
    expect(res?.status).toBe(200)
    const stale = (await res!.json()) as { staleCellIds?: string[]; cellIds?: string[] }
    const ids = stale.staleCellIds ?? stale.cellIds ?? []
    expect(ids).toContain(beta.cell_id)
    expect(ids).not.toContain(alpha.cell_id)
  })

  it('adopts a materialized file: revision 1 keeps every existing id, then aligns the new parse as revision 2', async () => {
    const { post, rows, env, token, sourceCells } = await setup()
    // Legacy import path: N source.cell.create events with client-minted ids.
    const legacy = ['c-aaa', 'c-bbb', 'c-ccc']
    const importRes = await handleBulkImportRequest(
      new Request('https://x/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          projectId: PROJECT,
          fileId: FILE,
          cells: legacy.map((cellId, i) => ({
            id: `ev-${cellId}`,
            cellId,
            anchorCellId: i === 0 ? null : legacy[i - 1],
            value: ['First legacy', 'Second legacy', 'Third legacy'][i],
            sequenceIndex: i,
            metadata: { aquillaImport: { unitKey: `docx:p[${i}]` } },
          })),
        }),
      }),
      env as never,
    )
    expect(importRes?.status).toBe(200)
    expect((await sourceCells()).map((c) => c.cell_id).sort()).toEqual([...legacy].sort())

    const res = await post({
      artifactSha256: SHA_C,
      stamp: 'builtin:docx@1',
      origin: 'reimport',
      units: [para(0, 'First legacy'), para(1, 'Second legacy, now edited'), para(2, 'Third legacy'), para(3, 'Fourth, new')],
    })
    const body = (await res!.json()) as { revisionN: number; adopted: boolean; counts: Record<string, number> }
    expect(body.adopted).toBe(true)
    expect(body.revisionN).toBe(2)
    expect(body.counts).toEqual({ equal: 2, changed: 1, moved: 0, inserted: 1, deleted: 0 })

    const revs = await rows<{ revision_n: number; origin: string; filter_stamp: string; unit_count: number }>('file_revisions')
    expect(revs.map((r) => [r.revision_n, r.origin, r.filter_stamp, r.unit_count])).toEqual([
      [1, 'adopt', 'builtin:docx@1', 3],
      [2, 'reimport', 'builtin:docx@1', 4],
    ])
    const live = (await sourceCells()).filter((c) => c.tombstoned_at == null)
    const byValue = new Map(live.map((c) => [c.value, c.cell_id]))
    expect(byValue.get('First legacy')).toBe('c-aaa')
    expect(byValue.get('Second legacy, now edited')).toBe('c-bbb')
    expect(byValue.get('Third legacy')).toBe('c-ccc')
    expect(byValue.get('Fourth, new')).toBe(revisionCellId(FILE, 2, 'docx:p[3]'))
    expect(ADOPTED_STAMP).toBe('aquilla:adopted@1')
  })

  it('a projection rebuild reproduces a revisioned file from its manifests', async () => {
    const { post, env, sourceCells } = await setup()
    await post({ artifactSha256: SHA_A, stamp: 'docx@1', units: [para(0, 'Keep me'), para(1, 'Drop me later'), para(2, 'Edit me please')] })
    await post({ artifactSha256: SHA_B, stamp: 'docx@1', units: [para(0, 'Keep me'), para(1, 'Edit me please now')] })
    const before = await sourceCells()
    const snapshot = (rows: typeof before) =>
      rows.map((c) => [c.cell_id, c.value, c.event_id, c.anchor_cell_id, c.tombstoned_at == null ? 'live' : 'tomb']).sort()
    expect(before.filter((c) => c.tombstoned_at == null)).toHaveLength(2)

    const res = await handleRebuildProjectionRequest(
      new Request(`https://x/admin/projects/${PROJECT}/rebuild-projection?fullReplay=1`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${SECRET}` },
      }),
      env as never,
    )
    expect(res?.status).toBe(200)
    const after = await sourceCells()
    expect(snapshot(after)).toEqual(snapshot(before))
  })

  it('a rebuild refuses loudly when a revision manifest is unreadable', async () => {
    const { post, bucket, env } = await setup()
    await post({ artifactSha256: SHA_A, stamp: 'docx@1', units: [para(0, 'Only one')] })
    for (const key of bucket._allKeys()) await bucket.delete(key)
    const res = await handleRebuildProjectionRequest(
      new Request(`https://x/admin/projects/${PROJECT}/rebuild-projection?fullReplay=1`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${SECRET}` },
      }),
      env as never,
    )
    expect(res?.status).toBe(500)
    expect(await res!.text()).toMatch(/no readable manifest/)
  })
})

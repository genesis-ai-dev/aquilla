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
import { writeProjectionSnapshot } from '../events/projection-snapshot'
import { handleCellsReadRequest } from '../events/cells-read-route'
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
    (await rows<{ cell_id: string; value: string; event_id: string; anchor_cell_id: string | null; tombstoned_at: number | null; hidden_at: number | null; side: string }>('cells'))
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

  // Why: the file-counter recompute is a full-file scan (2.6 s on a 10k-cell
  // file, local stack) and a fresh import's /import finalize runs it anyway.
  // Running it in the revision too made revision imports ~3 s slower than the
  // N-event path. With `finalizeFollows` the route leaves it to the finalize,
  // and the end state is the same.
  it('with finalizeFollows the counters are left to the import finalize, which sets them', async () => {
    const { post, rows, env, token } = await setup()
    const res = await post({ artifactSha256: SHA_A, stamp: 'docx@1', finalizeFollows: true, units: [para(0, 'One'), para(1, 'Two'), para(2, 'Three')] })
    expect(res?.status).toBe(200)
    expect((await rows<{ cell_count: number }>('files'))[0].cell_count ?? 0).toBe(0)
    const finalize = await handleBulkImportRequest(
      new Request('https://x/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ projectId: PROJECT, fileId: FILE, cells: [], complete: true }),
      }),
      env as never,
    )
    expect(finalize?.status).toBe(200)
    expect((await rows<{ cell_count: number }>('files'))[0].cell_count).toBe(3)
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
    // Hidden too: the editor hides `hidden` rows (as after a reconcile
    // re-import) but shows a merely tombstoned row as a normal one.
    expect(gone?.hidden_at).not.toBeNull()
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

  // Why: a revisioned file still takes per-cell source writes (a lead's source
  // edit, a split, /import/reconcile, an agent insert, a mirror window). Those
  // change `cells` but not the head manifest. If the next revision aligned
  // against the stale manifest, an `equal` unit would rewind its row to an old
  // event id, and a hand-inserted cell would be left anchored beside a manifest
  // cell — two cells on one anchor, a forked chain. The route must align
  // against what the file holds NOW, and record that as a revision so a
  // rebuild replays the same thing.
  it('aligns against live cells when per-cell source writes landed after the head revision', async () => {
    const { post, db, rows, sourceCells } = await setup()
    const r1 = (await (await post({
      artifactSha256: SHA_A,
      stamp: 'docx@1',
      units: [para(0, 'Alpha paragraph text'), para(1, 'Beta paragraph text'), para(2, 'Gamma paragraph text')],
    }))!.json()) as { eventId: string }
    const cells = await sourceCells()
    const alpha = cells.find((c) => c.value === 'Alpha paragraph text')!
    const beta = cells.find((c) => c.value === 'Beta paragraph text')!
    // Model what a source.cell.commit and a source.cell.create would project:
    // Beta edited by hand (new event id), a new cell X inserted after Alpha.
    await db
      .prepare(`UPDATE cells SET value = ?, event_id = ? WHERE project_id = ? AND file_id = ? AND cell_id = ? AND side = 'source'`)
      .bind('Beta paragraph text, fixed by hand', 'ev-hand-edit', PROJECT, FILE, beta.cell_id)
      .run()
    await db
      .prepare(
        `INSERT INTO cells (project_id, file_id, cell_id, side, value, event_id, anchor_cell_id, lane_id, validated, word_count, content_hash, last_editor, last_edit_at, sequence_index)
         SELECT ?, ?, 'c-hand-x', 'source', 'Hand inserted line', 'ev-hand-x', ?, (SELECT id FROM lanes WHERE project_id = ? AND role = 'source' LIMIT 1), 0, 3, 'h', 'lead', 2, 1`,
      )
      .bind(PROJECT, FILE, alpha.cell_id, PROJECT)
      .run()
    await db
      .prepare(`UPDATE cells SET anchor_cell_id = 'c-hand-x' WHERE project_id = ? AND file_id = ? AND cell_id = ? AND side = 'source'`)
      .bind(PROJECT, FILE, beta.cell_id)
      .run()

    // The upstream file changed too: Gamma edited. Beta is back to its file text.
    const res = await post({
      artifactSha256: SHA_B,
      stamp: 'docx@1',
      origin: 'reimport',
      units: [para(0, 'Alpha paragraph text'), para(1, 'Beta paragraph text'), para(2, 'Gamma paragraph text, revised')],
    })
    const body = (await res!.json()) as { revisionN: number; eventId: string; counts: Record<string, number> }
    expect(res?.status).toBe(200)
    // r2 records the live state (origin 'adopt'); r3 is the import.
    expect(body.revisionN).toBe(3)
    const revs = await rows<{ revision_n: number; origin: string; unit_count: number }>('file_revisions')
    expect(revs.map((r) => [r.revision_n, r.origin, r.unit_count])).toEqual([
      [1, 'import', 3],
      [2, 'adopt', 4],
      [3, 'reimport', 3],
    ])

    const live = (await sourceCells()).filter((c) => c.tombstoned_at == null)
    const byId = new Map(live.map((c) => [c.cell_id, c]))
    // Alpha untouched since r1: keeps the r1 event (pin stays valid).
    expect(byId.get(alpha.cell_id)?.event_id).toBe(r1.eventId)
    // Beta: same id, and its event moves FORWARD to r3 — never back to r1.
    expect(byId.get(beta.cell_id)?.value).toBe('Beta paragraph text')
    expect(byId.get(beta.cell_id)?.event_id).toBe(body.eventId)
    // The hand-inserted line is not in the file: tombstoned, not left dangling.
    expect(byId.has('c-hand-x')).toBe(false)
    // One chain: no two live cells share an anchor.
    const anchors = live.map((c) => c.anchor_cell_id ?? '<head>')
    expect(new Set(anchors).size).toBe(anchors.length)
  })

  it('without per-cell writes since the head, no extra revision is written', async () => {
    const { post, rows } = await setup()
    await post({ artifactSha256: SHA_A, stamp: 'docx@1', units: [para(0, 'One line'), para(1, 'Two line')] })
    const res = await post({ artifactSha256: SHA_B, stamp: 'docx@1', units: [para(0, 'One line'), para(1, 'Two lines')] })
    expect(((await res!.json()) as { revisionN: number }).revisionN).toBe(2)
    expect((await rows('file_revisions')).length).toBe(2)
  })

  // Why: a snapshot-seeded rebuild (AQU-1833) replays only the log's tail, so
  // a revision before the snapshot is never replayed. The next revision must
  // still know which cells its parent held, or what it dropped stays live.
  it('a snapshot-seeded rebuild still tombstones what a post-snapshot revision dropped', async () => {
    const { post, env, db, sourceCells } = await setup()
    const listable = env.SNAPSHOTS as unknown as ReturnType<typeof makeStubBucket> & { list?: unknown }
    listable.list = async ({ prefix = '' }: { prefix?: string } = {}) => ({
      objects: listable._allKeys().filter((k) => k.startsWith(prefix)).map((key) => ({ key, size: 1, uploaded: new Date() })),
      truncated: false,
      cursor: undefined,
    })
    await post({ artifactSha256: SHA_A, stamp: 'docx@1', units: [para(0, 'Stays here'), para(1, 'Goes away later'), para(2, 'Also stays')] })
    const written = await writeProjectionSnapshot({ SNAPSHOTS: env.SNAPSHOTS } as never, db, PROJECT, { minNewEvents: 0 })
    expect(written).not.toBeNull()
    await post({ artifactSha256: SHA_B, stamp: 'docx@1', units: [para(0, 'Stays here'), para(1, 'Also stays')] })
    const before = await sourceCells()
    const shape = (rs: typeof before) =>
      rs.map((c) => [c.cell_id, c.value, c.event_id, c.anchor_cell_id, c.tombstoned_at == null ? 'live' : 'tomb']).sort()

    const res = await handleRebuildProjectionRequest(
      new Request(`https://x/admin/projects/${PROJECT}/rebuild-projection`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${SECRET}` },
      }),
      env as never,
    )
    expect(res?.status).toBe(200)
    const report = (await res!.json()) as { snapshotSeq: number | null }
    expect(report.snapshotSeq).not.toBeNull()
    expect(shape(await sourceCells())).toEqual(shape(before))
  })

  // Re-import through the route (AQU-2459 increment 3). Why: /import/reconcile
  // does two file-level writes besides cells — the new import manifest goes
  // into files.meta (export rebuilds the document from it) and the "current
  // original" pointer moves to the new bytes. A re-import that moved the cells
  // but not those two would export the OLD document around NEW text. They must
  // land in the same batch as the cells, or not at all.
  describe('re-import', () => {
    const insertArtifact = async (db: Awaited<ReturnType<typeof setup>>['db'], id: string, sha: string, key: string, at: string) =>
      db
        .prepare(
          `INSERT INTO artifacts (id, project_id, uploaded_by_user_id, name, size_bytes, sha256, r2_key, file_id, kind, created_at)
           VALUES (?::uuid, ?, '1', 'doc.docx', 10, ?, ?, ?, 'source', ?::timestamptz)`,
        )
        .bind(id, PROJECT, sha, key, FILE, at)
        .run()
    const ART_A = '018f6b2e-0000-7000-8000-00000000000a'
    const ART_B = '018f6b2e-0000-7000-8000-00000000000b'
    const fileMeta = (manifest: Record<string, unknown>) => ({
      id: '018f6b2e-0000-7000-8000-0000000000f2',
      name: 'doc.docx',
      fileType: 'docx',
      importFormat: 'docx',
      parserVersion: 'builtin:docx@1',
      importManifest: manifest,
    })

    it('writes the import manifest and the source pointer with the cells', async () => {
      const { post, db, rows } = await setup()
      await post({ artifactSha256: SHA_A, stamp: 'builtin:docx@1', units: [para(0, 'One line'), para(1, 'Two line')] })
      await insertArtifact(db, ART_B, SHA_B, 'artifacts/p1/b/original.docx', '2026-11-08T00:00:00Z')
      const res = await post({
        artifactSha256: SHA_B,
        stamp: 'builtin:docx@1',
        origin: 'reimport',
        artifactId: ART_B,
        rawSourceFormat: 'docx',
        file: fileMeta({ version: 'v2' }),
        units: [para(0, 'One line'), para(1, 'Two lines now')],
      })
      expect(res?.status).toBe(200)
      const file = (await rows<{ meta: unknown }>('files'))[0]
      const meta = (typeof file.meta === 'string' ? JSON.parse(file.meta) : file.meta) as Record<string, unknown>
      expect(meta.aquillaImport).toEqual({ version: 'v2' })
      expect(meta.parserVersion).toBe('builtin:docx@1')
      const blobs = await rows<{ file_id: string; r2_key: string; format: string }>('file_source_blobs')
      expect(blobs).toEqual([expect.objectContaining({ file_id: FILE, r2_key: 'artifacts/p1/b/original.docx', format: 'docx' })])
    })

    it('refuses an artifact whose checksum is not the one the revision names, and writes nothing', async () => {
      const { post, db, rows } = await setup()
      await post({ artifactSha256: SHA_A, stamp: 'builtin:docx@1', units: [para(0, 'One line')] })
      await insertArtifact(db, ART_B, SHA_B, 'artifacts/p1/b/original.docx', '2026-11-08T00:00:00Z')
      const res = await post({
        artifactSha256: SHA_C,
        stamp: 'builtin:docx@1',
        artifactId: ART_B,
        rawSourceFormat: 'docx',
        file: fileMeta({ version: 'v2' }),
        units: [para(0, 'Changed line')],
      })
      expect(res?.status).toBe(409)
      expect((await rows('file_revisions')).length).toBe(1)
      expect(await rows('file_source_blobs')).toEqual([])
    })

    it('adopting a legacy file names the CURRENT original, not the bytes being imported', async () => {
      const { post, db, rows, env, token } = await setup()
      await handleBulkImportRequest(
        new Request('https://x/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            projectId: PROJECT,
            fileId: FILE,
            cells: [{ id: 'ev-c1', cellId: 'c1', anchorCellId: null, value: 'Legacy line', sequenceIndex: 0, metadata: { aquillaImport: { unitKey: 'docx:p[0]' } } }],
          }),
        }),
        env as never,
      )
      await insertArtifact(db, ART_A, SHA_A, 'artifacts/p1/a/original.docx', '2026-11-01T00:00:00Z')
      await db
        .prepare(`INSERT INTO file_source_blobs (file_id, project_id, format, r2_key, size_bytes, created_at) VALUES (?, ?, 'docx', ?, 10, 1)`)
        .bind(FILE, PROJECT, 'artifacts/p1/a/original.docx')
        .run()
      // The client uploads the new bytes BEFORE it posts the revision, so the
      // newest artifact row is the incoming one.
      await insertArtifact(db, ART_B, SHA_B, 'artifacts/p1/b/original.docx', '2026-11-08T00:00:00Z')
      const res = await post({
        artifactSha256: SHA_B,
        stamp: 'builtin:docx@1',
        origin: 'reimport',
        artifactId: ART_B,
        rawSourceFormat: 'docx',
        file: fileMeta({ version: 'v2' }),
        units: [para(0, 'Legacy line'), para(1, 'New line')],
      })
      expect(res?.status).toBe(200)
      const revs = await rows<{ revision_n: number; origin: string; artifact_sha256: string }>('file_revisions')
      expect(revs.map((r) => [r.revision_n, r.origin, r.artifact_sha256])).toEqual([
        [1, 'adopt', SHA_A],
        [2, 'reimport', SHA_B],
      ])
    })

    // Why: reconcile pairs docx paragraphs by position key (docx:p[2]), so an
    // inserted paragraph moved every later translation down one cell. The
    // revision path pairs by content, so each translation stays with its text.
    it('an inserted paragraph does not move translations on a legacy file', async () => {
      const { post, env, token, sourceCells } = await setup()
      const texts = ['Chapter one', 'The first paragraph stays the same.', 'The second paragraph will be edited.', 'The end.']
      await handleBulkImportRequest(
        new Request('https://x/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            projectId: PROJECT,
            fileId: FILE,
            cells: texts.map((value, i) => ({
              id: `ev-l${i}`,
              cellId: `l${i}`,
              anchorCellId: i === 0 ? null : `l${i - 1}`,
              value,
              sequenceIndex: i,
              metadata: { aquillaImport: { unitKey: `docx:p[${i}]` } },
            })),
          }),
        }),
        env as never,
      )
      const res = await post({
        artifactSha256: SHA_B,
        stamp: 'builtin:docx@1',
        origin: 'reimport',
        units: [
          para(0, 'Chapter one'),
          para(1, 'The first paragraph stays the same.'),
          para(2, 'A brand new paragraph.'),
          para(3, 'The second paragraph was edited.'),
          para(4, 'The end.'),
        ],
      })
      expect(res?.status).toBe(200)
      const live = new Map((await sourceCells()).filter((c) => c.tombstoned_at == null).map((c) => [c.value, c.cell_id]))
      expect(live.get('The second paragraph was edited.')).toBe('l2')
      expect(live.get('The end.')).toBe('l3')
      expect(live.get('A brand new paragraph.')).toBe(revisionCellId(FILE, 2, 'docx:p[2]'))
    })
  })

  // Why: a warm editor refreshes with `?since=<cursor>`, and the delta lists
  // changed cells from `events.cell_id`. A revision is ONE event with no
  // cell_id, so without this the delta came back empty and the editor kept
  // showing the previous revision's text after a reload (found on the local
  // stack). The answer is a full resync: a revision replaces many cells at once.
  it('a delta read past a revision tells the client to resync', async () => {
    const { post, db, token } = await setup()
    await post({ artifactSha256: SHA_A, stamp: 'docx@1', units: [para(0, 'One line'), para(1, 'Two line')] })
    const read = async (query: string) => {
      const res = await handleCellsReadRequest(
        new Request(`https://x/api/v1/projects/${PROJECT}/files/${FILE}/cells${query}`, { headers: { Authorization: `Bearer ${token}` } }),
        { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET } as never,
      )
      return (await res!.json()) as { maxServerSeq?: number; resync?: boolean; cells?: unknown[] }
    }
    const full = await read('')
    expect(typeof full.maxServerSeq).toBe('number')
    await post({ artifactSha256: SHA_B, stamp: 'docx@1', units: [para(0, 'One line'), para(1, 'Two lines, edited')] })
    const delta = await read(`?since=${full.maxServerSeq}`)
    expect(delta.resync).toBe(true)
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

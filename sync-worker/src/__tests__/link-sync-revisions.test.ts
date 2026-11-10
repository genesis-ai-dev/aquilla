// AQU-2459: an upstream file that changes by `file.revision` reaches a linked
// downstream. A revision is ONE event with no cell_id; its cells live in an R2
// manifest. Before this, the mirror read only per-cell `source.cell.*` events,
// so a downstream received the file row and none of its cells — every fresh
// docx/pptx/idml/html/xliff/srt/vtt import was invisible to linked projects.
//
// What must hold, revision after revision: the downstream's source rows are
// the upstream's — same ids, same text, same anchor chain, and what the
// upstream dropped is tombstoned downstream.

import { describe, it, expect } from 'vitest'
import { mirrorSync, deterministicDownstreamFileId, type RevisionManifestReader } from '../events/link-sync'
import { handleRevisionsRequest } from '../events/revisions-route'
import type { StoredRevisionManifest } from '../events/file-revision-apply'
import { makeTestDb } from './helpers/pg-test-db'
import { makeTestToken } from './helpers/auth'

const SECRET = 'test-secret'
const UPSTREAM = 'proj-upstream'
const DOWNSTREAM = 'proj-downstream'
const FILE = '018f6b2e-1c2a-7a2e-9a0e-5c0c7a1d2b47'
const DOWNSTREAM_FILE = deterministicDownstreamFileId(DOWNSTREAM, FILE)

const para = (i: number, text: string) => ({ unitKey: `docx:p[${i}]`, positional: true, text, sequenceIndex: i })

async function setup() {
  const t = await makeTestDb({
    projects: [{ id: UPSTREAM, name: 'Upstream', created_by: 1 }],
    files: [{ id: FILE, project_id: UPSTREAM, name: 'doc.docx', event_id: 'ev-file', meta: JSON.stringify({ parserVersion: 'builtin:docx@1' }) }],
  })
  await t.db
    .prepare(
      `INSERT INTO projects (id, name, created_by, source_project_id, source_link_mode, source_link_consumes, source_link_cursor)
       VALUES (?, 'Downstream', 1, ?, 'live', 'source', 0)`,
    )
    .bind(DOWNSTREAM, UPSTREAM)
    .run()
  const store = new Map<string, string>()
  const bucket = {
    async put(key: string, value: string) {
      store.set(key, value)
    },
    async get(key: string) {
      const v = store.get(key)
      return v === undefined ? null : { text: async () => v }
    },
    async delete(key: string) {
      store.delete(key)
    },
  }
  const reader: RevisionManifestReader = async (key) => {
    const v = store.get(key)
    return v === undefined ? null : (JSON.parse(v) as StoredRevisionManifest)
  }
  const token = await makeTestToken(SECRET, { projectId: UPSTREAM, fileId: FILE, role: 500 })
  const revise = async (sha: string, texts: string[]) => {
    const res = await handleRevisionsRequest(
      new Request(`https://x/api/v1/projects/${UPSTREAM}/files/${FILE}/revisions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ artifactSha256: sha.repeat(64), stamp: 'builtin:docx@1', units: texts.map((x, i) => para(i, x)) }),
      }),
      { SNAPSHOTS: bucket, AQUILLA_PG: t.db, SYNC_SECRET_KEY: SECRET } as never,
    )
    expect(res?.status).toBe(200)
  }
  type Row = { cell_id: string; value: string; anchor_cell_id: string | null; tombstoned_at: number | null }
  const sourceRows = async (projectId: string, fileId: string) =>
    (
      await t.db
        .prepare(
          `SELECT cell_id, value, anchor_cell_id, tombstoned_at FROM cells
           WHERE project_id = ? AND file_id = ? AND side = 'source' ORDER BY cell_id`,
        )
        .bind(projectId, fileId)
        .all<Row>()
    ).results.map((r) => [r.cell_id, r.value, r.anchor_cell_id, r.tombstoned_at == null ? 'live' : 'tomb'])
  const expectDownstreamMatchesUpstream = async () => {
    expect(await sourceRows(DOWNSTREAM, DOWNSTREAM_FILE)).toEqual(await sourceRows(UPSTREAM, FILE))
  }
  return { t, reader, revise, sourceRows, expectDownstreamMatchesUpstream }
}

describe('mirrorSync — upstream file revisions reach a linked downstream (AQU-2459)', () => {
  it('a fresh revision mirrors every cell, in order', async () => {
    const { t, reader, revise, sourceRows, expectDownstreamMatchesUpstream } = await setup()
    await revise('a', ['One', 'Two', 'Three'])
    await mirrorSync(t.db, DOWNSTREAM, { readRevisionManifest: reader })
    expect((await sourceRows(DOWNSTREAM, DOWNSTREAM_FILE)).length).toBe(3)
    await expectDownstreamMatchesUpstream()
  })

  it('a later revision mirrors its insert, edit and delete, and re-anchors the neighbours', async () => {
    const { t, reader, revise, sourceRows, expectDownstreamMatchesUpstream } = await setup()
    await revise('a', ['Chapter one', 'The quick brown fox jumps over the lazy dog.', 'A paragraph about weather.', 'The end.'])
    await mirrorSync(t.db, DOWNSTREAM, { readRevisionManifest: reader })
    await revise('b', ['Chapter one', 'Brand new paragraph.', 'The quick brown fox jumps over the sleepy dog.', 'The end.'])
    await mirrorSync(t.db, DOWNSTREAM, { readRevisionManifest: reader })
    await expectDownstreamMatchesUpstream()
    const live = (await sourceRows(DOWNSTREAM, DOWNSTREAM_FILE)).filter((r) => r[3] === 'live')
    expect(live.map((r) => r[1]).sort()).toEqual(
      ['Brand new paragraph.', 'Chapter one', 'The end.', 'The quick brown fox jumps over the sleepy dog.'],
    )
    // One chain: no two live cells on the same anchor.
    const anchors = live.map((r) => r[2] ?? '<head>')
    expect(new Set(anchors).size).toBe(anchors.length)
  })

  // A cell created and dropped upstream before the downstream's first sync gets
  // no row downstream at all (AQU-1567's rule: no tombstone for a row the
  // downstream never held), so only the live rows are compared here.
  it('a downstream that first syncs after two revisions lands on the same live rows', async () => {
    const { t, reader, revise, sourceRows } = await setup()
    await revise('a', ['Alpha line here', 'Beta line here', 'Gamma line here'])
    await revise('b', ['Alpha line here', 'Gamma line here', 'Delta line here'])
    await mirrorSync(t.db, DOWNSTREAM, { readRevisionManifest: reader })
    const live = async (p: string, f: string) => (await sourceRows(p, f)).filter((r) => r[3] === 'live')
    expect(await live(DOWNSTREAM, DOWNSTREAM_FILE)).toEqual(await live(UPSTREAM, FILE))
    expect((await sourceRows(DOWNSTREAM, DOWNSTREAM_FILE)).map((r) => r[1])).not.toContain('Beta line here')
  })

  // Why: the cursor must never move past cells the downstream did not get.
  it('without a manifest reader the sync fails and the cursor stays put', async () => {
    const { t, revise } = await setup()
    await revise('a', ['One', 'Two'])
    await expect(mirrorSync(t.db, DOWNSTREAM)).rejects.toThrow(/manifest reader/)
    const cursor = await t.db
      .prepare('SELECT source_link_cursor FROM projects WHERE id = ?')
      .bind(DOWNSTREAM)
      .first<{ source_link_cursor: number }>()
    expect(Number(cursor?.source_link_cursor)).toBe(0)
  })
})

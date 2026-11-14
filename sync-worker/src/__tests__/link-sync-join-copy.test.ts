// AQU-2549: a project that already had its own import of an upstream file.
//
// Biblica's BSB language projects imported "Genesis–Deuteronomy" on their own,
// in one step (a file row and one `file.revision`, the bulk import since Nov 6).
// The BSB source project then got a corrected copy (Gen 12: "Iraq" before
// "Iran") and a language project linked it. Two things went wrong:
//
//   1. After a replace (AQU-1679's join), EVERY translated line read "source
//      changed", not only the corrected note. A one-step import gives every line
//      the revision event as its source event, and that event carries no
//      per-line text, so the stale route could not tell an unchanged line from
//      a changed one once the join moved the line's event id. The join now
//      keeps an unchanged line's event id, the way a re-import does.
//   2. On a whole-project link the corrected file arrived as a second copy, with
//      no way to put it onto the project's own file. The lead can now join the
//      copy into the project's own file: the own file takes the source, the
//      copy is removed, and a copy with translations of its own is refused.
//
// Realistic lanes, the test lane filler off: the join writes source rows and
// the refusal reads target rows, so a lane minted on the fly would hide a write
// that lands in the wrong lane.

import { describe, it, expect } from 'vitest'
import { mirrorSync, deterministicDownstreamFileId, type RevisionManifestReader } from '../events/link-sync'
import { handleRevisionsRequest } from '../events/revisions-route'
import { handleStaleSourceRequest } from '../events/stale-source-route'
import { buildEventProjectionStmts, type PersistedEvent } from '../events/event-projection'
import type { StoredRevisionManifest } from '../events/file-revision-apply'
import type { AquillaStatement } from '../../../db/shim/postgres'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'
import { makeTestToken } from './helpers/auth'
import { headParentFor } from './helpers/chain-parent'

const SECRET = 'test-secret'
const BSB = 'proj-bsb-source'
const LANG = 'proj-portuguese'
const UP_GD = '018f6b2e-1c2a-7a2e-9a0e-5c0c7a1d2b01'
const UP_JOSH = '018f6b2e-1c2a-7a2e-9a0e-5c0c7a1d2b02'
const OWN_GD = '018f6b2e-1c2a-7a2e-9a0e-5c0c7a1d2b03'
const NAME = '3 Genesis–Deuteronomy'
const COPY_GD = deterministicDownstreamFileId(LANG, UP_GD)

const LANES = {
  bsbSource: 'b5b00001',
  bsbTarget: 'b5b00002',
  langSource: 'a7a00001',
  langTarget: 'a7a00002',
}

const OLD_NOTE = 'Mesopotamia: the region of modern Iran and Syria.'
const NEW_NOTE = 'Mesopotamia: the region of modern Iraq, Iran and Syria.'
const LINES = (note: string): string[] => [
  'Genesis',
  'The Creation',
  'In the beginning God created the heavens and the earth.',
  'Now the earth was formless and void, and darkness was over the surface of the deep.',
  'And God said, “Let there be light,” and there was light.',
  'The Call of Abram',
  'Then the LORD said to Abram, “Leave your country, your kindred, and your father’s household.”',
  note,
  'I will make you into a great nation, and I will bless you.',
  'So Abram departed, as the LORD had directed him.',
]
/** The three lines the team translated and validated, the Gen 12 note among them. */
const TRANSLATED = [LINES(OLD_NOTE)[2], OLD_NOTE, LINES(OLD_NOTE)[8]]

let seq = 0
async function emit(
  t: TestDb,
  projectId: string,
  kind: PersistedEvent['kind'],
  args: { fileId?: string; cellId?: string; parentId?: string | null; author?: string; payload: Record<string, unknown> },
): Promise<string> {
  seq += 1
  const id = `evt-2549-${String(seq).padStart(4, '0')}`
  const seqRow = await t.pg.query<{ next_seq: string }>(
    `SELECT COALESCE(MAX(server_seq), 0) + 1 AS next_seq FROM events WHERE project_id = $1`,
    [projectId],
  )
  const serverSeq = Number(seqRow.rows[0]?.next_seq ?? 1)
  const parentId =
    args.parentId !== undefined ? args.parentId : await headParentFor(t, projectId, kind, args.fileId, args.cellId, args.payload)
  const author = args.author ?? 'lead'
  await t.pg.query(
    `INSERT INTO events (id, schema_version, project_id, file_id, cell_id, parent_id, kind, author, payload, client_ts, server_ts, server_seq)
     VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $9)`,
    [id, projectId, args.fileId ?? null, args.cellId ?? null, parentId, kind, author, JSON.stringify(args.payload), serverSeq],
  )
  const event: PersistedEvent = {
    id, schemaVersion: 1, projectId, fileId: args.fileId ?? null, cellId: args.cellId ?? null, parentId, kind, author,
    payload: args.payload, clientTs: serverSeq, serverTs: serverSeq, serverSeq,
  }
  const stmts: AquillaStatement[] = []
  buildEventProjectionStmts(t.db, event, stmts)
  await t.db.batch(stmts)
  return id
}

async function setup() {
  seq = 0
  const meta = JSON.stringify({ parserVersion: 'builtin:idml@1' })
  const t = await makeTestDb({
    projects: [
      { id: BSB, name: 'BSB source', created_by: 1 },
      { id: LANG, name: 'BSB Portuguese', created_by: 1 },
    ],
    lanes: [
      { id: LANES.bsbSource, project_id: BSB, role: 'source', language: 'English', legacy_tag: null },
      { id: LANES.bsbTarget, project_id: BSB, role: 'target', language: 'Spanish', legacy_tag: '' },
      { id: LANES.langSource, project_id: LANG, role: 'source', language: 'English', legacy_tag: null },
      { id: LANES.langTarget, project_id: LANG, role: 'target', language: 'Portuguese', legacy_tag: '' },
    ],
    files: [
      { id: OWN_GD, project_id: LANG, name: NAME, event_id: 'ev-own-file', meta },
      { id: UP_GD, project_id: BSB, name: NAME, event_id: 'ev-up-gd', meta },
      { id: UP_JOSH, project_id: BSB, name: '4 Joshua–Esther', event_id: 'ev-up-josh', meta },
    ],
  })
  await t.pg.query(`SELECT set_config('aquilla.test_lane_fill', 'off', false)`)
  const store = new Map<string, string>()
  const bucket = {
    async put(key: string, value: string) { store.set(key, value) },
    async get(key: string) { const v = store.get(key); return v === undefined ? null : { text: async () => v } },
    async delete(key: string) { store.delete(key) },
  }
  const reader: RevisionManifestReader = async (key) => {
    const v = store.get(key)
    return v === undefined ? null : (JSON.parse(v) as StoredRevisionManifest)
  }
  /** A one-step import (or re-import) of a whole file: what the bulk import sends. */
  const revise = async (projectId: string, fileId: string, sha: string, texts: string[]) => {
    const token = await makeTestToken(SECRET, { projectId, fileId, role: 500 })
    const res = await handleRevisionsRequest(
      new Request(`https://x/api/v1/projects/${projectId}/files/${fileId}/revisions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          artifactSha256: sha.repeat(64),
          stamp: 'builtin:idml@1',
          units: texts.map((text, i) => ({ unitKey: `idml:story[u1]/p[${i}]`, positional: true, text, sequenceIndex: i })),
        }),
      }),
      { SNAPSHOTS: bucket, AQUILLA_PG: t.db, SYNC_SECRET_KEY: SECRET } as never,
    )
    expect(res?.status).toBe(200)
  }
  return { t, reader, revise }
}

type Row = { cell_id: string; value: string; event_id: string }
async function sourceOf(t: TestDb, projectId: string, fileId: string): Promise<Row[]> {
  return (
    await t.pg.query<Row>(
      `SELECT cell_id, value, event_id FROM cells
        WHERE project_id = $1 AND file_id = $2 AND side = 'source' AND tombstoned_at IS NULL ORDER BY cell_id`,
      [projectId, fileId],
    )
  ).rows
}

/** The own file's lines one per source event, as imports wrote them before Nov 6. */
async function importLineByLine(t: TestDb, fileId: string, texts: string[]): Promise<void> {
  let anchor: string | null = null
  for (const [i, value] of texts.entries()) {
    const cellId = `own-${i}`
    await emit(t, LANG, 'source.cell.create', { fileId, cellId, payload: { cellId, anchorCellId: anchor, value } })
    anchor = cellId
  }
}

/** Translate and validate {@link TRANSLATED} on one of the language project's files. */
async function translate(t: TestDb, fileId: string, values: readonly string[] = TRANSLATED): Promise<void> {
  const own = await sourceOf(t, LANG, fileId)
  for (const value of values) {
    const cell = own.find((c) => c.value === value)!
    const commit = await emit(t, LANG, 'target.cell.commit', {
      fileId, cellId: cell.cell_id, parentId: cell.event_id,
      payload: { value: `PT: ${value}`, sourceEventId: cell.event_id },
    })
    await emit(t, LANG, 'cell.validate', { fileId, cellId: cell.cell_id, author: 'reviewer', payload: { editEventId: commit } })
  }
}

async function staleValues(t: TestDb, fileId: string = OWN_GD): Promise<string[]> {
  const token = await makeTestToken(SECRET, { projectId: LANG, fileId, role: 500 })
  const res = await handleStaleSourceRequest(
    new Request(`https://x/api/v1/projects/${LANG}/files/${fileId}/stale-source`, { headers: { Authorization: `Bearer ${token}` } }),
    { AQUILLA_PG: t.db, SYNC_SECRET_KEY: SECRET } as never,
  )
  const body = (await res!.json()) as { staleCellIds: string[] }
  const own = await sourceOf(t, LANG, fileId)
  return body.staleCellIds.map((id) => own.find((c) => c.cell_id === id)?.value ?? id).sort()
}

/** What POST /link-source writes for a new live, whole-project link to BSB's source. */
async function link(t: TestDb, adopt: Record<string, unknown> | null): Promise<void> {
  await t.pg.query(
    `UPDATE projects SET source_project_id = $2, source_link_mode = 'live', source_link_consumes = 'source',
            source_link_gate = 'validated', source_link_cursor = 0, source_link_lane_id = $4, source_link_adopt = $3
      WHERE id = $1`,
    [LANG, BSB, adopt ? JSON.stringify(adopt) : null, LANES.bsbSource],
  )
}

async function liveFiles(t: TestDb): Promise<string[]> {
  return (
    await t.pg.query<{ id: string }>(
      `SELECT id FROM files WHERE project_id = $1 AND deleted_at IS NULL ORDER BY id`,
      [LANG],
    )
  ).rows.map((r) => (r.id === OWN_GD ? 'own' : r.id === COPY_GD ? 'copy' : r.id))
}

async function targetsAndValidators(t: TestDb, fileId: string = OWN_GD): Promise<{ targets: unknown[]; validators: number }> {
  const targets = (
    await t.pg.query(
      `SELECT cell_id, value, source_event_id, lane_id FROM cells
        WHERE project_id = $1 AND file_id = $2 AND side = 'target' ORDER BY cell_id`,
      [LANG, fileId],
    )
  ).rows
  const validators = Number(
    (await t.pg.query<{ n: string }>(
      `SELECT COUNT(*) n FROM cell_validators WHERE project_id = $1 AND file_id = $2`, [LANG, fileId],
    )).rows[0].n,
  )
  return { targets, validators }
}

describe('AQU-2549 part 4: after a replace, only lines whose source changed read "source changed"', () => {
  for (const how of ['one step (file.revision)', 'line by line'] as const) {
    it(`own file imported ${how}`, async () => {
      const { t, reader, revise } = await setup()
      try {
        if (how === 'line by line') await importLineByLine(t, OWN_GD, LINES(OLD_NOTE))
        else await revise(LANG, OWN_GD, 'a', LINES(OLD_NOTE))
        await translate(t, OWN_GD)
        expect(await staleValues(t)).toEqual([])
        const before = await targetsAndValidators(t)

        await revise(BSB, UP_GD, 'b', LINES(NEW_NOTE))
        await link(t, { files: { [UP_GD]: OWN_GD }, pending: [UP_GD] })
        await mirrorSync(t.db, LANG, { readRevisionManifest: reader })

        expect((await sourceOf(t, LANG, OWN_GD)).map((c) => c.value)).toContain(NEW_NOTE)
        expect(await staleValues(t)).toEqual([NEW_NOTE])
        expect(await targetsAndValidators(t)).toEqual(before)
      } finally {
        await t.close()
      }
    })
  }
})

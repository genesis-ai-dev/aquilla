// AQU-1767 phase 2: removing a row can be undone (`source.cell.restore`).
//
// Asserted on the ROWS (real Postgres via PGlite): what matters is what comes
// back — every lane's translation, the votes, the takes the removal took (and
// only those), the links, the comments — and that the cell's chain keeps
// working afterwards. A statement-shape test would pass while the data came
// out wrong.
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildEventProjectionStmts, type PersistedEvent } from '../events/event-projection'
import { buildChainClaimStmt, eventQualifiedParentKey } from '../events/chain-claims'
import { CELLS_RESTORE_COLUMNS, findRestorableRemoval } from '../events/removed-cell-archive'
import { authorize } from '../events/authorize'
import { ROLE } from '../events/role-policy'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'
import { makeTestToken } from './helpers/auth'
import type { EventKind, RawEvent } from '../events/types'

const P = 'proj-restore'
const F = 'file-a'
const C = 'cell-1'
const OTHER = 'cell-2'
const SRC_LANE = 'srclane1'
const DEFAULT_LANE = 'tgtlane1'
const FR_LANE = 'frlane01'
const SECRET = 'restore-secret'

let h: TestDb
let seq = 0

async function lanes(): Promise<void> {
  await h.pg.exec(`INSERT INTO lanes (id, project_id, role, name, lang_code, legacy_tag) VALUES
    ('${SRC_LANE}', '${P}', 'source', 'Greek', 'el', NULL),
    ('${DEFAULT_LANE}', '${P}', 'target', 'Swahili', 'sw', ''),
    ('${FR_LANE}', '${P}', 'target', 'French', 'fr', 'fr')`)
}

beforeEach(async () => {
  if (!h) {
    h = await makeTestDb()
  } else {
    await h.reset()
  }
  await lanes()
  seq = 0
})

afterAll(async () => {
  await h?.close()
})

async function project<K extends EventKind>(
  kind: K,
  payload: unknown,
  overrides: Partial<PersistedEvent> = {},
  gated = false,
): Promise<PersistedEvent> {
  seq += 1
  const event = {
    id: `evt-${seq}`,
    schemaVersion: 1,
    projectId: P,
    fileId: F,
    cellId: C,
    parentId: null,
    kind,
    author: 'sam',
    payload,
    clientTs: 1_000 + seq,
    serverTs: 2_000 + seq,
    serverSeq: seq,
    ...overrides,
  } as PersistedEvent<K>
  const stmts: AquillaStatement[] = []
  let chainGate
  if (gated && event.fileId && event.cellId) {
    chainGate = {
      projectId: P,
      fileId: event.fileId,
      cellId: event.cellId,
      parentKey: eventQualifiedParentKey(event.parentId, event.kind, event.payload),
    }
    stmts.push(buildChainClaimStmt(h.db, chainGate, event.id))
  }
  buildEventProjectionStmts(h.db, event, stmts, chainGate ? { chainGate } : undefined)
  await h.db.batch(stmts)
  return event
}

async function rows<T>(sql: string): Promise<T[]> {
  const r = await h.pg.query<T>(sql)
  return r.rows
}

/** A cell with everything the cascade takes: two lanes, votes, a waiver, a
 *  back-translation, morph rows, a selected take plus one already removed on
 *  its own, a link, a comment — and a neighbour that must be left alone. */
async function seedFullCell(): Promise<void> {
  await project('source.cell.create', { cellId: C, anchorCellId: null, value: 'In the beginning' }, { id: 'src-create' })
  await project('source.cell.create', { cellId: OTHER, anchorCellId: C, value: 'Next' }, { id: 'other-create', cellId: OTHER })
  await project('target.cell.commit', { value: 'Mwanzo' }, { id: 'tgt-sw', parentId: 'src-create' })
  await project('target.cell.commit', { value: 'Au commencement', targetLang: 'fr' }, { id: 'tgt-fr', parentId: 'src-create' })
  await project('cell.validate', { editEventId: 'tgt-sw' }, { id: 'val-1', author: 'ana' })
  await project('cell.waive', { ruleId: 'no-double-space', reason: 'intentional' }, { id: 'waive-1' })
  await h.pg.exec(`INSERT INTO cell_backtranslations
      (project_id, file_id, cell_id, target_event_id, bt_text, author, event_id, created_at, lane_id)
    VALUES ('${P}', '${F}', '${C}', 'tgt-sw', 'In the start', 'ana', 'bt-1', 1, '${DEFAULT_LANE}')`)
  await h.pg.exec(`INSERT INTO cell_word_morph (project_id, file_id, cell_id, word_seq, surface, lemma)
    VALUES ('${P}', '${F}', '${C}', 1, 'In', 'in')`)
  await project('cell.audio.attach', {
    audioId: 'take-1', url: 'https://r2.invalid/take-1', slot: 'recording', durationMs: 3000, label: 'Take 1', role: 'dub',
  }, { id: 'att-1' })
  await project('cell.audio.attach', {
    audioId: 'take-0', url: 'https://r2.invalid/take-0', slot: 'recording', durationMs: 3000, label: 'Take 0', role: 'dub',
  }, { id: 'att-0' })
  await project('cell.audio.select', { audioId: 'take-1' }, { id: 'sel-1' })
  await project('cell.audio.remove', { audioId: 'take-0' }, { id: 'rm-0' })
  await h.pg.exec(`INSERT INTO cell_links
      (project_id, kind, from_file_id, from_cell_id, to_file_id, to_cell_id, linked, origin, event_id, created_ts)
    VALUES ('${P}', 'subtitle-audio', '${F}', '${C}', 'cues', 'cue-9', 1, 'manual', 'link-1', 1)`)
  await h.pg.exec(`INSERT INTO comments
      (comment_id, project_id, scope_kind, file_id, cell_id, body, author_id, created_at, updated_at)
    VALUES ('cmt-1', '${P}', 'cell', '${F}', '${C}', 'Check this verse', 'ana', 10, 10)`)
}

async function snapshot() {
  return {
    cells: await rows<{ side: string; lane_id: string; value: string; event_id: string; validated: number }>(
      `SELECT side, lane_id, value, event_id, validated FROM cells WHERE cell_id = '${C}' ORDER BY side, lane_id`,
    ),
    validators: await rows(`SELECT username, lane_id FROM cell_validators WHERE cell_id = '${C}' ORDER BY username`),
    waivers: await rows(`SELECT rule_id FROM cell_waivers WHERE cell_id = '${C}'`),
    bts: await rows(`SELECT bt_text FROM cell_backtranslations WHERE cell_id = '${C}'`),
    morph: await rows(`SELECT surface FROM cell_word_morph WHERE cell_id = '${C}'`),
    audio: await rows<{ audio_id: string; deleted: number; selected: number }>(
      `SELECT audio_id, deleted, selected FROM cell_audio WHERE cell_id = '${C}' ORDER BY audio_id`,
    ),
    links: await rows(`SELECT linked FROM cell_links WHERE from_cell_id = '${C}'`),
    comments: await rows(`SELECT body, deleted_at FROM comments WHERE cell_id = '${C}'`),
  }
}

describe('source.cell.restore', () => {
  it('puts back everything a removal took, and only what it took', async () => {
    await seedFullCell()
    const before = await snapshot()
    expect(before.cells).toHaveLength(3)
    expect(before.audio).toEqual([
      { audio_id: 'take-0', deleted: 1, selected: 0 },
      { audio_id: 'take-1', deleted: 0, selected: 1 },
    ])

    const del = await project('source.cell.delete', {}, { id: 'del-1', parentId: 'src-create' })
    const gone = await snapshot()
    expect(gone.cells).toEqual([])
    expect(gone.validators).toEqual([])
    expect(gone.audio.every((a) => a.deleted === 1)).toBe(true)
    expect(gone.comments).toEqual([{ body: '', deleted_at: del.serverTs }])

    await project('source.cell.restore', { deleteEventId: 'del-1' }, { id: 'restore-1' })
    const after = await snapshot()
    expect(after).toEqual(before)
    // The neighbour was never touched.
    expect(await rows(`SELECT value FROM cells WHERE cell_id = '${OTHER}'`)).toEqual([{ value: 'Next' }])
    const archive = await rows<{ restored_by: string }>(`SELECT restored_by FROM removed_cell_archive`)
    expect(archive).toEqual([{ restored_by: 'restore-1' }])
  })

  it('finds the newest removal when none is named', async () => {
    await seedFullCell()
    await project('source.cell.delete', {}, { id: 'del-1', parentId: 'src-create' })
    await project('source.cell.restore', {}, { id: 'restore-1' })
    await project('source.cell.delete', {}, { id: 'del-2', parentId: 'src-create' })
    await project('source.cell.restore', {}, { id: 'restore-2' })
    const archive = await rows(`SELECT delete_event_id, restored_by FROM removed_cell_archive ORDER BY delete_event_id`)
    expect(archive).toEqual([
      { delete_event_id: 'del-1', restored_by: 'restore-1' },
      { delete_event_id: 'del-2', restored_by: 'restore-2' },
    ])
    expect((await snapshot()).cells).toHaveLength(3)
  })

  it('does nothing while the cell is live, and leaves the archive unused', async () => {
    await seedFullCell()
    await project('source.cell.delete', {}, { id: 'del-1', parentId: 'src-create' })
    await project('source.cell.restore', { deleteEventId: 'del-1' }, { id: 'restore-1' })
    await project('source.cell.restore', { deleteEventId: 'del-1' }, { id: 'restore-again' })
    const archive = await rows(`SELECT restored_by FROM removed_cell_archive`)
    expect(archive).toEqual([{ restored_by: 'restore-1' }])
  })

  it('leaves a take alone that someone changed after the removal', async () => {
    await seedFullCell()
    await project('source.cell.delete', {}, { id: 'del-1', parentId: 'src-create' })
    // Someone re-attaches the removed take and removes it again: its row now
    // carries a later event, so the removal no longer owns it. (select/remove
    // do not stamp a take's event_id; only a write that does can be detected,
    // and no screen offers the takes of a removed row anyway.)
    await project('cell.audio.attach', {
      audioId: 'take-1', url: 'https://r2.invalid/take-1b', slot: 'recording', durationMs: 3000, role: 'dub',
    }, { id: 'att-later' })
    await project('cell.audio.remove', { audioId: 'take-1' }, { id: 'rm-later' })
    await project('source.cell.restore', { deleteEventId: 'del-1' }, { id: 'restore-1' })
    const audio = (await snapshot()).audio
    expect(audio.find((a) => a.audio_id === 'take-1')?.deleted).toBe(1)
  })

  it('releases the removal\'s chain claim, so the next edit on the old head lands', async () => {
    await seedFullCell()
    await project('source.cell.delete', {}, { id: 'del-1', parentId: 'src-create' }, true)
    expect(await rows(`SELECT event_id FROM chain_claims WHERE cell_id = '${C}'`)).toEqual([{ event_id: 'del-1' }])
    await project('source.cell.restore', { deleteEventId: 'del-1' }, { id: 'restore-1' })
    expect(await rows(`SELECT event_id FROM chain_claims WHERE cell_id = '${C}'`)).toEqual([])
    // An edit chained on the restored head claims the slot and moves the head.
    await project('source.cell.commit', { value: 'In the very beginning' }, { id: 'edit-1', parentId: 'src-create' }, true)
    expect(await rows(`SELECT value, event_id FROM cells WHERE cell_id = '${C}' AND side = 'source'`)).toEqual([
      { value: 'In the very beginning', event_id: 'edit-1' },
    ])
  })

  it('a gated removal that lost its slot archives nothing', async () => {
    await seedFullCell()
    // The head moved on (an edit) before this stale removal arrived.
    await project('source.cell.commit', { value: 'Edited' }, { id: 'edit-1', parentId: 'src-create' }, true)
    await project('source.cell.delete', {}, { id: 'del-stale', parentId: 'src-create' }, true)
    expect(await rows(`SELECT delete_event_id FROM removed_cell_archive`)).toEqual([])
    expect((await snapshot()).cells.length).toBeGreaterThan(0)
  })

  it('replays to the same rows after a rebuild wipes the projection', async () => {
    await seedFullCell()
    const del = await project('source.cell.delete', {}, { id: 'del-1', parentId: 'src-create' })
    const restore = await project('source.cell.restore', { deleteEventId: 'del-1' }, { id: 'restore-1' })
    const live = await snapshot()
    // A rebuild: cells + validators wiped, then the log replayed. Here only the
    // removal and the restore are replayed — the earlier events' rows come back
    // from the archive, which is the point.
    await h.pg.exec(`DELETE FROM cells WHERE project_id = '${P}' AND cell_id = '${C}'; DELETE FROM cell_validators WHERE project_id = '${P}'`)
    for (const e of [del, restore]) {
      const stmts: AquillaStatement[] = []
      buildEventProjectionStmts(h.db, e, stmts)
      await h.db.batch(stmts)
    }
    const replayed = await snapshot()
    expect(replayed.cells).toEqual(live.cells)
    expect(replayed.validators).toEqual(live.validators)
  })
})

describe('findRestorableRemoval', () => {
  it('names the newest unrestored removal, and nothing while the cell is live', async () => {
    await seedFullCell()
    expect(await findRestorableRemoval(h.db, P, F, C, null)).toBeNull()
    await project('source.cell.delete', {}, { id: 'del-1', parentId: 'src-create' })
    expect(await findRestorableRemoval(h.db, P, F, C, null)).toEqual({ deleteEventId: 'del-1', deletedBy: 'sam' })
    expect(await findRestorableRemoval(h.db, P, F, C, 'nope')).toBeNull()
    await project('source.cell.restore', {}, { id: 'restore-1' })
    expect(await findRestorableRemoval(h.db, P, F, C, null)).toBeNull()
  })
})

describe('who may restore', () => {
  function restoreEvent(): RawEvent<'source.cell.restore'> {
    return {
      id: '00000000-0000-7000-0000-00000000cafe',
      schemaVersion: 1,
      kind: 'source.cell.restore',
      projectId: P,
      fileId: F,
      cellId: C,
      parentId: null,
      author: 'x',
      payload: {},
      clientTs: Date.now(),
    } as RawEvent<'source.cell.restore'>
  }
  const token = (username: string, role: number, src?: 'external') =>
    makeTestToken(SECRET, { projectId: P, fileId: F, role, username, ...(src ? { src } : {}) })

  it('the person who removed it may put it back', async () => {
    await seedFullCell()
    await project('source.cell.delete', {}, { id: 'del-1', parentId: 'src-create', author: 'sam' })
    const res = await authorize(await token('sam', ROLE.COMMENTER), restoreEvent(), SECRET, h.db)
    expect(res.ok).toBe(true)
  })

  it('someone else may not, unless they are a maintainer', async () => {
    await seedFullCell()
    await project('source.cell.delete', {}, { id: 'del-1', parentId: 'src-create', author: 'sam' })
    const other = await authorize(await token('ana', ROLE.PROJECT_LEAD), restoreEvent(), SECRET, h.db)
    expect(other).toMatchObject({ ok: false, status: 403 })
    const maintainer = await authorize(await token('ana', ROLE.MAINTAINER), restoreEvent(), SECRET, h.db)
    expect(maintainer.ok).toBe(true)
  })

  it('is refused with nothing to restore, and through the external API', async () => {
    await seedFullCell()
    const nothing = await authorize(await token('sam', ROLE.MAINTAINER), restoreEvent(), SECRET, h.db)
    expect(nothing).toMatchObject({ ok: false, status: 422 })
    await project('source.cell.delete', {}, { id: 'del-1', parentId: 'src-create', author: 'sam' })
    const external = await authorize(await token('sam', ROLE.MAINTAINER, 'external'), restoreEvent(), SECRET, h.db)
    expect(external).toMatchObject({ ok: false, status: 403 })
  })
})

describe('CELLS_RESTORE_COLUMNS', () => {
  it('names every non-generated cells column in schema.sql, in order', () => {
    const schema = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../db/postgres/schema.sql'),
      'utf8',
    )
    const body = /CREATE TABLE (?:IF NOT EXISTS )?cells \(([\s\S]*?)\n\);/.exec(schema)?.[1] ?? ''
    const columns = body
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('--') && !/^(PRIMARY|UNIQUE|CHECK|FOREIGN|CONSTRAINT)\b/i.test(l))
      .filter((l) => !/GENERATED/i.test(l))
      .map((l) => l.split(/\s+/)[0])
    expect([...CELLS_RESTORE_COLUMNS]).toEqual(columns)
  })
})

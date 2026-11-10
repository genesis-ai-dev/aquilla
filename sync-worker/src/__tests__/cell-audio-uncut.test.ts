// AQU-2492 (review, Nov 9; Sam's call the same day): undoing a cut keeps the
// approvals. "I would like an approved cut to still be undoable. We just need
// to remember the approval for if the cut is redone (not manually, but with a
// redo button)."
//
//   - Undoing a cut (`cell.audio.uncut`) always joins the pieces, approved or
//     not, and gives the take back the approvals it had before the cut.
//   - The pieces' approvals at the moment of the Undo are kept; the Redo (a
//     cut naming the piece the undo removed) brings the pieces back with them.
//   - A cut by hand is a new cut and gets nothing back.
//   - Only approvals that really were on that take, on that audio, come back,
//     and each is still the voter's own row.
//
// Asserted on the ROWS (real Postgres via PGlite), like cell-audio-cut.test.ts.
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { buildEventProjectionStmts, type PersistedEvent } from '../events/event-projection'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'
import { AUDIO_CTE_SQL } from '../../../db/shared/audio-progress'
import type { EventKind } from '../events/types'

const P = 'proj-uncut'
const F = 'file-a'
const C = 'cell-1'
const SRC_LANE = 'aa00bb11'
const DEFAULT_LANE = 'cc22dd33'
const SPANISH = 'ee44ff55'

let h: TestDb
let seq = 0
/** Every event projected in this test, in order, for the rebuild replay. */
let log: PersistedEvent[] = []

async function seedLanes() {
  await h.pg.exec(`INSERT INTO lanes (id, project_id, role, name, lang_code, legacy_tag) VALUES
    ('${SRC_LANE}', '${P}', 'source', 'Greek', 'el', NULL),
    ('${DEFAULT_LANE}', '${P}', 'target', 'Swahili', 'sw', ''),
    ('${SPANISH}', '${P}', 'target', 'Spanish', 'es', 'es')`)
}

beforeEach(async () => {
  log = []
  if (!h) {
    h = await makeTestDb()
    await seedLanes()
    return
  }
  await h.reset()
  await seedLanes()
})

afterAll(async () => {
  await h?.close()
})

async function run(event: PersistedEvent): Promise<void> {
  const stmts: AquillaStatement[] = []
  buildEventProjectionStmts(h.db, event, stmts)
  await h.db.batch(stmts)
}

async function project<K extends EventKind>(kind: K, payload: unknown, overrides: Partial<PersistedEvent> = {}): Promise<void> {
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
  log.push(event)
  await run(event)
}

const attach = (audioId: string, extra: Record<string, unknown> = {}) =>
  project('cell.audio.attach', { audioId, url: `https://r2.invalid/${audioId}`, slot: 'recording', durationMs: 6_000, label: 'Take 1', ...extra })
const vote = (audioId: string, author: string) => project('cell.audio.validate', { audioId }, { author })
const cut = (audioId: string, atMs: number, newAudioId: string) => project('cell.audio.cut', { audioId, atMs, newAudioId })
const uncut = (audioId: string, pieceAudioId: string, trimEndMs: number | null, trimStartMs: number | null = null) =>
  project('cell.audio.uncut', { audioId, pieceAudioId, trimStartMs, trimEndMs })

interface Row {
  audio_id: string
  selected: number
  deleted: number
  trim_start_ms: string | number | null
  trim_end_ms: string | number | null
  validator_count: number
  label: string | null
  lane_id: string | null
}
const rows = async (): Promise<Record<string, Row>> =>
  Object.fromEntries((await h.pg.query<Row>(
    `SELECT audio_id, selected, deleted, trim_start_ms, trim_end_ms, validator_count, label, lane_id
       FROM cell_audio ORDER BY audio_id`,
  )).rows.map((r) => [r.audio_id, r]))
const n = (v: string | number | null): number | null => (v == null ? null : Number(v))

/** Who has approved each take, live rows only, sorted. */
async function votes(): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {}
  for (const r of (await h.pg.query<{ audio_id: string; username: string }>(
    `SELECT audio_id, username FROM cell_audio_validators ORDER BY audio_id, username`,
  )).rows) (out[r.audio_id] ??= []).push(r.username)
  return out
}

const lineVotes = async (): Promise<number | null> => {
  const row = (await h.pg.query<{ dub_votes: number | null }>(
    AUDIO_CTE_SQL.replace(/\?/g, (() => { let i = 0; return () => `$${++i}` })()),
    [P, F],
  )).rows[0]
  return row?.dub_votes == null ? null : Number(row.dub_votes)
}

/** A take approved by two reviewers, cut in two, each piece then approved by someone else. */
async function approvedCutWithApprovedPieces() {
  await attach('take-a')
  await vote('take-a', 'rita')
  await vote('take-a', 'ravi')
  await cut('take-a', 2_000, 'take-b')
  await vote('take-a', 'rosa')
  await vote('take-b', 'remi')
}

describe('cell.audio.uncut — undoing a cut (AQU-2492)', () => {
  it('joins the pieces and gives the take back everyone\'s approvals from before the cut, as they were', async () => {
    await attach('take-a')
    await vote('take-a', 'rita')
    await vote('take-a', 'ravi')
    const before = (await h.pg.query(`SELECT * FROM cell_audio_validators ORDER BY username`)).rows
    await cut('take-a', 2_000, 'take-b')
    expect(await votes()).toEqual({})

    await uncut('take-a', 'take-b', null)
    const r = await rows()
    expect([n(r['take-a'].trim_start_ms), n(r['take-a'].trim_end_ms)]).toEqual([null, null])
    expect([r['take-b'].deleted, r['take-b'].selected]).toEqual([1, 0])
    // The voters' own rows: who, when, which lane — exactly as before the cut.
    expect((await h.pg.query(`SELECT * FROM cell_audio_validators ORDER BY username`)).rows).toEqual(before)
    expect(r['take-a'].validator_count).toBe(2)
    expect(await lineVotes()).toBe(2)
  })

  it('always works when the pieces were approved since: their approvals are kept, the take gets its own back', async () => {
    await approvedCutWithApprovedPieces()
    await uncut('take-a', 'take-b', null)
    // The first half's approval no longer sits on the whole take.
    expect(await votes()).toEqual({ 'take-a': ['ravi', 'rita'], 'take-b': ['remi'] })
    const r = await rows()
    expect(r['take-a'].validator_count).toBe(2)
    expect(r['take-b'].deleted).toBe(1)
    const kept = (await h.pg.query<{ kind: string; votes: Array<{ username: string }> }>(
      `SELECT kind, votes FROM cell_audio_cut_votes ORDER BY archived_seq`,
    )).rows.map((a) => [a.kind, a.votes.map((v) => v.username).sort()])
    expect(kept).toEqual([['whole', ['ravi', 'rita']], ['first', ['rosa']]])
  })

  it('Redo brings the pieces back with the approvals they had at the Undo, chosen as the take was', async () => {
    await approvedCutWithApprovedPieces()
    await uncut('take-a', 'take-b', null)
    await cut('take-a', 2_000, 'take-b') // the history's Redo names the same piece
    const r = await rows()
    expect([r['take-b'].deleted, r['take-b'].selected]).toEqual([0, 1])
    expect([n(r['take-a'].trim_end_ms), n(r['take-b'].trim_start_ms), n(r['take-b'].trim_end_ms)]).toEqual([2_000, 2_000, null])
    expect(await votes()).toEqual({ 'take-a': ['rosa'], 'take-b': ['remi'] })
    expect([r['take-a'].validator_count, r['take-b'].validator_count]).toEqual([1, 1])
    expect(await lineVotes()).toBe(1)
  })

  it('Undo, Redo, Undo again: each time the take and its pieces get their own approvals back', async () => {
    await approvedCutWithApprovedPieces()
    await uncut('take-a', 'take-b', null)
    await vote('take-a', 'rafa') // approves the rejoined take
    await cut('take-a', 2_000, 'take-b')
    expect(await votes()).toEqual({ 'take-a': ['rosa'], 'take-b': ['remi'] })
    await vote('take-b', 'rafa') // and then the second piece
    await uncut('take-a', 'take-b', null)
    expect(await votes()).toEqual({ 'take-a': ['rafa', 'ravi', 'rita'], 'take-b': ['rafa', 'remi'] })
    await cut('take-a', 2_000, 'take-b')
    expect(await votes()).toEqual({ 'take-a': ['rosa'], 'take-b': ['rafa', 'remi'] })
  })

  it('a cut by hand after an Undo is a new cut: its pieces start bare, and the old piece stays removed', async () => {
    await approvedCutWithApprovedPieces()
    await uncut('take-a', 'take-b', null)
    await cut('take-a', 2_000, 'take-c')
    expect(await votes()).toEqual({ 'take-b': ['remi'] })
    const r = await rows()
    expect([r['take-a'].validator_count, r['take-c'].validator_count]).toEqual([0, 0])
    expect(r['take-b'].deleted).toBe(1)
  })

  it('a cut of a cut, three pieces: undone and redone piece by piece, each keeps its own approvals', async () => {
    await attach('take-a')
    await vote('take-a', 'rita')
    await cut('take-a', 2_000, 'take-b')
    await vote('take-b', 'ravi') // the second piece, before it is cut again
    await cut('take-b', 4_000, 'take-c')
    await vote('take-a', 'rosa')
    await vote('take-b', 'remi')
    await vote('take-c', 'rafa')
    // Undo the second cut: the middle piece gets back what it had before it.
    await uncut('take-b', 'take-c', null, 2_000)
    expect(await votes()).toEqual({ 'take-a': ['rosa'], 'take-b': ['ravi'], 'take-c': ['rafa'] })
    // Undo the first: the whole take gets back its own.
    await uncut('take-a', 'take-b', null)
    expect(await votes()).toEqual({ 'take-a': ['rita'], 'take-b': ['ravi'], 'take-c': ['rafa'] })
    // Redo both, in order: each piece as it was.
    await cut('take-a', 2_000, 'take-b')
    await cut('take-b', 4_000, 'take-c')
    expect(await votes()).toEqual({ 'take-a': ['rosa'], 'take-b': ['remi'], 'take-c': ['rafa'] })
    const r = await rows()
    expect(['take-a', 'take-b', 'take-c'].map((id) => r[id].deleted)).toEqual([0, 0, 0])
    expect(['take-a', 'take-b', 'take-c'].map((id) => r[id].validator_count)).toEqual([1, 1, 1])
  })

  it('on an added track and in a second language, the approvals come back with their lane', async () => {
    await attach('take-a', { slot: 'track-9', targetLang: 'es' })
    await vote('take-a', 'rita')
    await cut('take-a', 2_000, 'take-b')
    await vote('take-a', 'rosa')
    await uncut('take-a', 'take-b', null)
    const back = (await h.pg.query<{ username: string; lane_id: string | null }>(
      `SELECT username, lane_id FROM cell_audio_validators WHERE audio_id = 'take-a'`,
    )).rows
    expect(back).toEqual([{ username: 'rita', lane_id: SPANISH }])
    await cut('take-a', 2_000, 'take-b')
    const r = await rows()
    expect([r['take-b'].deleted, r['take-b'].lane_id]).toEqual([0, SPANISH])
    expect(await votes()).toEqual({ 'take-a': ['rosa'] })
  })

  it('never puts an approval on audio it was not given to: a take whose recording was swapped gets none back', async () => {
    await attach('take-a')
    await vote('take-a', 'rita')
    await cut('take-a', 2_000, 'take-b')
    // Somebody puts other audio under the take (AQU-1571: its votes go).
    await project('cell.audio.attach', { audioId: 'take-a', url: 'https://r2.invalid/other', slot: 'recording' })
    await uncut('take-a', 'take-b', null)
    expect(await votes()).toEqual({})
    expect((await rows())['take-a'].validator_count).toBe(0)
  })

  it('a second delivery of the same undo changes nothing more', async () => {
    await approvedCutWithApprovedPieces()
    await uncut('take-a', 'take-b', null)
    const once = { rows: await rows(), votes: await votes() }
    const again = log[log.length - 1]
    await run(again)
    expect({ rows: await rows(), votes: await votes() }).toEqual(once)
  })

  it('a Redo after someone changed the take since is refused and changes nothing', async () => {
    await approvedCutWithApprovedPieces()
    await uncut('take-a', 'take-b', null)
    await project('cell.audio.trim', { audioId: 'take-a', trimStartMs: null, trimEndMs: 5_000 })
    const before = { rows: await rows(), votes: await votes() }
    await cut('take-a', 2_000, 'take-b')
    expect({ rows: await rows(), votes: await votes() }).toEqual(before)
  })

  it('a rebuild, replaying the log over today\'s rows, lands on the same rows and approvals', async () => {
    await approvedCutWithApprovedPieces()
    await uncut('take-a', 'take-b', null)
    await vote('take-a', 'rafa')
    await cut('take-a', 2_000, 'take-b')
    await vote('take-b', 'rafa')
    await uncut('take-a', 'take-b', null)
    await project('cell.audio.unvalidate', { audioId: 'take-a' }, { author: 'ravi' })
    const live = { rows: await rows(), votes: await votes() }
    const archives = (await h.pg.query(`SELECT * FROM cell_audio_cut_votes ORDER BY event_id`)).rows
    for (const event of [...log]) await run(event)
    expect({ rows: await rows(), votes: await votes() }).toEqual(live)
    expect((await h.pg.query(`SELECT * FROM cell_audio_cut_votes ORDER BY event_id`)).rows).toEqual(archives)
  })

  it('names its old label back when the cut renamed the first piece', async () => {
    await attach('take-a')
    await project('cell.audio.cut', { audioId: 'take-a', atMs: 2_000, newAudioId: 'take-b', firstLabel: 'Take 1 · 1', newLabel: 'Take 1 · 2' })
    await project('cell.audio.uncut', { audioId: 'take-a', pieceAudioId: 'take-b', trimStartMs: null, trimEndMs: null, rename: { label: 'Take 1' } })
    expect((await rows())['take-a'].label).toBe('Take 1')
  })
})

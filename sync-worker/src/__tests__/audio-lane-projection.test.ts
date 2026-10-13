// AQU-1591: audio takes belong to a lane.
//
// Before this, `cell_audio` had no lane column at all, so one recording was the
// recording in every language: a Swahili dub showed up in the French takes
// strip, selecting it there deselected the French take, and the French lane's
// progress counted it as recorded. AQU-1200 decided audio is per lane — source
// audio on the source lane, each dub on the target lane whose language it
// performs — and these are that rule's guards.
//
// Asserted on the ROWS and on the read's answer rather than on the SQL emitted:
// every rule here is a property of what lands (which lane a take resolves to,
// whose selection a select may clear, which takes a lane can see) that a
// statement-shape assertion would pass while the data came out wrong.
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { buildEventProjectionStmts, type PersistedEvent } from '../events/event-projection'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'
import { makeTestToken } from './helpers/auth'
import { handleCellAudioReadRequest } from '../events/cell-audio-read-route'
import type { EventKind } from '../events/types'

const P = 'proj-lane-audio'
const F = 'file-a'
const C = 'cell-1'
const SECRET = 'audio-lane-secret'

/** The project's lanes: one source, the default target, and a second target. */
const SRC_LANE = 'aa00bb11'
const DEFAULT_LANE = 'cc22dd33'
const FR_LANE = 'ee44ff55'

let h: TestDb

beforeEach(async () => {
  if (!h) {
    h = await makeTestDb({
      lanes: [
        { id: SRC_LANE, project_id: P, role: 'source', name: 'Greek', lang_code: 'el', legacy_tag: null },
        { id: DEFAULT_LANE, project_id: P, role: 'target', name: 'Swahili', lang_code: 'sw', legacy_tag: '' },
        { id: FR_LANE, project_id: P, role: 'target', name: 'French', lang_code: 'fr', legacy_tag: 'fr' },
      ],
    })
    return
  }
  await h.reset()
  await h.pg.exec(`INSERT INTO lanes (id, project_id, role, name, lang_code, legacy_tag) VALUES
    ('${SRC_LANE}', '${P}', 'source', 'Greek', 'el', NULL),
    ('${DEFAULT_LANE}', '${P}', 'target', 'Swahili', 'sw', ''),
    ('${FR_LANE}', '${P}', 'target', 'French', 'fr', 'fr')`)
})

afterAll(async () => {
  await h?.close()
})

function makeEvent<K extends EventKind>(
  kind: K,
  payload: unknown,
  overrides: Partial<PersistedEvent> = {},
): PersistedEvent<K> {
  return {
    id: 'evt-1',
    schemaVersion: 1,
    projectId: P,
    fileId: F,
    cellId: C,
    parentId: null,
    kind,
    author: 'sam',
    payload,
    clientTs: 1_000,
    serverTs: 2_000,
    serverSeq: 9,
    ...overrides,
  } as PersistedEvent<K>
}

async function project<K extends EventKind>(
  kind: K,
  payload: unknown,
  overrides: Partial<PersistedEvent> = {},
): Promise<void> {
  const stmts: AquillaStatement[] = []
  buildEventProjectionStmts(h.db, makeEvent(kind, payload, overrides), stmts)
  await h.db.batch(stmts)
}

interface TakeRow {
  audio_id: string
  lane_id: string | null
  slot: string
  role: string
  selected: number
}

const takes = async (): Promise<TakeRow[]> =>
  (await h.pg.query<TakeRow>(
    `SELECT audio_id, lane_id, slot, role, selected FROM cell_audio ORDER BY audio_id`,
  )).rows

/** Attach one take. `lane` undefined = an event that names no lane. */
async function attach(
  audioId: string,
  opts: { lane?: string; role?: 'source' | 'dub'; slot?: string; eventId?: string } = {},
): Promise<void> {
  await project(
    'cell.audio.attach',
    {
      audioId,
      url: `https://r2.invalid/${audioId}.webm`,
      slot: opts.slot ?? 'recording',
      ...(opts.role ? { role: opts.role } : {}),
      ...(opts.lane !== undefined ? { targetLang: opts.lane } : {}),
    },
    { id: opts.eventId ?? `evt-${audioId}` },
  )
}

/** GET the per-file read. `lane` undefined = no `?lane=` param at all. */
async function read(
  lane?: string,
  walledTo?: string[],
): Promise<Record<string, { attachments: Record<string, unknown> }>> {
  const token = await makeTestToken(SECRET, {
    projectId: P,
    fileId: F,
    ...(walledTo ? { role: 300, laneGrants: walledTo.map((id) => ({ lane: id, level: 300 })) } : {}),
  })
  const qs = lane === undefined ? '' : `?lane=${encodeURIComponent(lane)}`
  const res = await handleCellAudioReadRequest(
    new Request(`https://sync.invalid/api/v1/projects/${P}/files/${F}/audio-attachments${qs}`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
    { AQUILLA_PG: h.db, SYNC_SECRET_KEY: SECRET, ...(walledTo ? { LANE_READ_WALL: '1' } : {}) },
  )
  expect(res?.status).toBe(200)
  const body = (await res!.json()) as {
    cells: Record<string, { attachments: Record<string, unknown> }>
  }
  return body.cells
}

const visibleIds = (cells: Record<string, { attachments: Record<string, unknown> }>): string[] =>
  Object.keys(cells[C]?.attachments ?? {}).sort()

describe('cell_audio.lane_id — which lane a take lands in', () => {
  it('resolves a dub to the lane its event names', async () => {
    await attach('take-fr', { lane: 'fr' })
    expect(await takes()).toEqual([
      { audio_id: 'take-fr', lane_id: FR_LANE, slot: 'recording', role: 'dub', selected: 1 },
    ])
  })

  it('resolves a lane-less dub to the default lane, not to NULL', async () => {
    // What the client sends on the default lane: `targetLang` omitted. It is a
    // real lane, so the take gets its id — the same lane the batch backfill
    // (AQU-1616) assigns a dub with no tag.
    await attach('take-default')
    expect((await takes())[0].lane_id).toBe(DEFAULT_LANE)
  })

  it("resolves an import's shared programme audio to the SOURCE lane", async () => {
    // role='source' is the clip an import attached. It performs the source
    // text, not a translation, so it cannot belong to a target lane — and the
    // read below shows it in every one.
    await attach('programme', { role: 'source' })
    expect((await takes())[0]).toMatchObject({ lane_id: SRC_LANE, role: 'source' })
  })

  it('never moves a take between lanes on re-attach', async () => {
    // The transcription re-attach lands ~800ms after every recording and names
    // no lane. Treated as an opinion it would read as the default lane and drag
    // a French take out of French; lane_id is fill-only for exactly that reason.
    await attach('take-fr', { lane: 'fr' })
    await attach('take-fr', { eventId: 'evt-transcript' })
    expect((await takes())[0].lane_id).toBe(FR_LANE)
  })
})

describe('selection is per (cell, slot, lane)', () => {
  it('does not deselect another lane’s take in the same slot', async () => {
    await attach('take-sw', { lane: '' })
    await attach('take-fr', { lane: 'fr' })
    const rows = await takes()
    // Both selected: each is the live take of its own lane's recording slot.
    expect(rows.map((r) => [r.audio_id, r.selected])).toEqual([
      ['take-fr', 1],
      ['take-sw', 1],
    ])
  })

  it('still deselects the lane’s OWN earlier take in that slot', async () => {
    await attach('take-fr-1', { lane: 'fr' })
    await attach('take-fr-2', { lane: 'fr' })
    expect(await takes()).toEqual([
      { audio_id: 'take-fr-1', lane_id: FR_LANE, slot: 'recording', role: 'dub', selected: 0 },
      { audio_id: 'take-fr-2', lane_id: FR_LANE, slot: 'recording', role: 'dub', selected: 1 },
    ])
  })

  it('scopes an explicit cell.audio.select to its own lane', async () => {
    await attach('take-sw', { lane: '' })
    await attach('take-fr-1', { lane: 'fr' })
    await attach('take-fr-2', { lane: 'fr' })
    // French switches back to its first take. Swahili's selection is not French's
    // business and must survive untouched.
    await project(
      'cell.audio.select',
      { audioId: 'take-fr-1', slot: 'recording', targetLang: 'fr' },
      { id: 'evt-select' },
    )
    const selected = (await takes()).filter((r) => r.selected === 1).map((r) => r.audio_id)
    expect(selected.sort()).toEqual(['take-fr-1', 'take-sw'])
  })

  it('a dub still takes the recording slot over from the programme audio', async () => {
    // Unchanged by the lane scoping, and load-bearing: `resolveTargetAudio`
    // plays the recording when there is one, and the shared clip is selected on
    // every cell of an imported media file.
    //
    // KNOWN RESIDUAL, pinned here rather than left to be discovered. The
    // programme clip is ONE row shared by every lane, and `selected` is one
    // boolean on it, so "is the programme audio still this lane's stand-in?"
    // cannot be answered per lane: French recording a dub clears it for Swahili
    // too, which then has nothing selected in its recording slot until it
    // records its own. The clip is still listed and playable in every lane (the
    // read always returns `role = 'source'`) — what Swahili loses is the
    // stand-in, not the audio. It is strictly better than what this replaced,
    // where Swahili's recording slot showed the FRENCH take as selected and
    // played it. Saying it per lane needs a lane-keyed selection, which is a
    // model change AQU-1591 does not make.
    await attach('programme', { role: 'source' })
    await attach('take-fr', { lane: 'fr' })
    const rows = await takes()
    expect(rows.find((r) => r.audio_id === 'programme')!.selected).toBe(0)
    expect(rows.find((r) => r.audio_id === 'take-fr')!.selected).toBe(1)
  })

  it('a SOURCE attach claims the slot in every lane, so it is not lane-scoped', async () => {
    // The import's own clip is shared; it genuinely does take the slot
    // everywhere, so its deselect keeps the unscoped form it always had.
    await attach('take-sw', { lane: '' })
    await attach('take-fr', { lane: 'fr' })
    await attach('programme', { role: 'source', eventId: 'evt-import' })
    const selected = (await takes()).filter((r) => r.selected === 1).map((r) => r.audio_id)
    expect(selected).toEqual(['programme'])
  })
})

describe('the per-file read is lane-scoped', () => {
  beforeEach(async () => {
    await attach('programme', { role: 'source' })
    await attach('take-sw', { lane: '' })
    await attach('take-fr', { lane: 'fr' })
  })

  it('shows a lane its own dubs plus the shared programme audio', async () => {
    expect(visibleIds(await read('fr'))).toEqual(['programme', 'take-fr'])
    expect(visibleIds(await read(''))).toEqual(['programme', 'take-sw'])
  })

  it('returns every lane’s takes when no lane is asked for', async () => {
    // The pre-1591 wire, and what the whole-project freshness digest wants.
    expect(visibleIds(await read())).toEqual(['programme', 'take-fr', 'take-sw'])
  })

  it('reads an un-backfilled take into the default lane', async () => {
    // Every take that predates migration 0135 has lane_id NULL until the batch
    // backfill (AQU-1616) runs. The read applies that backfill's own rule, so
    // the answer does not change when it lands — rather than hiding a project's
    // entire audio history until it does.
    await h.pg.exec(`UPDATE cell_audio SET lane_id = NULL WHERE audio_id = 'take-sw'`)
    expect(visibleIds(await read(''))).toEqual(['programme', 'take-sw'])
    expect(visibleIds(await read('fr'))).toEqual(['programme', 'take-fr'])
  })
})

describe('the per-file read honours the lane read wall', () => {
  beforeEach(async () => {
    await attach('programme', { role: 'source' })
    await attach('take-sw', { lane: '' })
    await attach('take-fr', { lane: 'fr' })
  })

  it('an unscoped read returns only granted lanes’ dubs plus the programme audio', async () => {
    expect(visibleIds(await read(undefined, [FR_LANE]))).toEqual(['programme', 'take-fr'])
    expect(visibleIds(await read(undefined, [DEFAULT_LANE]))).toEqual(['programme', 'take-sw'])
  })

  it('a lane the caller was not granted reads as empty', async () => {
    expect(await read('', [FR_LANE])).toEqual({})
    expect(visibleIds(await read('fr', [FR_LANE]))).toEqual(['programme', 'take-fr'])
  })

  it('an un-backfilled dub is walled as the default lane’s', async () => {
    await h.pg.exec(`UPDATE cell_audio SET lane_id = NULL WHERE audio_id = 'take-sw'`)
    expect(visibleIds(await read(undefined, [FR_LANE]))).toEqual(['programme', 'take-fr'])
    expect(visibleIds(await read(undefined, [DEFAULT_LANE]))).toEqual(['programme', 'take-sw'])
  })
})

describe('a source clip on a project with no blank target lane (AQU-1594)', () => {
  beforeEach(async () => {
    await h.pg.exec(`DELETE FROM lanes WHERE id = '${DEFAULT_LANE}'`)
  })

  it('lands on the source lane and shows in the tagged lane, including a request for ""', async () => {
    await attach('programme', { role: 'source' })
    expect((await takes())[0]).toMatchObject({ lane_id: SRC_LANE, role: 'source' })
    const tags = await h.pg.query<{ legacy_tag: string | null }>(
      `SELECT legacy_tag FROM lanes WHERE project_id = $1 AND role = 'target' ORDER BY legacy_tag`,
      [P],
    )
    expect(tags.rows.map((row) => row.legacy_tag)).toEqual(['fr'])
    expect(visibleIds(await read('fr'))).toEqual(['programme'])
    expect(visibleIds(await read(''))).toEqual(['programme'])
    // A reader granted only the tagged lane still hears the clip, even when
    // they ask for the '' lane this project does not have.
    expect(visibleIds(await read('fr', [FR_LANE]))).toEqual(['programme'])
    expect(visibleIds(await read('', [FR_LANE]))).toEqual(['programme'])
  })

  it('does not mint a blank lane for a dub that names none', async () => {
    // The harness fills a NULL lane_id by inserting a lane. This test is
    // about the product write, which leaves the take unassigned.
    await h.pg.query(`SELECT set_config('aquilla.test_lane_fill', 'off', false)`)
    await attach('take-omitted')
    expect((await takes())[0].lane_id).toBeNull()
    const tags = await h.pg.query<{ legacy_tag: string | null }>(
      `SELECT legacy_tag FROM lanes WHERE project_id = $1 AND role = 'target'`,
      [P],
    )
    expect(tags.rows.map((row) => row.legacy_tag)).toEqual(['fr'])
    expect(visibleIds(await read('fr'))).toEqual([])
  })
})

describe('a vote carries the lane of the take it is on', () => {
  it('copies lane_id from cell_audio, not from the voter’s lane', async () => {
    await attach('take-fr', { lane: 'fr' })
    // A maintainer sitting on the DEFAULT lane signs off the French take. The
    // vote is a fact about that take, so it belongs to the take's lane.
    await project(
      'cell.audio.validate',
      { audioId: 'take-fr' },
      { id: 'evt-vote', author: 'maintainer' },
    )
    const rows = await h.pg.query<{ audio_id: string; username: string; lane_id: string | null }>(
      `SELECT audio_id, username, lane_id FROM cell_audio_validators`,
    )
    expect(rows.rows).toEqual([
      { audio_id: 'take-fr', username: 'maintainer', lane_id: FR_LANE },
    ])
  })
})

// AQU-2491 (review, Nov 9): a take's transcript arriving late leaves the line's
// chosen take, and a deleted take, exactly as they are.
//
// A fresh take is transcribed in the background and its word timings come back
// as a re-attach of the same take. The projection read every re-attach as "this
// take is live and chosen" (`selected = 1, deleted = 0`), so a transcript that
// landed after the person had recorded a newer take put the OLDER take back in
// charge of the line, and one that landed after the take was deleted brought it
// back. The timings now ride a words-only re-attach (`wordsOnly`, the flag the
// AQU-2426 split-by-words write uses, same meaning): it adds the words and
// chooses nothing.
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { buildEventProjectionStmts, type PersistedEvent } from '../events/event-projection'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'
import type { EventKind } from '../events/types'

const P = 'proj-late-words'
const F = 'file-a'
const C = 'cell-1'
const DEFAULT_LANE = 'cc22dd33'
const FR_LANE = 'ee44ff55'
const TIMINGS = [{ word: 'hola', t0: 0, t1: 0.4, start: 0, end: 4 }]

let h: TestDb

beforeEach(async () => {
  if (!h) {
    h = await makeTestDb({
      lanes: [
        { id: DEFAULT_LANE, project_id: P, role: 'target', name: 'Swahili', lang_code: 'sw', legacy_tag: '' },
        { id: FR_LANE, project_id: P, role: 'target', name: 'French', lang_code: 'fr', legacy_tag: 'fr' },
      ],
    })
  } else {
    await h.reset()
    await h.pg.exec(`INSERT INTO lanes (id, project_id, role, name, lang_code, legacy_tag) VALUES
      ('${DEFAULT_LANE}', '${P}', 'target', 'Swahili', 'sw', ''),
      ('${FR_LANE}', '${P}', 'target', 'French', 'fr', 'fr')`)
  }
  await project('source.cell.create', { cellId: C, anchorCellId: null, value: 'Hello' })
  // Take 1, then Take 2 recorded over it while Take 1 is still transcribing.
  await project('cell.audio.attach', { audioId: 'take-1', url: 'frontier-audio://x/take-1.webm', slot: 'recording', durationMs: 2_000 })
  await project('cell.audio.attach', { audioId: 'take-2', url: 'frontier-audio://x/take-2.webm', slot: 'recording', durationMs: 2_000 })
})

afterAll(async () => {
  await h?.close()
})

let seq = 10
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
  const stmts: AquillaStatement[] = []
  buildEventProjectionStmts(h.db, event, stmts)
  await h.db.batch(stmts)
}

const rows = async (): Promise<Record<string, { selected: number; deleted: number; words: number }>> =>
  Object.fromEntries((await h.pg.query<{ audio_id: string; selected: number; deleted: number; timings_json: string | null }>(
    `SELECT audio_id, selected, deleted, timings_json FROM cell_audio WHERE cell_id = '${C}' ORDER BY audio_id`,
  )).rows.map((r) => [r.audio_id, {
    selected: Number(r.selected),
    deleted: Number(r.deleted),
    words: r.timings_json ? (JSON.parse(r.timings_json) as unknown[]).length : 0,
  }]))

/** What transcribeCell sends when a take's transcript lands. */
const transcriptLands = (audioId: string, extra: Record<string, unknown> = {}) =>
  project('cell.audio.attach', {
    audioId, url: `frontier-audio://x/${audioId}.webm`, slot: 'recording', durationMs: 2_000,
    timings: TIMINGS, asr: { text: 'hola', model: 'whisper' }, wordsOnly: true, ...extra,
  })

describe("a take's transcript arriving late", () => {
  it('starts with the newer take chosen', async () => {
    expect(await rows()).toMatchObject({ 'take-1': { selected: 0 }, 'take-2': { selected: 1 } })
  })

  it('gives the older take its words and leaves the newer take chosen', async () => {
    await transcriptLands('take-1')
    expect(await rows()).toEqual({
      'take-1': { selected: 0, deleted: 0, words: 1 },
      'take-2': { selected: 1, deleted: 0, words: 0 },
    })
  })

  it('does not bring back a take deleted while it was transcribing', async () => {
    await project('cell.audio.remove', { audioId: 'take-2' })
    await transcriptLands('take-2')
    const after = await rows()
    expect(after['take-2']).toMatchObject({ deleted: 1, selected: 0 })
    expect(after['take-1']!.deleted).toBe(0)
  })

  it("on the chosen take it changes nothing but the words", async () => {
    await transcriptLands('take-2')
    expect(await rows()).toEqual({
      'take-1': { selected: 0, deleted: 0, words: 0 },
      'take-2': { selected: 1, deleted: 0, words: 1 },
    })
  })

  it('a second language: the older French take gets its words, the newer French take and the Swahili take stay chosen', async () => {
    await project('cell.audio.attach', { audioId: 'fr-1', url: 'frontier-audio://x/fr-1.webm', slot: 'recording', targetLang: 'fr' })
    await project('cell.audio.attach', { audioId: 'fr-2', url: 'frontier-audio://x/fr-2.webm', slot: 'recording', targetLang: 'fr' })
    await transcriptLands('fr-1', { targetLang: 'fr' })
    expect(await rows()).toMatchObject({
      'fr-1': { selected: 0, words: 1 },
      'fr-2': { selected: 1 },
      'take-2': { selected: 1 },
    })
  })

  it('an added track: the older take on the track gets its words, the newer one stays chosen', async () => {
    await project('cell.audio.attach', { audioId: 'trk-1', url: 'frontier-audio://x/trk-1.webm', slot: 'track-9' })
    await project('cell.audio.attach', { audioId: 'trk-2', url: 'frontier-audio://x/trk-2.webm', slot: 'track-9' })
    await transcriptLands('trk-1', { slot: 'track-9' })
    expect(await rows()).toMatchObject({ 'trk-1': { selected: 0, words: 1 }, 'trk-2': { selected: 1 }, 'take-2': { selected: 1 } })
  })

  // The shape this replaces, pinned so nobody reaches for it again.
  it('(why) the same write without the flag makes the older take the chosen one again', async () => {
    await project('cell.audio.attach', {
      audioId: 'take-1', url: 'frontier-audio://x/take-1.webm', slot: 'recording', durationMs: 2_000, timings: TIMINGS,
    })
    expect(await rows()).toMatchObject({ 'take-1': { selected: 1 }, 'take-2': { selected: 0 } })
  })
})

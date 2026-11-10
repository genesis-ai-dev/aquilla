// AQU-2426 (review, Nov 9): a line's words land without un-choosing its takes.
//
// Splitting a line by its words (Split into lines… › At sentences, with words,
// and Import and transcribe…), and keeping a line's words when nothing is
// split, write the words through a re-attach of the line's own source clip.
// Sent as `role: 'source'`, that re-attach claimed the recording slot in every
// lane: each language's chosen take on the line was deselected and the source
// clip became the line's chosen recording, so the line stopped sounding its
// dub and read as unrecorded until each take was picked again.
//
// The re-attach now says `wordsOnly`: it adds what is known about a clip
// already on the line and chooses nothing. Asserted on the rows, in a project
// with a former default lane ('' tag) and a named one, because the two are
// deselected by different clauses.
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { buildEventProjectionStmts, type PersistedEvent } from '../events/event-projection'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'
import type { EventKind } from '../events/types'

const P = 'proj-words-takes'
const F = 'file-a'
const C = 'cell-1'
const SRC = 'file-a-recording'
const URL = 'frontier-audio://proj-words-takes/file-a/recording.mp3'

const SRC_LANE = 'aa00bb11'
const DEFAULT_LANE = 'cc22dd33'
const FR_LANE = 'ee44ff55'

let h: TestDb

beforeEach(async () => {
  if (!h) {
    h = await makeTestDb({
      lanes: [
        { id: SRC_LANE, project_id: P, role: 'source', name: 'English', lang_code: 'en', legacy_tag: null },
        { id: DEFAULT_LANE, project_id: P, role: 'target', name: 'Swahili', lang_code: 'sw', legacy_tag: '' },
        { id: FR_LANE, project_id: P, role: 'target', name: 'French', lang_code: 'fr', legacy_tag: 'fr' },
      ],
    })
  } else {
    await h.reset()
    await h.pg.exec(`INSERT INTO lanes (id, project_id, role, name, lang_code, legacy_tag) VALUES
      ('${SRC_LANE}', '${P}', 'source', 'English', 'en', NULL),
      ('${DEFAULT_LANE}', '${P}', 'target', 'Swahili', 'sw', ''),
      ('${FR_LANE}', '${P}', 'target', 'French', 'fr', 'fr')`)
  }
  // The line as an import leaves it: one media line, its source clip chosen,
  // then a take recorded in each language.
  await project('source.cell.create', { cellId: C, anchorCellId: null, value: 'recording.mp3', medium: 'media', startMs: 0, endMs: 300_000 }, { id: 'evt-create' })
  await project('cell.audio.attach', { audioId: SRC, url: URL, slot: 'recording', role: 'source', durationMs: 300_000 }, { id: 'evt-src' })
  await project('cell.audio.attach', { audioId: 'take-sw', url: 'frontier-audio://x/take-sw.webm', slot: 'recording' }, { id: 'evt-sw' })
  await project('cell.audio.attach', { audioId: 'take-fr', url: 'frontier-audio://x/take-fr.webm', slot: 'recording', targetLang: 'fr' }, { id: 'evt-fr' })
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

const chosen = async (): Promise<Record<string, number>> =>
  Object.fromEntries((await h.pg.query<{ audio_id: string; selected: number }>(
    `SELECT audio_id, selected FROM cell_audio WHERE cell_id = '${C}' ORDER BY audio_id`,
  )).rows.map((r) => [r.audio_id, Number(r.selected)]))

const sourceRow = async () =>
  (await h.pg.query<{ role: string; trim_start_ms: number | null; trim_end_ms: number | null; duration_ms: number | null; deleted: number }>(
    `SELECT role, trim_start_ms, trim_end_ms, duration_ms, deleted FROM cell_audio WHERE cell_id = '${C}' AND audio_id = '${SRC}'`,
  )).rows[0]!

const lineText = async (): Promise<string | null> =>
  (await h.pg.query<{ transcription: string | null }>(
    `SELECT transcription FROM cells WHERE cell_id = '${C}' AND side = 'source'`,
  )).rows[0]?.transcription ?? null

describe('a line gets its words without losing its chosen takes', () => {
  it('starts with a take chosen in each language', async () => {
    expect(await chosen()).toEqual({ [SRC]: 0, 'take-fr': 1, 'take-sw': 1 })
  })

  it('a split by words: the first line is trimmed, gets its words, and both takes stay chosen', async () => {
    // What splitRecordingLine sends for the first piece.
    await project('cell.audio.trim', { audioId: SRC, trimStartMs: 0, trimEndMs: 4_200 })
    await project('cell.audio.attach', {
      audioId: SRC, url: URL, slot: 'recording', durationMs: 300_000, transcription: 'In the beginning.', wordsOnly: true,
    })

    expect(await chosen()).toEqual({ [SRC]: 0, 'take-fr': 1, 'take-sw': 1 })
    expect(await lineText()).toBe('In the beginning.')
    const src = await sourceRow()
    expect(src.role).toBe('source')
    expect(Number(src.trim_start_ms)).toBe(0)
    expect(Number(src.trim_end_ms)).toBe(4_200)
    expect(Number(src.duration_ms)).toBe(300_000)
  })

  it('keeping the words on a line nobody split leaves both takes chosen too', async () => {
    await project('cell.audio.attach', {
      audioId: SRC, url: URL, slot: 'recording', durationMs: 300_000, transcription: 'The whole transcript.', wordsOnly: true,
    })
    expect(await chosen()).toEqual({ [SRC]: 0, 'take-fr': 1, 'take-sw': 1 })
    expect(await lineText()).toBe('The whole transcript.')
  })

  it('on a line with no takes the source clip stays the chosen one', async () => {
    await h.pg.exec(`DELETE FROM cell_audio WHERE audio_id IN ('take-sw', 'take-fr')`)
    await h.pg.exec(`UPDATE cell_audio SET selected = 1 WHERE audio_id = '${SRC}'`)
    await project('cell.audio.attach', {
      audioId: SRC, url: URL, slot: 'recording', transcription: 'Words.', wordsOnly: true,
    })
    expect(await chosen()).toEqual({ [SRC]: 1 })
  })

  // AQU-2426 (browser pass, Nov 9): Undo of a split writes the line's whole
  // text back with its word times and what was heard, by the same words-only
  // re-attach. The page's own test (ProjectWorkspace.splitTextView.test.ts)
  // projects the events with these rules; this pins them on the server.
  it("Undo's write puts the whole text, its word times and what was heard back, and the takes stay chosen", async () => {
    const t = (word: string, t0: number) => ({ word, t0, t1: t0 + 0.3, start: 0, end: word.length })
    const whole = [t('In', 0.1), t('the', 0.5), t('beginning.', 0.9), t('Ruth', 5.2), t('went.', 5.6)]
    await project('cell.audio.attach', {
      audioId: SRC, url: URL, slot: 'recording', transcription: 'In the beginning. Ruth went.', wordsOnly: true,
      timings: whole, asr: { text: 'In the beginning. Root went.', model: 'whisper-large-v3' },
    })
    // The split's first line: its sentence, its own times, its own heard text.
    await project('cell.audio.trim', { audioId: SRC, trimStartMs: 0, trimEndMs: 4_200 })
    await project('cell.audio.attach', {
      audioId: SRC, url: URL, slot: 'recording', transcription: 'In the beginning.', wordsOnly: true,
      timings: whole.slice(0, 3), asr: { text: 'In the beginning.', model: 'whisper-large-v3' },
    })
    // Undo: the text with what went with it, then the whole stretch.
    await project('cell.audio.attach', {
      audioId: SRC, url: URL, slot: 'recording', transcription: 'In the beginning. Ruth went.', wordsOnly: true,
      timings: whole, asr: { text: 'In the beginning. Root went.', model: 'whisper-large-v3' },
    })
    await project('cell.audio.trim', { audioId: SRC, trimStartMs: null, trimEndMs: null })
    const row = (await h.pg.query<{ timings_json: string | null; asr_text: string | null }>(
      `SELECT timings_json, asr_text FROM cell_audio WHERE cell_id = '${C}' AND audio_id = '${SRC}'`,
    )).rows[0]!
    expect(await lineText()).toBe('In the beginning. Ruth went.')
    expect(JSON.parse(row.timings_json ?? '[]')).toEqual(whole)
    expect(row.asr_text).toBe('In the beginning. Root went.')
    expect(await chosen()).toEqual({ [SRC]: 0, 'take-fr': 1, 'take-sw': 1 })
    // A line that had no words: no times either ([] clears them; absent keeps them).
    await project('cell.audio.attach', { audioId: SRC, url: URL, slot: 'recording', transcription: '', wordsOnly: true, timings: [] })
    expect(await lineText()).toBe('')
    expect((await h.pg.query<{ timings_json: string | null }>(
      `SELECT timings_json FROM cell_audio WHERE cell_id = '${C}' AND audio_id = '${SRC}'`,
    )).rows[0]!.timings_json).toBe('[]')
  })

  // The shapes this replaces, pinned so nobody reaches for them again.
  it("(why) the same write as role 'source' un-chooses the takes in every language", async () => {
    await project('cell.audio.attach', {
      audioId: SRC, url: URL, slot: 'recording', role: 'source', transcription: 'In the beginning.',
    })
    expect(await chosen()).toEqual({ [SRC]: 1, 'take-fr': 0, 'take-sw': 0 })
  })

  it('(why) and with no role it still un-chooses the take in the former default lane', async () => {
    await project('cell.audio.attach', {
      audioId: SRC, url: URL, slot: 'recording', transcription: 'In the beginning.',
    })
    expect(await chosen()).toEqual({ [SRC]: 1, 'take-fr': 1, 'take-sw': 0 })
  })
})

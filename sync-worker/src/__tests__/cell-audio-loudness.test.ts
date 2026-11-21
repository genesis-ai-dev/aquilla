// AQU-2664: evening out the loudness of takes, non-destructively.
//
// Two facts are stored on the take (cell_audio, migration 0207):
//   - its recording's loudness and true peak, measured once in the browser and
//     sent on `cell.audio.measure` (fill-only, like its duration: the bytes of
//     an audio id never change, so a second reading has nothing to add);
//   - the target it is evened out to, sent on its OWN event, `cell.audio.even`
//     (always stated, null clears). Sam, Nov 19: "I do not want normalization
//     to override volume automation" — evening out is a stage before the
//     take's own volume and fades, so it never writes them, nor the votes.
// The recording itself and everything else are untouched.
//
// Asserted on the ROWS and on the read route (real Postgres via PGlite).
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { buildEventProjectionStmts, type PersistedEvent } from '../events/event-projection'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'
import { makeTestToken } from './helpers/auth'
import { handleCellAudioReadRequest } from '../events/cell-audio-read-route'
import type { EventKind } from '../events/types'

const P = 'proj-loud'
const F = 'file-a'
const C = 'cell-1'
const SECRET = 'audio-loudness-secret'
const SRC_LANE = 'aa00bb11'
const DEFAULT_LANE = 'cc22dd33'

let h: TestDb
let seq = 0

beforeEach(async () => {
  if (!h) {
    h = await makeTestDb({
      lanes: [
        { id: SRC_LANE, project_id: P, role: 'source', name: 'English', lang_code: 'en', legacy_tag: null },
        { id: DEFAULT_LANE, project_id: P, role: 'target', name: 'Arabic', lang_code: 'ar', legacy_tag: '' },
      ],
    })
    return
  }
  await h.reset()
  await h.pg.exec(`INSERT INTO lanes (id, project_id, role, name, lang_code, legacy_tag) VALUES
    ('${SRC_LANE}', '${P}', 'source', 'English', 'en', NULL),
    ('${DEFAULT_LANE}', '${P}', 'target', 'Arabic', 'ar', '')`)
})

afterAll(async () => {
  await h?.close()
})

function event<K extends EventKind>(kind: K, payload: unknown): PersistedEvent<K> {
  seq += 1
  return {
    id: `evt-${seq}`, schemaVersion: 1, projectId: P, fileId: F, cellId: C, parentId: null,
    kind, author: 'sam', payload, clientTs: 1_000 + seq, serverTs: 2_000 + seq, serverSeq: seq,
  } as PersistedEvent<K>
}

async function project<K extends EventKind>(kind: K, payload: unknown): Promise<void> {
  const stmts: AquillaStatement[] = []
  buildEventProjectionStmts(h.db, event(kind, payload), stmts)
  await h.db.batch(stmts)
}

const attach = (audioId: string) =>
  project('cell.audio.attach', { audioId, url: `https://r2.invalid/${audioId}`, slot: 'recording', durationMs: 4_600, label: 'Take 1' })
const gain = (audioId: string, extra: Record<string, unknown> = {}) =>
  project('cell.audio.gain', { audioId, gainDb: null, fadeInMs: null, fadeOutMs: null, ...extra })

interface Stored { loudness: number | null; peak: number | null; target: number | null; gain: number | null; duration: number | null }
const n = (v: unknown): number | null => (v == null ? null : Number(v))
async function stored(audioId: string): Promise<Stored> {
  const r = (await h.pg.query<Record<string, unknown>>(
    `SELECT loudness_lufs, true_peak_db, even_target_lufs, gain_db, duration_ms FROM cell_audio WHERE audio_id = $1`, [audioId],
  )).rows[0]
  return { loudness: n(r.loudness_lufs), peak: n(r.true_peak_db), target: n(r.even_target_lufs), gain: n(r.gain_db), duration: n(r.duration_ms) }
}

type ReadAtt = { loudnessLufs?: number; truePeakDb?: number; evenTargetLufs?: number; gainDb?: number; loudnessFromMs?: number; loudnessToMs?: number }
async function read(): Promise<Record<string, ReadAtt>> {
  const token = await makeTestToken(SECRET, { projectId: P, fileId: F })
  const res = await handleCellAudioReadRequest(
    new Request(`https://sync.invalid/api/v1/projects/${P}/files/${F}/audio-attachments`, { headers: { Authorization: `Bearer ${token}` } }),
    { AQUILLA_PG: h.db, SYNC_SECRET_KEY: SECRET },
  )
  const body = (await res!.json()) as { cells: Record<string, { attachments: Record<string, ReadAtt> }> }
  return body.cells[C].attachments
}

describe('a take\'s loudness (cell.audio.measure)', () => {
  it('stores the reading, and every device reads it back', async () => {
    await attach('take-a')
    await project('cell.audio.measure', { audioId: 'take-a', durationMs: 4_600, loudnessLufs: -27.4, truePeakDb: -9.2 })
    expect(await stored('take-a')).toMatchObject({ loudness: -27.4, peak: -9.2, duration: 4_600 })
    expect((await read())['take-a']).toMatchObject({ loudnessLufs: -27.4, truePeakDb: -9.2 })
  })

  it('is fill-only: a second reading changes nothing', async () => {
    await attach('take-a')
    await project('cell.audio.measure', { audioId: 'take-a', durationMs: 4_600, loudnessLufs: -27.4, truePeakDb: -9.2 })
    await project('cell.audio.measure', { audioId: 'take-a', durationMs: 4_600, loudnessLufs: -12, truePeakDb: -1 })
    expect(await stored('take-a')).toMatchObject({ loudness: -27.4, peak: -9.2 })
  })

  it('a duration-only measure (every client before AQU-2664) leaves the loudness alone', async () => {
    await attach('take-a')
    await project('cell.audio.measure', { audioId: 'take-a', durationMs: 4_600, loudnessLufs: -27.4, truePeakDb: -9.2 })
    await project('cell.audio.measure', { audioId: 'take-a', durationMs: 4_600 })
    expect(await stored('take-a')).toMatchObject({ loudness: -27.4, peak: -9.2 })
    await attach('take-b')
    await project('cell.audio.measure', { audioId: 'take-b', durationMs: 4_600 })
    expect(await stored('take-b')).toMatchObject({ loudness: null, peak: null })
    expect((await read())['take-b'].loudnessLufs).toBeUndefined()
  })

  // Review M4: a re-attach that swaps the audio is a new recording; the old
  // reading must not stay on it (the target waits for the next measure).
  it('a re-attach with a new url clears the reading and keeps the target; the same url keeps both', async () => {
    await attach('take-a')
    await project('cell.audio.measure', { audioId: 'take-a', durationMs: 4_600, loudnessLufs: -27.4, truePeakDb: -9.2 })
    await project('cell.audio.even', { audioId: 'take-a', evenTargetLufs: -16 })
    await attach('take-a') // the same url (a trim heal, word timings)
    expect(await stored('take-a')).toMatchObject({ loudness: -27.4, peak: -9.2, target: -16 })
    await project('cell.audio.attach', { audioId: 'take-a', url: 'https://r2.invalid/swapped', slot: 'recording', durationMs: 4_600 })
    expect(await stored('take-a')).toMatchObject({ loudness: null, peak: null, target: -16 })
    await project('cell.audio.measure', { audioId: 'take-a', durationMs: 4_600, loudnessLufs: -12, truePeakDb: -1.5 })
    expect(await stored('take-a')).toMatchObject({ loudness: -12, peak: -1.5 })
  })

  // Re-check S5: a measure never stores a duration of 0 (fill-only, it would
  // stay for good); a reading without a known duration leaves it out.
  it('a reading with no duration, or a duration of 0, leaves duration_ms alone', async () => {
    await project('cell.audio.attach', { audioId: 'take-z', url: 'https://r2.invalid/take-z', slot: 'recording', label: 'Take 1' })
    await project('cell.audio.measure', { audioId: 'take-z', durationMs: 0, loudnessLufs: -20, truePeakDb: -6 })
    expect(await stored('take-z')).toMatchObject({ duration: null, loudness: -20 })
    await project('cell.audio.measure', { audioId: 'take-z', loudnessLufs: -20, truePeakDb: -6, loudnessFromMs: 0, loudnessToMs: 1000 })
    expect(await stored('take-z')).toMatchObject({ duration: null })
    await project('cell.audio.measure', { audioId: 'take-z', durationMs: 4_200 })
    expect(await stored('take-z')).toMatchObject({ duration: 4_200 })
  })

  it('refuses a reading that is not a finite number', () => {
    const stmts: AquillaStatement[] = []
    expect(() => buildEventProjectionStmts(h.db, event('cell.audio.measure', { audioId: 'a', durationMs: 1, loudnessLufs: 'loud', truePeakDb: -3 }), stmts)).toThrow(/malformed/)
    expect(() => buildEventProjectionStmts(h.db, event('cell.audio.measure', { audioId: 'a', durationMs: 1, loudnessLufs: -20 }), stmts)).toThrow(/malformed/)
  })
})

// Sam, Nov 19: a reading belongs to the WINDOW of the recording it measured
// (a cut piece, an import's section). It records that window; a reading of
// another window replaces it, the same window again changes nothing.
describe('a reading of a window', () => {
  const win = async (audioId: string) => {
    const r = (await h.pg.query<Record<string, unknown>>(
      `SELECT loudness_from_ms, loudness_to_ms FROM cell_audio WHERE audio_id = $1`, [audioId])).rows[0]
    return [n(r.loudness_from_ms), n(r.loudness_to_ms)]
  }

  it('stores the window it measured, and every device reads it back', async () => {
    await attach('take-a')
    await project('cell.audio.measure', { audioId: 'take-a', durationMs: 4_600, loudnessLufs: -20, truePeakDb: -6, loudnessFromMs: 200, loudnessToMs: 3_000 })
    expect(await win('take-a')).toEqual([200, 3_000])
    expect((await read())['take-a']).toMatchObject({ loudnessLufs: -20, loudnessFromMs: 200, loudnessToMs: 3_000 })
  })

  it('a reading of another window replaces it; the same window again is a no-op', async () => {
    await attach('take-a')
    await project('cell.audio.measure', { audioId: 'take-a', durationMs: 4_600, loudnessLufs: -20, truePeakDb: -6, loudnessFromMs: 0, loudnessToMs: null })
    await project('cell.audio.measure', { audioId: 'take-a', durationMs: 4_600, loudnessLufs: -9, truePeakDb: -1, loudnessFromMs: 0, loudnessToMs: null })
    expect(await stored('take-a')).toMatchObject({ loudness: -20 })
    await project('cell.audio.measure', { audioId: 'take-a', durationMs: 4_600, loudnessLufs: -26, truePeakDb: -12, loudnessFromMs: 0, loudnessToMs: 2_000 })
    expect(await stored('take-a')).toMatchObject({ loudness: -26, peak: -12 })
    expect(await win('take-a')).toEqual([0, 2_000])
  })

  it('a cut leaves both pieces the whole take\'s reading, with its window, for the next Even out to refresh', async () => {
    await attach('take-a')
    await project('cell.audio.measure', { audioId: 'take-a', durationMs: 4_600, loudnessLufs: -20, truePeakDb: -6, loudnessFromMs: 0, loudnessToMs: null })
    await project('cell.audio.cut', { audioId: 'take-a', atMs: 2_000, newAudioId: 'take-b' })
    expect(await win('take-b')).toEqual([0, null])
    expect(await stored('take-b')).toMatchObject({ loudness: -20 })
  })

  it('a swapped recording clears the window with the reading', async () => {
    await attach('take-a')
    await project('cell.audio.measure', { audioId: 'take-a', durationMs: 4_600, loudnessLufs: -20, truePeakDb: -6, loudnessFromMs: 100, loudnessToMs: 900 })
    await project('cell.audio.attach', { audioId: 'take-a', url: 'https://r2.invalid/other', slot: 'recording', durationMs: 4_600 })
    expect(await win('take-a')).toEqual([null, null])
  })
})

describe('evening a take out (cell.audio.even)', () => {
  const even = (audioId: string, evenTargetLufs: number | null) => project('cell.audio.even', { audioId, evenTargetLufs })

  it('stores the target, and every device reads it back', async () => {
    await attach('take-a')
    await even('take-a', -16)
    expect((await stored('take-a')).target).toBe(-16)
    expect((await read())['take-a']).toMatchObject({ evenTargetLufs: -16 })
  })

  it("a run, a re-run and a clear never touch the take's own volume and fades, or its votes", async () => {
    await attach('take-a')
    await gain('take-a', { gainDb: -3, fadeInMs: 200, fadeOutMs: 400 })
    await project('cell.audio.validate', { audioId: 'take-a' })
    const level = async () => (await h.pg.query<Record<string, unknown>>(
      `SELECT gain_db, fade_in_ms, fade_out_ms, validator_count FROM cell_audio WHERE audio_id = 'take-a'`)).rows[0]
    const before = await level()
    await even('take-a', -16)
    expect(await level()).toEqual(before)
    await even('take-a', -23)
    expect(await level()).toEqual(before)
    expect((await stored('take-a')).target).toBe(-23)
    await even('take-a', null)
    expect(await level()).toEqual(before)
    expect((await stored('take-a')).target).toBeNull()
    expect((await read())['take-a'].evenTargetLufs).toBeUndefined()
  })

  it("the Station's volume line keeps the target", async () => {
    await attach('take-a')
    await even('take-a', -16)
    await gain('take-a', { gainDb: 3 })
    expect(await stored('take-a')).toMatchObject({ target: -16, gain: 3 })
  })

  it('refuses a target that is not a finite number', () => {
    const stmts: AquillaStatement[] = []
    expect(() => buildEventProjectionStmts(h.db, event('cell.audio.even', { audioId: 'a', evenTargetLufs: '-16' }), stmts)).toThrow(/malformed/)
  })

  it("a cut gives the second piece the take's reading and target (the same bytes)", async () => {
    await attach('take-a')
    await project('cell.audio.measure', { audioId: 'take-a', durationMs: 4_600, loudnessLufs: -27.4, truePeakDb: -9.2 })
    await even('take-a', -16)
    await project('cell.audio.cut', { audioId: 'take-a', atMs: 2_000, newAudioId: 'take-b' })
    expect(await stored('take-b')).toMatchObject({ loudness: -27.4, peak: -9.2, target: -16 })
  })
})

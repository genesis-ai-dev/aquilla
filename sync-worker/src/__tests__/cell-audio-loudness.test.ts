// AQU-2664: evening out the loudness of takes, non-destructively.
//
// Two facts are stored on the take (cell_audio, migration 0206):
//   - its recording's loudness and true peak, measured once in the browser and
//     sent on `cell.audio.measure` (fill-only, like its duration: the bytes of
//     an audio id never change, so a second reading has nothing to add);
//   - the target it is evened out to, sent on `cell.audio.gain` beside its
//     volume and fades. Absent = this event has no say about it (every client
//     before AQU-2664, and the Station's own volume line), so it is kept;
//     null clears it.
// The recording itself, its votes and everything else are untouched.
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

type ReadAtt = { loudnessLufs?: number; truePeakDb?: number; evenTargetLufs?: number; gainDb?: number }
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

  it('refuses a reading that is not a finite number', () => {
    const stmts: AquillaStatement[] = []
    expect(() => buildEventProjectionStmts(h.db, event('cell.audio.measure', { audioId: 'a', durationMs: 1, loudnessLufs: 'loud', truePeakDb: -3 }), stmts)).toThrow(/malformed/)
    expect(() => buildEventProjectionStmts(h.db, event('cell.audio.measure', { audioId: 'a', durationMs: 1, loudnessLufs: -20 }), stmts)).toThrow(/malformed/)
  })
})

describe('evening a take out (cell.audio.gain evenTargetLufs)', () => {
  it('stores the target beside its volume, and every device reads it back', async () => {
    await attach('take-a')
    await gain('take-a', { gainDb: -2, evenTargetLufs: -16 })
    expect(await stored('take-a')).toMatchObject({ target: -16, gain: -2 })
    expect((await read())['take-a']).toMatchObject({ evenTargetLufs: -16, gainDb: -2 })
  })

  it('a gain without the field (the Station\'s volume line, older clients) keeps the target', async () => {
    await attach('take-a')
    await gain('take-a', { evenTargetLufs: -16 })
    await gain('take-a', { gainDb: 3 })
    expect(await stored('take-a')).toMatchObject({ target: -16, gain: 3 })
  })

  it('null clears it (Clear, and the Undo of an even out)', async () => {
    await attach('take-a')
    await gain('take-a', { evenTargetLufs: -16 })
    await gain('take-a', { evenTargetLufs: null })
    expect((await stored('take-a')).target).toBeNull()
    expect((await read())['take-a'].evenTargetLufs).toBeUndefined()
  })

  it('refuses a target that is not a finite number', () => {
    const stmts: AquillaStatement[] = []
    expect(() => buildEventProjectionStmts(h.db, event('cell.audio.gain', { audioId: 'a', gainDb: null, fadeInMs: null, fadeOutMs: null, evenTargetLufs: '-16' }), stmts)).toThrow(/malformed/)
  })

  it('a cut gives the second piece the take\'s reading and target (the same bytes)', async () => {
    await attach('take-a')
    await project('cell.audio.measure', { audioId: 'take-a', durationMs: 4_600, loudnessLufs: -27.4, truePeakDb: -9.2 })
    await gain('take-a', { evenTargetLufs: -16 })
    await project('cell.audio.cut', { audioId: 'take-a', atMs: 2_000, newAudioId: 'take-b' })
    expect(await stored('take-b')).toMatchObject({ loudness: -27.4, peak: -9.2, target: -16 })
  })
})

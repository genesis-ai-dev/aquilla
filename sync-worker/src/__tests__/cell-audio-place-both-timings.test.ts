// AQU-2267 (Sam, Oct 29: "B makes the most sense"): a take's place carries
// across both timings.
//
// A take keeps one place per timing: `target_offset_ms` following the source,
// `recordings_offset_ms` following the recordings (NULL = the recordings
// timing reads the first one, as every take did before this). Both ride the
// one `cell.audio.place` event, so a move is one write, one undo step, and
// every device reads both back.
//
// Asserted on the ROWS and on the read route (real Postgres via PGlite), as the
// cut's tests are: what matters is what lands and what another device reads.
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { buildEventProjectionStmts, type PersistedEvent } from '../events/event-projection'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'
import { makeTestToken } from './helpers/auth'
import { handleCellAudioReadRequest } from '../events/cell-audio-read-route'
import type { EventKind } from '../events/types'

const P = 'proj-place'
const F = 'file-a'
const C = 'cell-1'
const SECRET = 'audio-place-secret'
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
  } as PersistedEvent<K>
}

async function project<K extends EventKind>(kind: K, payload: unknown): Promise<void> {
  const stmts: AquillaStatement[] = []
  buildEventProjectionStmts(h.db, event(kind, payload), stmts)
  await h.db.batch(stmts)
}

const attach = (audioId: string) =>
  project('cell.audio.attach', {
    audioId, url: `https://r2.invalid/${audioId}`, slot: 'recording', durationMs: 4_600, label: 'Take 1',
  })

const n = (v: string | number | null): number | null => (v == null ? null : Number(v))

async function stored(audioId: string): Promise<{ source: number | null; recordings: number | null }> {
  const r = (await h.pg.query<{ target_offset_ms: string | null; recordings_offset_ms: string | null }>(
    `SELECT target_offset_ms, recordings_offset_ms FROM cell_audio WHERE audio_id = $1`, [audioId],
  )).rows[0]
  return { source: n(r.target_offset_ms), recordings: n(r.recordings_offset_ms) }
}

/** What another device reads: the per-file audio read route. */
async function read(): Promise<Record<string, { targetOffsetMs: number | null; recordingsOffsetMs: number | null }>> {
  const token = await makeTestToken(SECRET, { projectId: P, fileId: F })
  const res = await handleCellAudioReadRequest(
    new Request(`https://sync.invalid/api/v1/projects/${P}/files/${F}/audio-attachments`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
    { AQUILLA_PG: h.db, SYNC_SECRET_KEY: SECRET },
  )
  const body = (await res!.json()) as {
    cells: Record<string, { attachments: Record<string, { targetOffsetMs: number | null; recordingsOffsetMs: number | null }> }>
  }
  return body.cells[C].attachments
}

describe('cell.audio.place — a take placed in both timings (AQU-2267)', () => {
  it('stores both places from one event, and every device reads both back', async () => {
    await attach('take-a')
    // The sermon example: 1.0 s before its line following the source, dragged
    // 0.2 s following the recordings → −0.8 s and +0.2 s.
    await project('cell.audio.place', { audioId: 'take-a', targetOffsetMs: -800, recordingsOffsetMs: 200 })
    expect(await stored('take-a')).toEqual({ source: -800, recordings: 200 })
    const att = (await read())['take-a']
    expect(att.targetOffsetMs).toBe(-800)
    expect(att.recordingsOffsetMs).toBe(200)
  })

  it('a take nobody has moved since AQU-2267 has no place of its own following the recordings', async () => {
    await attach('take-a')
    expect(await stored('take-a')).toEqual({ source: null, recordings: null })
    expect((await read())['take-a'].recordingsOffsetMs).toBeNull()
  })

  // An older client (a tab open from before the deploy) still sends the one
  // number it knows. Both timings then read that number, exactly as they did
  // before — rather than one of them keeping a place the move never saw.
  it('a place event that names only one place gives the take one place for both timings again', async () => {
    await attach('take-a')
    await project('cell.audio.place', { audioId: 'take-a', targetOffsetMs: -800, recordingsOffsetMs: 200 })
    await project('cell.audio.place', { audioId: 'take-a', targetOffsetMs: -1_000 })
    expect(await stored('take-a')).toEqual({ source: -1_000, recordings: null })
  })

  it('null clears both, back to "never placed by hand" — what undoing a first move asks for', async () => {
    await attach('take-a')
    await project('cell.audio.place', { audioId: 'take-a', targetOffsetMs: -800, recordingsOffsetMs: 200 })
    await project('cell.audio.place', { audioId: 'take-a', targetOffsetMs: null, recordingsOffsetMs: null })
    expect(await stored('take-a')).toEqual({ source: null, recordings: null })
  })

  it('zero is a real place in either timing, never "not placed"', async () => {
    await attach('take-a')
    await project('cell.audio.place', { audioId: 'take-a', targetOffsetMs: -1_500, recordingsOffsetMs: 0 })
    expect(await stored('take-a')).toEqual({ source: -1_500, recordings: 0 })
  })

  it('rounds a fractional place to whole ms, as the column holds', async () => {
    await attach('take-a')
    await project('cell.audio.place', { audioId: 'take-a', targetOffsetMs: -800, recordingsOffsetMs: 200.4 })
    expect((await stored('take-a')).recordings).toBe(200)
  })

  it('refuses a recordings place that is not a number, before anything is written', () => {
    for (const bad of ['200', Number.NaN, Number.POSITIVE_INFINITY, { ms: 200 }, true]) {
      const stmts: AquillaStatement[] = []
      expect(() =>
        buildEventProjectionStmts(h.db, event('cell.audio.place', { audioId: 'take-a', targetOffsetMs: 0, recordingsOffsetMs: bad }), stmts),
      ).toThrow(/recordingsOffsetMs/)
      expect(stmts).toHaveLength(0)
    }
  })

  it('a cut keeps both places on both pieces, so the second half sits where it sounded in each timing', async () => {
    await attach('take-a')
    await project('cell.audio.place', { audioId: 'take-a', targetOffsetMs: -800, recordingsOffsetMs: 200 })
    await project('cell.audio.cut', { audioId: 'take-a', atMs: 2_000, newAudioId: 'take-b' })
    expect(await stored('take-b')).toEqual({ source: -800, recordings: 200 })
    const atts = await read()
    expect([atts['take-b'].targetOffsetMs, atts['take-b'].recordingsOffsetMs]).toEqual([-800, 200])
  })
})

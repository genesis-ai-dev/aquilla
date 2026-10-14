// AQU-1767 phase 1: cutting a dub take into independent pieces.
//
// Asserted on the ROWS (real Postgres via PGlite), because every rule here is a
// property of what lands — which window each piece covers, which rows stay
// selected, whose votes survive — that a statement-shape test would pass while
// the data came out wrong.
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { buildEventProjectionStmts, type PersistedEvent } from '../events/event-projection'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'
import { makeTestToken } from './helpers/auth'
import { handleCellAudioReadRequest } from '../events/cell-audio-read-route'
import { AUDIO_CTE_SQL } from '../../../db/shared/audio-progress'
import type { EventKind } from '../events/types'

const P = 'proj-cut'
const F = 'file-a'
const C = 'cell-1'
const SECRET = 'audio-cut-secret'
const SRC_LANE = 'aa00bb11'
const DEFAULT_LANE = 'cc22dd33'

let h: TestDb
let seq = 0

beforeEach(async () => {
  if (!h) {
    h = await makeTestDb({
      lanes: [
        { id: SRC_LANE, project_id: P, role: 'source', name: 'Greek', lang_code: 'el', legacy_tag: null },
        { id: DEFAULT_LANE, project_id: P, role: 'target', name: 'Swahili', lang_code: 'sw', legacy_tag: '' },
      ],
    })
    return
  }
  await h.reset()
  await h.pg.exec(`INSERT INTO lanes (id, project_id, role, name, lang_code, legacy_tag) VALUES
    ('${SRC_LANE}', '${P}', 'source', 'Greek', 'el', NULL),
    ('${DEFAULT_LANE}', '${P}', 'target', 'Swahili', 'sw', '')`)
})

afterAll(async () => {
  await h?.close()
})

async function project<K extends EventKind>(
  kind: K,
  payload: unknown,
  overrides: Partial<PersistedEvent> = {},
): Promise<void> {
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

async function attach(audioId: string, opts: { role?: 'source' | 'dub'; durationMs?: number | null; slot?: string } = {}) {
  await project('cell.audio.attach', {
    audioId,
    url: `https://r2.invalid/${audioId}`,
    slot: opts.slot ?? 'recording',
    ...(opts.durationMs === null ? {} : { durationMs: opts.durationMs ?? 4_000 }),
    label: 'Take 1',
    ...(opts.role ? { role: opts.role } : {}),
  })
}

interface Row {
  audio_id: string
  url: string
  slot: string
  selected: number
  deleted: number
  trim_start_ms: string | number | null
  trim_end_ms: string | number | null
  validator_count: number
  piece_of: string | null
  label: string | null
  role: string
  lane_id: string | null
}

const rows = async (): Promise<Row[]> =>
  (await h.pg.query<Row>(
    `SELECT audio_id, url, slot, selected, deleted, trim_start_ms, trim_end_ms, validator_count,
            piece_of, label, role, lane_id
       FROM cell_audio ORDER BY audio_id`,
  )).rows

const n = (v: string | number | null): number | null => (v == null ? null : Number(v))

describe('cell.audio.cut', () => {
  it('splits one take into two pieces over the same bytes, both selected, both unvalidated', async () => {
    await attach('take-a')
    await project('cell.audio.validate', { audioId: 'take-a' }, { author: 'rev1' })
    expect((await rows())[0].validator_count).toBe(1)

    await project('cell.audio.cut', { audioId: 'take-a', atMs: 1_500, newAudioId: 'take-b', newLabel: 'Take 1 · 2', firstLabel: 'Take 1 · 1' })

    const [a, b] = await rows()
    expect(a.audio_id).toBe('take-a')
    expect([n(a.trim_start_ms), n(a.trim_end_ms)]).toEqual([null, 1_500])
    expect(a.label).toBe('Take 1 · 1')
    expect(a.piece_of).toBeNull()
    expect(a.validator_count).toBe(0)

    expect(b.audio_id).toBe('take-b')
    expect(b.url).toBe(a.url)
    expect(b.slot).toBe('recording')
    expect([n(b.trim_start_ms), n(b.trim_end_ms)]).toEqual([1_500, null])
    expect(b.piece_of).toBe('take-a')
    expect(b.label).toBe('Take 1 · 2')
    expect(b.lane_id).toBe(a.lane_id)
    expect(b.role).toBe('dub')
    expect([a.selected, b.selected]).toEqual([1, 1])
    expect(b.validator_count).toBe(0)

    const votes = await h.pg.query(`SELECT * FROM cell_audio_validators`)
    expect(votes.rows).toHaveLength(0)
  })

  it('keeps the end of an already-trimmed take on the second piece', async () => {
    await attach('take-a')
    await project('cell.audio.trim', { audioId: 'take-a', trimStartMs: 200, trimEndMs: 3_000 })
    await project('cell.audio.cut', { audioId: 'take-a', atMs: 1_000, newAudioId: 'take-b' })
    const [a, b] = await rows()
    expect([n(a.trim_start_ms), n(a.trim_end_ms)]).toEqual([200, 1_000])
    expect([n(b.trim_start_ms), n(b.trim_end_ms)]).toEqual([1_000, 3_000])
    // A second cut of the second piece keeps pointing at the ROOT.
    await project('cell.audio.cut', { audioId: 'take-b', atMs: 2_000, newAudioId: 'take-c' })
    const c = (await rows()).find((r) => r.audio_id === 'take-c')!
    expect(c.piece_of).toBe('take-a')
    expect([n(c.trim_start_ms), n(c.trim_end_ms)]).toEqual([2_000, 3_000])
  })

  it('refuses a cut too close to an edge, on source audio, or with no known end — and changes nothing', async () => {
    await attach('take-a')
    await project('cell.audio.validate', { audioId: 'take-a' }, { author: 'rev1' })
    await project('cell.audio.cut', { audioId: 'take-a', atMs: 50, newAudioId: 'x1' })
    await project('cell.audio.cut', { audioId: 'take-a', atMs: 3_950, newAudioId: 'x2' })
    let all = await rows()
    expect(all.map((r) => r.audio_id)).toEqual(['take-a'])
    expect(all[0].validator_count).toBe(1)
    expect(n(all[0].trim_end_ms)).toBeNull()

    await attach('src-1', { role: 'source' })
    await project('cell.audio.cut', { audioId: 'src-1', atMs: 1_000, newAudioId: 'x3' })
    await attach('nolen', { durationMs: null })
    await project('cell.audio.cut', { audioId: 'nolen', atMs: 1_000, newAudioId: 'x4' })
    all = await rows()
    expect(all.map((r) => r.audio_id).sort()).toEqual(['nolen', 'src-1', 'take-a'])
  })

  it('is replay-safe: delivering the same cut twice lands on the same rows', async () => {
    await attach('take-a')
    await project('cell.audio.cut', { audioId: 'take-a', atMs: 1_500, newAudioId: 'take-b' }, { id: 'evt-cut' })
    await project('cell.audio.cut', { audioId: 'take-a', atMs: 1_500, newAudioId: 'take-b' }, { id: 'evt-cut' })
    const all = await rows()
    expect(all).toHaveLength(2)
    expect(n(all[0].trim_end_ms)).toBe(1_500)
  })

  it('selection is per group: another take deselects both pieces, picking a piece brings back its live siblings', async () => {
    await attach('take-a')
    await project('cell.audio.cut', { audioId: 'take-a', atMs: 1_500, newAudioId: 'take-b' })
    await attach('take-z') // a new recording takes the slot
    let sel = Object.fromEntries((await rows()).map((r) => [r.audio_id, r.selected]))
    expect(sel).toEqual({ 'take-a': 0, 'take-b': 0, 'take-z': 1 })

    await project('cell.audio.select', { audioId: 'take-b', slot: 'recording' })
    sel = Object.fromEntries((await rows()).map((r) => [r.audio_id, r.selected]))
    expect(sel).toEqual({ 'take-a': 1, 'take-b': 1, 'take-z': 0 })

    // A removed piece stays removed when its sibling is picked again.
    await project('cell.audio.remove', { audioId: 'take-b' })
    await project('cell.audio.select', { audioId: 'take-a', slot: 'recording' })
    const b = (await rows()).find((r) => r.audio_id === 'take-b')!
    expect([b.deleted, b.selected]).toEqual([1, 0])
  })

  it("a routine re-attach of one piece never deselects the other", async () => {
    await attach('take-a')
    await project('cell.audio.cut', { audioId: 'take-a', atMs: 1_500, newAudioId: 'take-b' })
    await project('cell.audio.attach', { audioId: 'take-a', url: 'https://r2.invalid/take-a', slot: 'recording' })
    const sel = Object.fromEntries((await rows()).map((r) => [r.audio_id, r.selected]))
    expect(sel).toEqual({ 'take-a': 1, 'take-b': 1 })
  })

  it('progress needs EVERY piece validated: the weakest piece decides', async () => {
    await attach('take-a')
    await project('cell.audio.cut', { audioId: 'take-a', atMs: 1_500, newAudioId: 'take-b' })
    const votes = async () =>
      (await h.pg.query<{ dub_votes: number | null; has_dub: number }>(
        AUDIO_CTE_SQL.replace(/\?/g, (() => { let i = 0; return () => `$${++i}` })()),
        [P, F],
      )).rows[0]
    expect(Number((await votes()).dub_votes)).toBe(0)
    await project('cell.audio.validate', { audioId: 'take-a' }, { author: 'rev1' })
    expect(Number((await votes()).dub_votes)).toBe(0)
    await project('cell.audio.validate', { audioId: 'take-b' }, { author: 'rev1' })
    expect(Number((await votes()).dub_votes)).toBe(1)
  })

  it('the read shape carries pieceOf and points the slot at the earliest piece', async () => {
    await attach('take-a')
    await project('cell.audio.cut', { audioId: 'take-a', atMs: 1_500, newAudioId: 'take-b' })
    const token = await makeTestToken(SECRET, { projectId: P, fileId: F })
    const res = await handleCellAudioReadRequest(
      new Request(`https://sync.invalid/api/v1/projects/${P}/files/${F}/audio-attachments`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
      { AQUILLA_PG: h.db, SYNC_SECRET_KEY: SECRET },
    )
    const body = (await res!.json()) as {
      cells: Record<string, { attachments: Record<string, { pieceOf: string | null }>; selectedBySlot: Record<string, string> }>
    }
    const cell = body.cells[C]
    expect(cell.attachments['take-a'].pieceOf).toBeNull()
    expect(cell.attachments['take-b'].pieceOf).toBe('take-a')
    expect(cell.selectedBySlot.recording).toBe('take-a')
  })
})

// AQU-1767 (Sam, 2026-10-14): "Remove noise" on a split take keeps its cuts —
// the cleaned root is attached, then each other piece naming it.
describe('cell.audio.attach — a piece born into a group', () => {
  const cleaned = (audioId: string, extra: Record<string, unknown> = {}) =>
    project('cell.audio.attach', {
      audioId, url: 'https://r2.invalid/dn-clean', slot: 'recording', durationMs: 4_000, ...extra,
    })

  it('joins the group, and attaching it keeps its siblings selected while the old take is set aside', async () => {
    await attach('take-a')
    await project('cell.audio.cut', { audioId: 'take-a', atMs: 1_500, newAudioId: 'take-b' })
    await cleaned('dn-a', { trimEndMs: 1_500 })
    await cleaned('dn-b', { trimStartMs: 1_500, pieceOf: 'dn-a' })

    const by = Object.fromEntries((await rows()).map((r) => [r.audio_id, r]))
    expect(by['dn-b'].piece_of).toBe('dn-a')
    expect(by['dn-a'].piece_of).toBeNull()
    expect([by['dn-a'].selected, by['dn-b'].selected]).toEqual([1, 1])
    expect([by['take-a'].selected, by['take-b'].selected]).toEqual([0, 0])
    expect([n(by['dn-b'].trim_start_ms), n(by['dn-b'].trim_end_ms)]).toEqual([1_500, null])
  })

  it('never moves an existing take into or out of a group on a re-attach', async () => {
    await attach('take-a')
    await attach('take-z')
    await project('cell.audio.attach', { audioId: 'take-z', url: 'https://r2.invalid/take-z', slot: 'recording', pieceOf: 'take-a' })
    const z = (await rows()).find((r) => r.audio_id === 'take-z')!
    expect(z.piece_of).toBeNull()

    await project('cell.audio.cut', { audioId: 'take-a', atMs: 1_500, newAudioId: 'take-b' })
    await project('cell.audio.attach', { audioId: 'take-b', url: 'https://r2.invalid/take-a', slot: 'recording' })
    const b = (await rows()).find((r) => r.audio_id === 'take-b')!
    expect(b.piece_of).toBe('take-a')
  })
})

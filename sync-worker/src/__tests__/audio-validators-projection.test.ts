// AQU-490: the audio-validation write path, against real Postgres.
//
// A vote is on a TAKE, not on a cell — `cell_audio_validators` mirrors
// `cell_validators` minus the lane, because a recording is shared by every
// target language. These tests assert on the rows that actually land rather
// than on the SQL we emit, because three of the rules here are properties of
// the UPSERT/DELETE semantics (idempotence, the out-of-order guard, fill-only
// authorship) that a statement-shape assertion would happily pass while the
// data came out wrong.
import { describe, it, expect } from 'vitest'
import { buildEventProjectionStmts, type PersistedEvent } from '../events/event-projection'
import { makeTestDb } from './helpers/pg-test-db'
import { makeTestToken } from './helpers/auth'
import { handleCellAudioReadRequest } from '../events/cell-audio-read-route'
import { collapseCellAudioRows } from '../events/cell-audio-collapse'
import type { EventKind } from '../events/types'

const P = 'proj-1'
const F = 'file-a'
const C = 'cell-1'
const SECRET = 'audio-validators-secret'

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

/** Build and run one event's projection statements. */
async function project<K extends EventKind>(
  db: AquillaDb,
  kind: K,
  payload: unknown,
  overrides: Partial<PersistedEvent> = {},
): Promise<string[]> {
  const stmts: AquillaStatement[] = []
  const touches = buildEventProjectionStmts(db, makeEvent(kind, payload, overrides), stmts)
  await db.batch(stmts)
  return touches as unknown as string[]
}

interface ValidatorRow {
  project_id: string
  file_id: string
  cell_id: string
  audio_id: string
  username: string
  decided_ts: number
}

interface AudioRow {
  audio_id: string
  validator_count: number
  created_by: string | null
  role: string
  selected: number
}

/** A take on the cell, attached by `author`. */
async function attach(
  db: AquillaDb,
  audioId: string,
  opts: { author?: string; role?: 'dub' | 'source'; slot?: string; eventId?: string } = {},
) {
  await project(
    db,
    'cell.audio.attach',
    {
      audioId,
      url: `frontier-audio://${audioId}`,
      slot: opts.slot ?? 'recording',
      ...(opts.role ? { role: opts.role } : {}),
    },
    { author: opts.author ?? 'sam', id: opts.eventId ?? `evt-attach-${audioId}` },
  )
}

// ---------------------------------------------------------------------------
// cell.audio.validate
// ---------------------------------------------------------------------------

describe('cell.audio.validate', () => {
  it('writes one validator row and denormalizes the count onto the take', async () => {
    const { db, rows, close } = await makeTestDb()
    await attach(db, 'a1')

    const touches = await project(db, 'cell.audio.validate', { audioId: 'a1' }, { author: 'ana' })

    // Both tables must be named or the client invalidates one and not the
    // other — the count lives on cell_audio, the names on the validators table.
    expect(touches).toContain('cell_audio')
    expect(touches).toContain('cell_audio_validators')

    const votes = await rows<ValidatorRow>('cell_audio_validators')
    expect(votes).toHaveLength(1)
    expect(votes[0]).toMatchObject({
      project_id: P,
      file_id: F,
      cell_id: C,
      audio_id: 'a1',
      username: 'ana',
    })
    expect(Number(votes[0].decided_ts)).toBe(2_000)

    const audio = await rows<AudioRow>('cell_audio')
    expect(audio[0].validator_count).toBe(1)
    await close()
  })

  it('counts two people on the same take', async () => {
    const { db, rows, close } = await makeTestDb()
    await attach(db, 'a1')

    await project(db, 'cell.audio.validate', { audioId: 'a1' }, { author: 'ana', id: 'e-ana' })
    await project(db, 'cell.audio.validate', { audioId: 'a1' }, { author: 'bo', id: 'e-bo' })

    const audio = await rows<AudioRow>('cell_audio')
    expect(audio[0].validator_count).toBe(2)
    await close()
  })

  // The count is re-derived with a COUNT rather than incremented, so replaying
  // the log — which the projection rebuild does on every deploy — cannot drift
  // it. An increment would read 2 here for one person.
  it('is idempotent: the same person validating twice still counts once', async () => {
    const { db, rows, close } = await makeTestDb()
    await attach(db, 'a1')

    await project(db, 'cell.audio.validate', { audioId: 'a1' }, { author: 'ana', id: 'e1' })
    await project(
      db,
      'cell.audio.validate',
      { audioId: 'a1' },
      { author: 'ana', id: 'e2', serverTs: 5_000 },
    )

    const votes = await rows<ValidatorRow>('cell_audio_validators')
    expect(votes).toHaveLength(1)
    expect(Number(votes[0].decided_ts)).toBe(5_000)
    expect((await rows<AudioRow>('cell_audio'))[0].validator_count).toBe(1)
    await close()
  })

  // Events replay in server_seq order on a rebuild but arrive in any order over
  // the wire, so an older duplicate must not wind the timestamp back — the
  // "when did you decide this" readout would jump backwards.
  it('never winds decided_ts backwards on an out-of-order replay', async () => {
    const { db, rows, close } = await makeTestDb()
    await attach(db, 'a1')

    await project(
      db,
      'cell.audio.validate',
      { audioId: 'a1' },
      { author: 'ana', id: 'e-new', serverTs: 9_000 },
    )
    await project(
      db,
      'cell.audio.validate',
      { audioId: 'a1' },
      { author: 'ana', id: 'e-old', serverTs: 1_000 },
    )

    const votes = await rows<ValidatorRow>('cell_audio_validators')
    expect(Number(votes[0].decided_ts)).toBe(9_000)
    await close()
  })

  it('keeps votes on sibling takes separate', async () => {
    const { db, rows, close } = await makeTestDb()
    await attach(db, 'a1')
    await attach(db, 'a2', { slot: 'track-2' })

    await project(db, 'cell.audio.validate', { audioId: 'a1' }, { author: 'ana', id: 'e1' })

    const audio = await rows<AudioRow>('cell_audio')
    const byId = Object.fromEntries(audio.map((r) => [r.audio_id, r.validator_count]))
    expect(byId).toEqual({ a1: 1, a2: 0 })
    await close()
  })
})

// ---------------------------------------------------------------------------
// cell.audio.unvalidate
// ---------------------------------------------------------------------------

describe('cell.audio.unvalidate', () => {
  it('removes the caller’s own vote and leaves everyone else’s', async () => {
    const { db, rows, close } = await makeTestDb()
    await attach(db, 'a1')
    await project(db, 'cell.audio.validate', { audioId: 'a1' }, { author: 'ana', id: 'e1' })
    await project(db, 'cell.audio.validate', { audioId: 'a1' }, { author: 'bo', id: 'e2' })

    await project(db, 'cell.audio.unvalidate', { audioId: 'a1' }, { author: 'ana', id: 'e3' })

    const votes = await rows<ValidatorRow>('cell_audio_validators')
    expect(votes.map((v) => v.username)).toEqual(['bo'])
    expect((await rows<AudioRow>('cell_audio'))[0].validator_count).toBe(1)
    await close()
  })

  // A maintainer stripping somebody else's vote names them. The role gate is in
  // route.ts; by the time an event is persisted the question is settled, so the
  // projection simply honours the field.
  it('removes the named person’s vote when targetUsername is given', async () => {
    const { db, rows, close } = await makeTestDb()
    await attach(db, 'a1')
    await project(db, 'cell.audio.validate', { audioId: 'a1' }, { author: 'ana', id: 'e1' })
    await project(db, 'cell.audio.validate', { audioId: 'a1' }, { author: 'bo', id: 'e2' })

    await project(
      db,
      'cell.audio.unvalidate',
      { audioId: 'a1', targetUsername: 'bo' },
      { author: 'maintainer', id: 'e3' },
    )

    const votes = await rows<ValidatorRow>('cell_audio_validators')
    expect(votes.map((v) => v.username)).toEqual(['ana'])
    await close()
  })

  it('falls back to the author when targetUsername is blank', async () => {
    const { db, rows, close } = await makeTestDb()
    await attach(db, 'a1')
    await project(db, 'cell.audio.validate', { audioId: 'a1' }, { author: 'ana', id: 'e1' })

    await project(
      db,
      'cell.audio.unvalidate',
      { audioId: 'a1', targetUsername: '   ' },
      { author: 'ana', id: 'e2' },
    )

    expect(await rows<ValidatorRow>('cell_audio_validators')).toHaveLength(0)
    expect((await rows<AudioRow>('cell_audio'))[0].validator_count).toBe(0)
    await close()
  })

  it('is a no-op when the person never validated', async () => {
    const { db, rows, close } = await makeTestDb()
    await attach(db, 'a1')
    await project(db, 'cell.audio.validate', { audioId: 'a1' }, { author: 'ana', id: 'e1' })

    await project(db, 'cell.audio.unvalidate', { audioId: 'a1' }, { author: 'nobody', id: 'e2' })

    expect((await rows<AudioRow>('cell_audio'))[0].validator_count).toBe(1)
    await close()
  })
})

// ---------------------------------------------------------------------------
// cell.audio.trim
// ---------------------------------------------------------------------------

describe('cell.audio.trim keeps the take’s votes', () => {
  // REVERSED 2026-09-21. This block used to assert the opposite, on the
  // reasoning that a trim changes what a validator heard. Sam's call after
  // using it: it is the same take — no new id, no resampling, just a playback
  // window moved a fraction of a second to clip a breath — and throwing away
  // everyone's sign-off for that is not defensible. Denoise remains the real
  // derived case and needs no rule here at all: it mints a `dn-` id, so its
  // take is simply a different take with no votes yet.
  it('leaves every vote in place and does not touch the count', async () => {
    const { db, rows, close } = await makeTestDb()
    await attach(db, 'a1')
    await project(db, 'cell.audio.validate', { audioId: 'a1' }, { author: 'ana', id: 'e1' })
    await project(db, 'cell.audio.validate', { audioId: 'a1' }, { author: 'bo', id: 'e2' })

    const touches = await project(
      db,
      'cell.audio.trim',
      { audioId: 'a1', trimStartMs: 120, trimEndMs: null },
      { id: 'e3' },
    )

    // Not merely "the rows survive": trim must not even CLAIM the validators
    // table, or every trim in a timeline drag invalidates those caches for
    // nothing.
    expect(touches).not.toContain('cell_audio_validators')
    expect(await rows<ValidatorRow>('cell_audio_validators')).toHaveLength(2)
    expect((await rows<AudioRow>('cell_audio'))[0].validator_count).toBe(2)
    await close()
  })

  it('touches neither take’s votes when one of two is trimmed', async () => {
    const { db, rows, close } = await makeTestDb()
    await attach(db, 'a1')
    await attach(db, 'a2', { slot: 'track-2' })
    await project(db, 'cell.audio.validate', { audioId: 'a1' }, { author: 'ana', id: 'e1' })
    await project(db, 'cell.audio.validate', { audioId: 'a2' }, { author: 'ana', id: 'e2' })

    await project(db, 'cell.audio.trim', { audioId: 'a1', trimStartMs: 50, trimEndMs: null }, { id: 'e3' })

    const votes = await rows<ValidatorRow>('cell_audio_validators')
    expect(votes.map((v) => v.audio_id).sort()).toEqual(['a1', 'a2'])
    await close()
  })
})

// ---------------------------------------------------------------------------
// cell.audio.attach — role and created_by
// ---------------------------------------------------------------------------

describe('cell.audio.attach records provenance', () => {
  it('defaults role to dub and stamps the recorder', async () => {
    const { db, rows, close } = await makeTestDb()
    await attach(db, 'a1', { author: 'ana' })

    const audio = await rows<AudioRow>('cell_audio')
    expect(audio[0]).toMatchObject({ role: 'dub', created_by: 'ana' })
    await close()
  })

  // The imported programme audio. It sits SELECTED in the recording slot on
  // every cell of a media file, so without this column "selected" would mean
  // "a dub exists here" and every media project would be gated on somebody
  // validating the untranslated source.
  it('records role=source when the import says so', async () => {
    const { db, rows, close } = await makeTestDb()
    await attach(db, 'src', { role: 'source', author: 'importer' })

    expect((await rows<AudioRow>('cell_audio'))[0].role).toBe('source')
    await close()
  })

  // THE FILL-ONLY RULE. A re-attach is routine: the transcription lands ~800ms
  // after every recording, trims persist, timings refresh — each carrying the
  // author of whoever triggered it. Assigning created_by on conflict would hand
  // a take's authorship to the last person who touched it, and on a project
  // with self-validation off that would then refuse the real recorder
  // permission to validate their own take.
  it('does not let a re-attach steal authorship', async () => {
    const { db, rows, close } = await makeTestDb()
    await attach(db, 'a1', { author: 'ana' })

    // The transcription re-attach, triggered by a reviewer who opened the cell.
    await project(
      db,
      'cell.audio.attach',
      {
        audioId: 'a1',
        url: 'frontier-audio://a1',
        slot: 'recording',
        timings: [{ word: 'hello', t0: 0, t1: 1, start: 0, end: 1 }],
      },
      { author: 'reviewer', id: 'evt-reattach' },
    )

    const audio = await rows<AudioRow>('cell_audio')
    expect(audio).toHaveLength(1)
    expect(audio[0]).toMatchObject({ created_by: 'ana', role: 'dub' })
    await close()
  })

  it('backfills authorship on a re-attach when the first attach predates the column', async () => {
    const { db, pg, rows, close } = await makeTestDb()
    await attach(db, 'a1', { author: 'ana' })
    // A row as it exists on a project that has not run the rollout script:
    // role defaulted to 'dub' by the migration, no recorder recorded.
    await pg.query(`UPDATE cell_audio SET created_by = NULL`)

    await project(
      db,
      'cell.audio.attach',
      { audioId: 'a1', url: 'frontier-audio://a1', slot: 'recording' },
      { author: 'bo', id: 'evt-reattach' },
    )

    expect((await rows<AudioRow>('cell_audio'))[0]).toMatchObject({ created_by: 'bo', role: 'dub' })
    await close()
  })

  // role is NOT NULL, so the migration gave every pre-0096 row 'dub' — the
  // shared programme audio of every media file included. The rollout script
  // repairs those from the audio-id convention, but it is a heuristic; a
  // re-import states the answer outright and must be allowed to correct it.
  it('promotes a mis-classified row to source when a re-import says so', async () => {
    const { db, rows, close } = await makeTestDb()
    await attach(db, 'src') // the pre-0096 state: defaulted to dub

    await attach(db, 'src', { role: 'source', author: 'importer', eventId: 'evt-reimport' })

    expect((await rows<AudioRow>('cell_audio'))[0].role).toBe('source')
    await close()
  })

  // The other direction is the dangerous one. Every routine re-attach binds
  // 'dub' because it says nothing about role at all, so a demotion here would
  // let a transcription silently reclassify the programme audio and gate every
  // cell of that file on somebody validating the untranslated source.
  it('never demotes a source clip back to dub on a routine re-attach', async () => {
    const { db, rows, close } = await makeTestDb()
    await attach(db, 'src', { role: 'source', author: 'importer' })

    await project(
      db,
      'cell.audio.attach',
      {
        audioId: 'src',
        url: 'frontier-audio://src',
        slot: 'recording',
        timings: [{ word: 'hello', t0: 0, t1: 1, start: 0, end: 1 }],
      },
      { author: 'transcriber', id: 'evt-reattach' },
    )

    expect((await rows<AudioRow>('cell_audio'))[0].role).toBe('source')
    await close()
  })
})

// ---------------------------------------------------------------------------
// The read route, against real Postgres.
//
// The route's own suite drives a stub that returns canned rows, so it cannot
// see the SQL at all. These go through the statement itself, because the trap
// here is a shape trap: joining cell_audio_validators plainly returns one row
// per (take, validator), and the collapse keys attachments by audio_id — so a
// take with two validators would arrive twice, the last row would silently
// win, and nothing would look wrong until somebody read a duration off it.
// ---------------------------------------------------------------------------

describe('the audio-attachments read carries votes', () => {
  const read = async (db: AquillaDb) => {
    const token = await makeTestToken(SECRET, { projectId: P, fileId: F })
    const res = (await handleCellAudioReadRequest(
      new Request(`https://w/api/v1/projects/${P}/files/${F}/audio-attachments`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
      { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET },
    ))!
    expect(res.status).toBe(200)
    return (await res.json()) as {
      cells: Record<string, { attachments: Record<string, {
        validatorCount: number; validators: string[]; role: string
        recordedBy: string | null; durationMs: number | null
      }> }>
    }
  }

  it('returns each take once, with its count, its validators and its provenance', async () => {
    const { db, rows, close } = await makeTestDb()
    await attach(db, 'a1', { author: 'ana' })
    await project(db, 'cell.audio.validate', { audioId: 'a1' }, { author: 'bo', id: 'e1', serverTs: 10 })
    await project(db, 'cell.audio.validate', { audioId: 'a1' }, { author: 'cy', id: 'e2', serverTs: 20 })

    const body = await read(db)
    const takes = body.cells[C].attachments
    // ONE entry, not two. This is the assertion the whole lateral exists for.
    expect(Object.keys(takes)).toEqual(['a1'])
    expect(takes.a1.validatorCount).toBe(2)
    // Newest vote first.
    expect(takes.a1.validators).toEqual(['cy', 'bo'])
    expect(takes.a1.role).toBe('dub')
    expect(takes.a1.recordedBy).toBe('ana')
    expect((await rows<AudioRow>('cell_audio'))[0].validator_count).toBe(2)
    await close()
  })

  it('reports an unvalidated take as zero votes and an empty list, never null', async () => {
    const { db, close } = await makeTestDb()
    await attach(db, 'a1', { author: 'ana' })

    const takes = (await read(db)).cells[C].attachments
    expect(takes.a1.validatorCount).toBe(0)
    expect(takes.a1.validators).toEqual([])
    await close()
  })

  it('carries role=source through, so the client can refuse to count it', async () => {
    const { db, close } = await makeTestDb()
    await attach(db, 'src', { role: 'source', author: 'importer' })

    expect((await read(db)).cells[C].attachments.src.role).toBe('source')
    await close()
  })
})

// ---------------------------------------------------------------------------
// The validators array, as it actually arrives.
//
// ARRAY_AGG comes back as a real array through some drivers and as Postgres's
// own literal — `{ana,bo}`, or `{}` when empty — through others. Measured on
// the LIVE dev worker it was the literal, which no unit test had caught
// because PGlite hands back a parsed array. A reader doing
// `validators.includes(me)` against the literal is asking a STRING whether it
// contains a substring: false for "ana" and true for "a".
// ---------------------------------------------------------------------------

describe('the validator list survives either driver', () => {
  const row = (validators: unknown) => ({
    cell_id: C, audio_id: 'a1', slot: 'recording', url: 'u', mime_type: null,
    voice_id: null, reference_audio_id: null, duration_ms: null, label: null,
    trim_start_ms: null, trim_end_ms: null, target_offset_ms: null,
    timings_json: null, selected: 1, created_ts: 1, validator_count: 2,
    validators,
  }) as unknown as Parameters<typeof collapseCellAudioRows>[0][number]

  const names = (validators: unknown) =>
    collapseCellAudioRows([row(validators)])[C].attachments.a1.validators

  it('parses a Postgres array literal', () => {
    expect(names('{ana,bo}')).toEqual(['ana', 'bo'])
  })

  it('reads an empty literal as an empty list, not as one blank name', () => {
    expect(names('{}')).toEqual([])
  })

  it('strips the quotes Postgres adds around awkward values', () => {
    expect(names('{"ana b",bo}')).toEqual(['ana b', 'bo'])
  })

  it('passes a real array straight through', () => {
    expect(names(['ana', 'bo'])).toEqual(['ana', 'bo'])
  })

  it('treats a missing list as nobody', () => {
    expect(names(undefined)).toEqual([])
    expect(names(null)).toEqual([])
  })
})

// Tests for server-side enforcement of project-level validation configuration (AQU-189):
//
//   cell.validate:
//     - validationRoleFloor: reject if caller's role < floor
//     - validationNamedUsers: reject if caller not in allowlist
//     - allowSelfValidation=false: reject if caller is the cell's last_editor
//     - happy path: reviewer(300) validates a cell authored by someone else
//     - no settings row: validate is accepted (no restrictions)
//
// All tests go through handleEventsWriteRequest (full route layer).

import { describe, it, expect, vi } from 'vitest'

vi.mock('partyserver', () => ({
  getServerByName: vi.fn().mockResolvedValue({
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  }),
}))

import { handleEventsWriteRequest } from '../events/route'
import { makeTestDb } from './helpers/pg-test-db'
import { makeTestToken } from './helpers/auth'
import type { RawEvent } from '../events/types'

const SECRET = 'test-secret'

async function makeToken(role: number, username = 'alice'): Promise<string> {
  return makeTestToken(SECRET, {
    projectId: 'proj-v',
    fileId: 'file-v',
    role,
    username,
  } as any)
}

async function makeRequest(events: unknown[], token: string): Promise<Request> {
  return new Request('https://worker/events', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ events }),
  })
}

function makeEnv(db: AquillaDb) {
  return { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET }
}

async function postEvent(db: AquillaDb, event: RawEvent, token: string): Promise<void> {
  const res = await handleEventsWriteRequest(await makeRequest([event], token), makeEnv(db))
  const body = (await res!.json()) as any
  expect(
    body.rejected,
    `event ${event.id} should be accepted but was rejected: ${JSON.stringify(body.rejected)}`,
  ).toHaveLength(0)
  expect(body.accepted).toHaveLength(1)
}

/** Seed a file and a target cell authored by `author` (default 'alice'). */
async function seedFileAndCell(db: AquillaDb, author = 'alice'): Promise<void> {
  const ownerToken = await makeToken(700, 'owner')
  const fileEvt: RawEvent<'file.create'> = {
    id: 'evt-file-v-seed',
    schemaVersion: 1,
    kind: 'file.create',
    projectId: 'proj-v',
    fileId: 'file-v',
    cellId: undefined,
    parentId: null,
    author: 'owner',
    payload: { name: 'Validation Test File', fileType: 'codex' },
    clientTs: 0,
  }
  await postEvent(db, fileEvt, ownerToken)

  const contributorToken = await makeToken(400, author)
  const cellEvt: RawEvent<'target.cell.create'> = {
    id: 'evt-cell-v-seed',
    schemaVersion: 1,
    kind: 'target.cell.create',
    projectId: 'proj-v',
    fileId: 'file-v',
    cellId: 'cell-v1',
    parentId: null,
    author,
    payload: { cellId: 'cell-v1', value: 'translation text' },
    clientTs: 100,
  }
  await postEvent(db, cellEvt, contributorToken)
}

/** Write project settings JSON directly to the project_settings table. */
async function setProjectSettings(
  db: AquillaDb,
  settings: Record<string, unknown>,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO project_settings (project_id, settings, version, updated_at)
       VALUES (?, ?, 1, CURRENT_TIMESTAMP)
       ON CONFLICT (project_id)
       DO UPDATE SET settings = excluded.settings, version = project_settings.version + 1`,
    )
    .bind('proj-v', JSON.stringify(settings))
    .run()
}

function makeValidateEvent(id: string, author: string): RawEvent<'cell.validate'> {
  return {
    id,
    schemaVersion: 1,
    kind: 'cell.validate',
    projectId: 'proj-v',
    fileId: 'file-v',
    cellId: 'cell-v1',
    parentId: 'evt-cell-v-seed',
    author,
    payload: { editEventId: 'evt-cell-v-seed' },
    clientTs: 200,
  }
}

// ── Happy path (no settings) ──────────────────────────────────────────────

describe('cell.validate — no project settings', () => {
  it('reviewer(300) can validate with no settings row', async () => {
    const { db } = await makeTestDb()
    await seedFileAndCell(db, 'alice')

    const bobToken = await makeToken(300, 'bob')
    const res = await handleEventsWriteRequest(
      await makeRequest([makeValidateEvent('evt-val-noset', 'bob')], bobToken),
      makeEnv(db),
    )
    const body = (await res!.json()) as any
    expect(body.accepted).toHaveLength(1)
    expect(body.rejected).toHaveLength(0)
  })
})

// ── validationRoleFloor ───────────────────────────────────────────────────

describe('cell.validate — validationRoleFloor enforcement', () => {
  it('rejects reviewer(300) when floor is project_lead(500)', async () => {
    const { db } = await makeTestDb()
    await seedFileAndCell(db, 'alice')
    await setProjectSettings(db, { validationRoleFloor: 'project_lead' })

    const bobToken = await makeToken(300, 'bob')
    const res = await handleEventsWriteRequest(
      await makeRequest([makeValidateEvent('evt-val-floor-reject', 'bob')], bobToken),
      makeEnv(db),
    )
    const body = (await res!.json()) as any
    expect(body.rejected).toHaveLength(1)
    expect(body.rejected[0].status).toBe(403)
    expect(body.rejected[0].reason).toMatch(/role too low to validate/)
    expect(body.accepted).toHaveLength(0)
  })

  it('accepts project_lead(500) when floor is project_lead(500)', async () => {
    const { db } = await makeTestDb()
    await seedFileAndCell(db, 'alice')
    await setProjectSettings(db, { validationRoleFloor: 'project_lead' })

    const plToken = await makeToken(500, 'carol')
    const res = await handleEventsWriteRequest(
      await makeRequest([makeValidateEvent('evt-val-floor-accept', 'carol')], plToken),
      makeEnv(db),
    )
    const body = (await res!.json()) as any
    expect(body.accepted).toHaveLength(1)
    expect(body.rejected).toHaveLength(0)
  })

  it('rejects reviewer(300) when floor is maintainer(600)', async () => {
    const { db } = await makeTestDb()
    await seedFileAndCell(db, 'alice')
    await setProjectSettings(db, { validationRoleFloor: 'maintainer' })

    const bobToken = await makeToken(300, 'bob')
    const res = await handleEventsWriteRequest(
      await makeRequest([makeValidateEvent('evt-val-floor-maint', 'bob')], bobToken),
      makeEnv(db),
    )
    const body = (await res!.json()) as any
    expect(body.rejected).toHaveLength(1)
    expect(body.rejected[0].status).toBe(403)
  })

  it('accepts reviewer(300) when floor is reviewer(300)', async () => {
    const { db } = await makeTestDb()
    await seedFileAndCell(db, 'alice')
    await setProjectSettings(db, { validationRoleFloor: 'reviewer' })

    const bobToken = await makeToken(300, 'bob')
    const res = await handleEventsWriteRequest(
      await makeRequest([makeValidateEvent('evt-val-floor-rev', 'bob')], bobToken),
      makeEnv(db),
    )
    const body = (await res!.json()) as any
    expect(body.accepted).toHaveLength(1)
    expect(body.rejected).toHaveLength(0)
  })
})

// ── validationNamedUsers ──────────────────────────────────────────────────

describe('cell.validate — validationNamedUsers allowlist enforcement', () => {
  it('rejects a user not in the allowlist', async () => {
    const { db } = await makeTestDb()
    await seedFileAndCell(db, 'alice')
    await setProjectSettings(db, { validationNamedUsers: ['eve', 'frank'] })

    const bobToken = await makeToken(300, 'bob')
    const res = await handleEventsWriteRequest(
      await makeRequest([makeValidateEvent('evt-val-named-reject', 'bob')], bobToken),
      makeEnv(db),
    )
    const body = (await res!.json()) as any
    expect(body.rejected).toHaveLength(1)
    expect(body.rejected[0].status).toBe(403)
    expect(body.rejected[0].reason).toMatch(/not in the project's validator allowlist/)
  })

  it('accepts a user in the allowlist', async () => {
    const { db } = await makeTestDb()
    await seedFileAndCell(db, 'alice')
    await setProjectSettings(db, { validationNamedUsers: ['bob', 'carol'] })

    const bobToken = await makeToken(300, 'bob')
    const res = await handleEventsWriteRequest(
      await makeRequest([makeValidateEvent('evt-val-named-accept', 'bob')], bobToken),
      makeEnv(db),
    )
    const body = (await res!.json()) as any
    expect(body.accepted).toHaveLength(1)
    expect(body.rejected).toHaveLength(0)
  })

  it('empty allowlist imposes no restriction', async () => {
    const { db } = await makeTestDb()
    await seedFileAndCell(db, 'alice')
    await setProjectSettings(db, { validationNamedUsers: [] })

    const bobToken = await makeToken(300, 'bob')
    const res = await handleEventsWriteRequest(
      await makeRequest([makeValidateEvent('evt-val-named-empty', 'bob')], bobToken),
      makeEnv(db),
    )
    const body = (await res!.json()) as any
    expect(body.accepted).toHaveLength(1)
    expect(body.rejected).toHaveLength(0)
  })
})

// ── allowSelfValidation ───────────────────────────────────────────────────

describe('cell.validate — allowSelfValidation=false enforcement', () => {
  it('rejects self-validation when allowSelfValidation=false', async () => {
    const { db } = await makeTestDb()
    // alice authored the cell
    await seedFileAndCell(db, 'alice')
    await setProjectSettings(db, { allowSelfValidation: false })

    // alice tries to validate her own cell
    const aliceToken = await makeToken(300, 'alice')
    const res = await handleEventsWriteRequest(
      await makeRequest([makeValidateEvent('evt-val-self-reject', 'alice')], aliceToken),
      makeEnv(db),
    )
    const body = (await res!.json()) as any
    expect(body.rejected).toHaveLength(1)
    expect(body.rejected[0].status).toBe(403)
    expect(body.rejected[0].reason).toMatch(/self-validation is not allowed/)
  })

  it('allows a different user to validate when allowSelfValidation=false', async () => {
    const { db } = await makeTestDb()
    await seedFileAndCell(db, 'alice')
    await setProjectSettings(db, { allowSelfValidation: false })

    // bob validates alice's cell — allowed
    const bobToken = await makeToken(300, 'bob')
    const res = await handleEventsWriteRequest(
      await makeRequest([makeValidateEvent('evt-val-self-other', 'bob')], bobToken),
      makeEnv(db),
    )
    const body = (await res!.json()) as any
    expect(body.accepted).toHaveLength(1)
    expect(body.rejected).toHaveLength(0)
  })

  it('allows self-validation when allowSelfValidation=true (explicit)', async () => {
    const { db } = await makeTestDb()
    await seedFileAndCell(db, 'alice')
    await setProjectSettings(db, { allowSelfValidation: true })

    const aliceToken = await makeToken(300, 'alice')
    const res = await handleEventsWriteRequest(
      await makeRequest([makeValidateEvent('evt-val-self-true', 'alice')], aliceToken),
      makeEnv(db),
    )
    const body = (await res!.json()) as any
    expect(body.accepted).toHaveLength(1)
    expect(body.rejected).toHaveLength(0)
  })

  it('allows self-validation when allowSelfValidation is not set', async () => {
    const { db } = await makeTestDb()
    await seedFileAndCell(db, 'alice')
    // no settings at all

    const aliceToken = await makeToken(300, 'alice')
    const res = await handleEventsWriteRequest(
      await makeRequest([makeValidateEvent('evt-val-self-unset', 'alice')], aliceToken),
      makeEnv(db),
    )
    const body = (await res!.json()) as any
    expect(body.accepted).toHaveLength(1)
    expect(body.rejected).toHaveLength(0)
  })
})

// ── AQU-1571: the self-validation check against a hostile client ──────────
//
// Three ways past FRO-189's check, each proven before it was closed: an edit
// and its own vote in ONE request (the last editor is read before the batch),
// a vote cast on an edit id before committing under it (event ids are the
// client's to choose), and a cell translated in two lanes (the last editor
// was read per cell, so one lane was judged by the other's editor).

function makeCommitEvent(
  id: string, author: string, value: string, targetLang?: string,
): RawEvent<'target.cell.commit'> {
  return {
    id, schemaVersion: 1, kind: 'target.cell.commit',
    projectId: 'proj-v', fileId: 'file-v', cellId: 'cell-v1',
    parentId: 'evt-cell-v-seed', author,
    payload: { value, ...(targetLang ? { targetLang } : {}) },
    clientTs: 150,
  }
}

function makeValidateOf(
  id: string, author: string, editEventId: string, targetLang?: string,
): RawEvent<'cell.validate'> {
  return {
    ...makeValidateEvent(id, author),
    parentId: null,
    payload: { editEventId, ...(targetLang ? { targetLang } : {}) },
  }
}

async function targetRow(db: AquillaDb, lane = '') {
  return db
    .prepare(
      `SELECT event_id, last_editor, validated FROM cells
        WHERE project_id = 'proj-v' AND cell_id = 'cell-v1' AND side = 'target' AND target_lang = ?`,
    )
    .bind(lane)
    .first<{ event_id: string; last_editor: string; validated: number }>()
}

describe('cell.validate — self-validation against a hostile client (AQU-1571)', () => {
  it('refuses a vote on an edit made in the SAME request', async () => {
    const { db } = await makeTestDb()
    await seedFileAndCell(db, 'alice')
    await setProjectSettings(db, { allowSelfValidation: false })

    const res = await handleEventsWriteRequest(
      await makeRequest(
        [makeCommitEvent('evt-bob-edit', 'bob', 'bob text'), makeValidateOf('evt-bob-vote', 'bob', 'evt-bob-edit')],
        await makeToken(400, 'bob'),
      ),
      makeEnv(db),
    )
    const body = (await res!.json()) as any
    expect(body.accepted.map((a: { id: string }) => a.id)).toEqual(['evt-bob-edit'])
    expect(body.rejected).toEqual([
      { id: 'evt-bob-vote', status: 403, reason: 'self-validation is not allowed on this project' },
    ])
    expect((await targetRow(db))?.validated).toBe(0)
  })

  it('refuses a vote on an edit the server has never seen, so it cannot count when committed later', async () => {
    const { db } = await makeTestDb()
    await seedFileAndCell(db, 'alice')
    await setProjectSettings(db, { allowSelfValidation: false, validationCount: 2 })

    const early = await post(db, makeValidateOf('evt-pre-vote', 'bob', 'evt-future-edit'), await makeToken(400, 'bob'))
    expect(early.rejected).toEqual([
      {
        id: 'evt-pre-vote',
        status: 403,
        reason: 'validating an edit before it is saved is not allowed on this project',
      },
    ])

    // Before AQU-1571 bob's early vote sat pinned to this id, and carol's vote
    // recounted it: two validators, one of them the author.
    await postEvent(db, makeCommitEvent('evt-future-edit', 'bob', 'bob text'), await makeToken(400, 'bob'))
    await postEvent(db, makeValidateOf('evt-carol-vote', 'carol', 'evt-future-edit'), await makeToken(300, 'carol'))
    expect((await targetRow(db))?.validated).toBe(0)
  })

  it('judges the lane being validated by THAT lane’s editor', async () => {
    const { db } = await makeTestDb()
    await seedFileAndCell(db, 'alice')
    await setProjectSettings(db, { allowSelfValidation: false, targetLanes: ['es'] })
    // AQU-1532: a named lane takes writes only once its lane row exists.
    await db.prepare(
      `INSERT INTO lanes (id, project_id, role, name, lang_code, legacy_tag, position)
       VALUES ('lane-es', 'proj-v', 'target', 'Spanish', 'es', 'es', 2)`,
    ).run()
    await postEvent(db, makeCommitEvent('evt-bob-es', 'bob', 'hola', 'es'), await makeToken(400, 'bob'))

    const bobToken = await makeToken(400, 'bob')
    // alice's default-lane work: bob is somebody else there.
    const other = await post(db, makeValidateOf('evt-vote-default', 'bob', 'evt-cell-v-seed'), bobToken)
    expect(other.rejected).toEqual([])
    // bob's own Spanish: refused.
    const own = await post(db, makeValidateOf('evt-vote-es', 'bob', 'evt-bob-es', 'es'), bobToken)
    expect(own.rejected).toEqual([
      { id: 'evt-vote-es', status: 403, reason: 'self-validation is not allowed on this project' },
    ])
  })

  // The "seen" test must not refuse the ordinary case on data that predates
  // the event log: a head the projection holds is an edit the server knows,
  // whether or not its event row exists.
  it('still accepts a vote on the current head when its event row is missing', async () => {
    const { db } = await makeTestDb({
      files: [{ id: 'file-v', project_id: 'proj-v', name: 'F', event_id: 'evt-file-legacy' }],
      cells: [
        {
          project_id: 'proj-v', file_id: 'file-v', cell_id: 'cell-v1', side: 'target',
          value: 'legacy text', event_id: 'evt-legacy-head', last_editor: 'alice', last_edit_at: 1,
        },
      ],
    })
    await setProjectSettings(db, { allowSelfValidation: false })

    const body = await post(db, makeValidateOf('evt-vote-legacy', 'bob', 'evt-legacy-head'), await makeToken(300, 'bob'))
    expect(body.rejected).toEqual([])
    expect((await targetRow(db))?.validated).toBe(1)
  })

  it('still lets somebody else validate an edit that has just landed', async () => {
    const { db } = await makeTestDb()
    await seedFileAndCell(db, 'alice')
    await setProjectSettings(db, { allowSelfValidation: false })
    await postEvent(db, makeCommitEvent('evt-bob-edit2', 'bob', 'bob text'), await makeToken(400, 'bob'))

    const body = await post(db, makeValidateOf('evt-carol-vote2', 'carol', 'evt-bob-edit2'), await makeToken(300, 'carol'))
    expect(body.rejected).toEqual([])
    expect((await targetRow(db))?.validated).toBe(1)
  })
})

// ── Combined settings ─────────────────────────────────────────────────────

describe('cell.validate — combined settings', () => {
  it('rejects when all three conditions are configured and caller fails role check', async () => {
    const { db } = await makeTestDb()
    await seedFileAndCell(db, 'alice')
    await setProjectSettings(db, {
      validationRoleFloor: 'project_lead',
      validationNamedUsers: ['carol'],
      allowSelfValidation: false,
    })

    // bob is reviewer(300), not in named list, not the author — but role check fires first
    const bobToken = await makeToken(300, 'bob')
    const res = await handleEventsWriteRequest(
      await makeRequest([makeValidateEvent('evt-val-combined-reject', 'bob')], bobToken),
      makeEnv(db),
    )
    const body = (await res!.json()) as any
    expect(body.rejected).toHaveLength(1)
    expect(body.rejected[0].status).toBe(403)
    expect(body.rejected[0].reason).toMatch(/role too low to validate/)
  })

  it('accepts when caller meets all conditions', async () => {
    const { db } = await makeTestDb()
    await seedFileAndCell(db, 'alice')
    await setProjectSettings(db, {
      validationRoleFloor: 'reviewer',
      validationNamedUsers: ['bob'],
      allowSelfValidation: false,
    })

    // bob is reviewer(300), in named list, and NOT alice (the author)
    const bobToken = await makeToken(300, 'bob')
    const res = await handleEventsWriteRequest(
      await makeRequest([makeValidateEvent('evt-val-combined-accept', 'bob')], bobToken),
      makeEnv(db),
    )
    const body = (await res!.json()) as any
    expect(body.accepted).toHaveLength(1)
    expect(body.rejected).toHaveLength(0)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// AQU-490 — the audio twin of everything above.
//
// The gates are the same three, read from SEPARATE keys. That separation is
// the thing most worth pinning: a project can want two ears on a recording
// and one on a translation, or trust a different set of people with each, so
// neither set of keys may be read as a fallback for the other.
// ──────────────────────────────────────────────────────────────────────────

/** Attach a take to the seeded cell, recorded by `author`. */
async function seedTake(db: AquillaDb, audioId: string, author: string): Promise<void> {
  const token = await makeToken(400, author)
  const evt: RawEvent<'cell.audio.attach'> = {
    id: `evt-attach-${audioId}`,
    schemaVersion: 1,
    kind: 'cell.audio.attach',
    projectId: 'proj-v',
    fileId: 'file-v',
    cellId: 'cell-v1',
    parentId: null,
    author,
    payload: { audioId, url: `frontier-audio://${audioId}.wav`, slot: 'recording' },
    clientTs: 150,
  }
  await postEvent(db, evt, token)
}

function makeAudioValidateEvent(id: string, author: string, audioId = 'take-1'): RawEvent<'cell.audio.validate'> {
  return {
    id, schemaVersion: 1, kind: 'cell.audio.validate',
    projectId: 'proj-v', fileId: 'file-v', cellId: 'cell-v1',
    parentId: null, author, payload: { audioId }, clientTs: 200,
  }
}

function makeAudioUnvalidateEvent(
  id: string, author: string, payload: Record<string, unknown>,
): RawEvent<'cell.audio.unvalidate'> {
  return {
    id, schemaVersion: 1, kind: 'cell.audio.unvalidate',
    projectId: 'proj-v', fileId: 'file-v', cellId: 'cell-v1',
    parentId: null, author, payload, clientTs: 300,
  } as RawEvent<'cell.audio.unvalidate'>
}

async function post(db: AquillaDb, event: RawEvent, token: string) {
  const res = await handleEventsWriteRequest(await makeRequest([event], token), makeEnv(db))
  return (await res!.json()) as any
}

describe('cell.audio.validate — audio validation config', () => {
  it('accepts a reviewer with no settings row', async () => {
    const { db } = await makeTestDb()
    await seedFileAndCell(db, 'alice')
    await seedTake(db, 'take-1', 'alice')

    const body = await post(db, makeAudioValidateEvent('evt-av-1', 'bob'), await makeToken(300, 'bob'))
    expect(body.rejected).toHaveLength(0)
    expect(body.accepted).toHaveLength(1)
  })

  it('rejects a reviewer when the audio floor is project_lead', async () => {
    const { db } = await makeTestDb()
    await seedFileAndCell(db, 'alice')
    await seedTake(db, 'take-1', 'alice')
    await setProjectSettings(db, { validationRoleFloorAudio: 'project_lead' })

    const body = await post(db, makeAudioValidateEvent('evt-av-2', 'bob'), await makeToken(300, 'bob'))
    expect(body.rejected).toHaveLength(1)
    expect(body.rejected[0].status).toBe(403)
    expect(body.rejected[0].reason).toMatch(/role too low to validate audio/)
  })

  it('rejects someone outside the audio allowlist', async () => {
    const { db } = await makeTestDb()
    await seedFileAndCell(db, 'alice')
    await seedTake(db, 'take-1', 'alice')
    await setProjectSettings(db, { validationNamedUsersAudio: ['carol'] })

    const body = await post(db, makeAudioValidateEvent('evt-av-3', 'bob'), await makeToken(300, 'bob'))
    expect(body.rejected[0].reason).toMatch(/audio validator allowlist/)
  })

  // THE RECORDER, not the event author and not the cell's last editor. A take
  // is re-attached routinely — the transcription lands ~800ms after every
  // recording — so anything derived from the latest event would name whoever
  // last touched it.
  it('rejects the recorder validating their own take when self-validation is off', async () => {
    const { db } = await makeTestDb()
    await seedFileAndCell(db, 'alice')
    await seedTake(db, 'take-1', 'bob')
    await setProjectSettings(db, { allowSelfValidationAudio: false })

    const body = await post(db, makeAudioValidateEvent('evt-av-4', 'bob'), await makeToken(300, 'bob'))
    expect(body.rejected).toHaveLength(1)
    expect(body.rejected[0].reason).toMatch(/validating your own recording/)
  })

  // THE BATCH CASE, and the one that matters most: the recorder's own save.
  // The modal enqueues the attach and its auto-validation back to back with
  // no server ack between them, and the flusher posts them in ONE request.
  // The gate read cell_audio in a pre-pass, where a row this same request is
  // about to create cannot exist — so it silently passed on the single path
  // it exists to guard (adversarial review, 2026-09-22).
  it('rejects self-validation of a take attached in the SAME request', async () => {
    const { db } = await makeTestDb()
    await seedFileAndCell(db, 'alice')
    await setProjectSettings(db, { allowSelfValidationAudio: false })

    const attach: RawEvent = {
      id: 'evt-attach-batch', schemaVersion: 1, kind: 'cell.audio.attach',
      projectId: 'proj-v', fileId: 'file-v', cellId: 'cell-v1', parentId: null,
      author: 'bob', payload: { audioId: 'fresh-1', url: 'frontier-audio://fresh-1.webm', slot: 'recording' },
      clientTs: 199,
    } as RawEvent
    const res = await handleEventsWriteRequest(
      await makeRequest([attach, makeAudioValidateEvent('evt-av-batch', 'bob', 'fresh-1')], await makeToken(400, 'bob')),
      makeEnv(db),
    )
    const body = (await res!.json()) as any
    const ids = (body.rejected ?? []).map((r: { id: string }) => r.id)
    expect(ids).toContain('evt-av-batch')
    // The attach itself is legitimate — only the vote on it is refused.
    expect(ids).not.toContain('evt-attach-batch')
  })

  // The fallback must not refuse everybody. One request carries one token, so
  // a take it CREATES is always the caller's — but a take it RE-attaches (the
  // transcription re-attach, ~800ms after the recording) keeps its stored
  // recorder, and somebody else may vote on it in that same request.
  //
  // AQU-1571: this used to post a "bob" attach under carol's token and expect
  // carol's vote through. That only passed because the gate trusted the
  // attach's claimed author; the server stores such a take as carol's.
  it('still lets somebody ELSE validate a take re-attached in the same request', async () => {
    const { db } = await makeTestDb()
    await seedFileAndCell(db, 'alice')
    await seedTake(db, 'take-2', 'bob')
    await setProjectSettings(db, { allowSelfValidationAudio: false })

    const reattach: RawEvent = {
      id: 'evt-reattach-batch2', schemaVersion: 1, kind: 'cell.audio.attach',
      projectId: 'proj-v', fileId: 'file-v', cellId: 'cell-v1', parentId: null,
      author: 'carol', payload: { audioId: 'take-2', url: 'frontier-audio://take-2.wav', slot: 'recording' },
      clientTs: 199,
    } as RawEvent
    const res = await handleEventsWriteRequest(
      await makeRequest([reattach, makeAudioValidateEvent('evt-av-batch2', 'carol', 'take-2')], await makeToken(400, 'carol')),
      makeEnv(db),
    )
    const body = (await res!.json()) as any
    expect(body.rejected ?? []).toEqual([])
    const row = await db
      .prepare(`SELECT created_by FROM cell_audio WHERE audio_id = 'take-2'`)
      .bind()
      .first<{ created_by: string | null }>()
    expect(row?.created_by).toBe('bob')
  })

  it('still lets somebody else validate that take', async () => {
    const { db } = await makeTestDb()
    await seedFileAndCell(db, 'alice')
    await seedTake(db, 'take-1', 'bob')
    await setProjectSettings(db, { allowSelfValidationAudio: false })

    const body = await post(db, makeAudioValidateEvent('evt-av-5', 'carol'), await makeToken(300, 'carol'))
    expect(body.rejected).toHaveLength(0)
  })

  // AQU-1571: the same-request fallback read the attach's `author` field,
  // which is the CLIENT'S claim. The stored recorder is the token's username,
  // so naming somebody else on the attach let the recorder vote for their own
  // take in the same request.
  it('does not trust the author an attach claims: a take attached in the request is the caller’s', async () => {
    const { db } = await makeTestDb()
    await seedFileAndCell(db, 'alice')
    await setProjectSettings(db, { allowSelfValidationAudio: false })

    const spoofed: RawEvent = {
      id: 'evt-attach-spoof', schemaVersion: 1, kind: 'cell.audio.attach',
      projectId: 'proj-v', fileId: 'file-v', cellId: 'cell-v1', parentId: null,
      author: 'carol', payload: { audioId: 'fresh-s', url: 'frontier-audio://fresh-s.webm', slot: 'recording' },
      clientTs: 199,
    } as RawEvent
    const res = await handleEventsWriteRequest(
      await makeRequest([spoofed, makeAudioValidateEvent('evt-av-spoof', 'bob', 'fresh-s')], await makeToken(400, 'bob')),
      makeEnv(db),
    )
    const body = (await res!.json()) as any
    const refusal = (body.rejected ?? []).find((r: { id: string }) => r.id === 'evt-av-spoof')
    expect(refusal?.reason).toMatch(/validating your own recording/)
    // The take really is bob's: the server stamps the token's user, not the claim.
    const row = await db
      .prepare(`SELECT created_by FROM cell_audio WHERE audio_id = 'fresh-s'`)
      .bind()
      .first<{ created_by: string | null }>()
    expect(row?.created_by).toBe('bob')
  })

  it('refuses a vote placed AHEAD of its take’s attach in the same request', async () => {
    const { db } = await makeTestDb()
    await seedFileAndCell(db, 'alice')
    await setProjectSettings(db, { allowSelfValidationAudio: false })

    const attach: RawEvent = {
      id: 'evt-attach-late', schemaVersion: 1, kind: 'cell.audio.attach',
      projectId: 'proj-v', fileId: 'file-v', cellId: 'cell-v1', parentId: null,
      author: 'bob', payload: { audioId: 'fresh-l', url: 'frontier-audio://fresh-l.webm', slot: 'recording' },
      clientTs: 201,
    } as RawEvent
    const res = await handleEventsWriteRequest(
      await makeRequest([makeAudioValidateEvent('evt-av-early', 'bob', 'fresh-l'), attach], await makeToken(400, 'bob')),
      makeEnv(db),
    )
    const body = (await res!.json()) as any
    expect((body.rejected ?? []).map((r: { id: string }) => r.id)).toContain('evt-av-early')
  })

  // AQU-1571: the vote row is keyed by audio id whether or not the take
  // exists, and audio ids are the client's to choose. Voting first and
  // recording afterwards made the recorder's own vote count as soon as any
  // other vote recounted the take — here, meeting a threshold of two with
  // one independent ear.
  it('refuses a vote on a take that has not been saved, so it cannot count for its recorder later', async () => {
    const { db } = await makeTestDb()
    await seedFileAndCell(db, 'alice')
    await setProjectSettings(db, { allowSelfValidationAudio: false, validationCountAudio: 2 })

    const early = await post(db, makeAudioValidateEvent('evt-av-pre', 'bob', 'future-take'), await makeToken(400, 'bob'))
    expect(early.rejected).toHaveLength(1)
    expect(early.rejected[0].status).toBe(403)
    expect(early.rejected[0].reason).toMatch(/before it is saved/)

    await seedTake(db, 'future-take', 'bob')
    const other = await post(db, makeAudioValidateEvent('evt-av-other', 'carol', 'future-take'), await makeToken(300, 'carol'))
    expect(other.rejected).toHaveLength(0)
    const row = await db
      .prepare(`SELECT validator_count FROM cell_audio WHERE audio_id = 'future-take'`)
      .bind()
      .first<{ validator_count: number }>()
    expect(row?.validator_count).toBe(1)
  })

  // Every write path, not just the browser's: the Agent API's commits re-enter
  // this route on a token minted with `src: 'external'` (token-bridge.ts), and
  // nothing in these gates may treat that channel differently.
  it('holds an Agent API token to the same three audio gates', async () => {
    const external = (role: number, username: string) =>
      makeTestToken(SECRET, { projectId: 'proj-v', fileId: 'file-v', role, username, src: 'external' } as any)

    const floor = await makeTestDb()
    await seedFileAndCell(floor.db, 'alice')
    await seedTake(floor.db, 'take-1', 'alice')
    await setProjectSettings(floor.db, { validationRoleFloorAudio: 'maintainer' })
    const a = await post(floor.db, makeAudioValidateEvent('evt-av-x1', 'bob'), await external(500, 'bob'))
    expect(a.rejected[0]?.reason).toMatch(/role too low to validate audio/)

    const named = await makeTestDb()
    await seedFileAndCell(named.db, 'alice')
    await seedTake(named.db, 'take-1', 'alice')
    await setProjectSettings(named.db, { validationNamedUsersAudio: ['carol'] })
    const b = await post(named.db, makeAudioValidateEvent('evt-av-x2', 'bob'), await external(600, 'bob'))
    expect(b.rejected[0]?.reason).toMatch(/audio validator allowlist/)

    const self = await makeTestDb()
    await seedFileAndCell(self.db, 'alice')
    await seedTake(self.db, 'take-1', 'bob')
    await setProjectSettings(self.db, { allowSelfValidationAudio: false })
    const c = await post(self.db, makeAudioValidateEvent('evt-av-x3', 'bob'), await external(600, 'bob'))
    expect(c.rejected[0]?.reason).toMatch(/validating your own recording/)
  })

  // A take whose attach event is gone — a pruned history, or a project the
  // rollout script has not reached — has a NULL recorder. Unknown must not
  // silently equal the caller, or self-validation-off would lock everyone out
  // of exactly the oldest takes.
  it('treats an unknown recorder as unknown, not as the caller', async () => {
    const { db } = await makeTestDb()
    await seedFileAndCell(db, 'alice')
    await seedTake(db, 'take-1', 'bob')
    await db.prepare('UPDATE cell_audio SET created_by = NULL').bind().run()
    await setProjectSettings(db, { allowSelfValidationAudio: false })

    const body = await post(db, makeAudioValidateEvent('evt-av-6', 'bob'), await makeToken(300, 'bob'))
    expect(body.rejected).toHaveLength(0)
  })

  // THE SEPARATION, both directions.
  it('does not let the TEXT policy gate an audio validate', async () => {
    const { db } = await makeTestDb()
    await seedFileAndCell(db, 'bob')
    await seedTake(db, 'take-1', 'alice')
    await setProjectSettings(db, {
      validationRoleFloor: 'maintainer',
      validationNamedUsers: ['nobody'],
      allowSelfValidation: false,
    })

    const body = await post(db, makeAudioValidateEvent('evt-av-7', 'bob'), await makeToken(300, 'bob'))
    expect(body.rejected).toHaveLength(0)
  })

  it('does not let the AUDIO policy gate a text validate', async () => {
    const { db } = await makeTestDb()
    await seedFileAndCell(db, 'alice')
    await setProjectSettings(db, {
      validationRoleFloorAudio: 'maintainer',
      validationNamedUsersAudio: ['nobody'],
      allowSelfValidationAudio: false,
    })

    const body = await post(db, makeValidateEvent('evt-tv-1', 'bob'), await makeToken(300, 'bob'))
    expect(body.rejected).toHaveLength(0)
  })
})

describe('cell.audio.unvalidate — removing somebody else’s vote', () => {
  it('lets anyone who could vote remove their OWN', async () => {
    const { db } = await makeTestDb()
    await seedFileAndCell(db, 'alice')
    await seedTake(db, 'take-1', 'alice')

    const body = await post(
      db, makeAudioUnvalidateEvent('evt-au-1', 'bob', { audioId: 'take-1' }), await makeToken(300, 'bob'),
    )
    expect(body.rejected).toHaveLength(0)
  })

  it('rejects a reviewer stripping another user’s vote', async () => {
    const { db } = await makeTestDb()
    await seedFileAndCell(db, 'alice')
    await seedTake(db, 'take-1', 'alice')

    const body = await post(
      db,
      makeAudioUnvalidateEvent('evt-au-2', 'bob', { audioId: 'take-1', targetUsername: 'carol' }),
      await makeToken(300, 'bob'),
    )
    expect(body.rejected).toHaveLength(1)
    expect(body.rejected[0].status).toBe(403)
    expect(body.rejected[0].reason).toMatch(/only a maintainer/)
  })

  it('lets a maintainer strip another user’s vote', async () => {
    const { db } = await makeTestDb()
    await seedFileAndCell(db, 'alice')
    await seedTake(db, 'take-1', 'alice')

    const body = await post(
      db,
      makeAudioUnvalidateEvent('evt-au-3', 'mary', { audioId: 'take-1', targetUsername: 'carol' }),
      await makeToken(600, 'mary'),
    )
    expect(body.rejected).toHaveLength(0)
  })

  // AQU-1571: the policy gates are on CASTING a vote. Somebody whose standing
  // a project has since withdrawn (floor raised, dropped from the list, their
  // own recording) must still be able to take their vote back.
  it('lets a voter withdraw their own vote under the strictest audio policy', async () => {
    const { db } = await makeTestDb()
    await seedFileAndCell(db, 'alice')
    await seedTake(db, 'take-1', 'bob')
    await post(db, makeAudioValidateEvent('evt-au-cast', 'bob'), await makeToken(300, 'bob'))
    await setProjectSettings(db, {
      validationRoleFloorAudio: 'maintainer',
      validationNamedUsersAudio: ['nobody'],
      allowSelfValidationAudio: false,
    })

    const body = await post(
      db, makeAudioUnvalidateEvent('evt-au-own', 'bob', { audioId: 'take-1' }), await makeToken(300, 'bob'),
    )
    expect(body.rejected).toHaveLength(0)
    const votes = await db
      .prepare(`SELECT username FROM cell_audio_validators WHERE audio_id = 'take-1'`)
      .bind()
      .all<{ username: string }>()
    expect(votes.results).toEqual([])
  })

  // Naming yourself is not "somebody else's vote" — the gate reads the field,
  // so it has to compare rather than merely check for presence.
  it('lets a reviewer name themselves', async () => {
    const { db } = await makeTestDb()
    await seedFileAndCell(db, 'alice')
    await seedTake(db, 'take-1', 'alice')

    const body = await post(
      db,
      makeAudioUnvalidateEvent('evt-au-4', 'bob', { audioId: 'take-1', targetUsername: 'bob' }),
      await makeToken(300, 'bob'),
    )
    expect(body.rejected).toHaveLength(0)
  })

})

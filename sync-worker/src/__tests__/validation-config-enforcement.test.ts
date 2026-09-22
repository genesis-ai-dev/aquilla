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

  it('still lets somebody ELSE validate a take attached in the same request', async () => {
    const { db } = await makeTestDb()
    await seedFileAndCell(db, 'alice')
    await setProjectSettings(db, { allowSelfValidationAudio: false })

    const attach: RawEvent = {
      id: 'evt-attach-batch2', schemaVersion: 1, kind: 'cell.audio.attach',
      projectId: 'proj-v', fileId: 'file-v', cellId: 'cell-v1', parentId: null,
      author: 'bob', payload: { audioId: 'fresh-2', url: 'frontier-audio://fresh-2.webm', slot: 'recording' },
      clientTs: 199,
    } as RawEvent
    const res = await handleEventsWriteRequest(
      await makeRequest([attach, makeAudioValidateEvent('evt-av-batch2', 'carol', 'fresh-2')], await makeToken(400, 'carol')),
      makeEnv(db),
    )
    const body = (await res!.json()) as any
    expect((body.rejected ?? []).map((r: { id: string }) => r.id)).not.toContain('evt-av-batch2')
  })

  it('still lets somebody else validate that take', async () => {
    const { db } = await makeTestDb()
    await seedFileAndCell(db, 'alice')
    await seedTake(db, 'take-1', 'bob')
    await setProjectSettings(db, { allowSelfValidationAudio: false })

    const body = await post(db, makeAudioValidateEvent('evt-av-5', 'carol'), await makeToken(300, 'carol'))
    expect(body.rejected).toHaveLength(0)
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

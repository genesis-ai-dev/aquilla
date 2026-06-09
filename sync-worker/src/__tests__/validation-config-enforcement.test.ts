// Tests for server-side enforcement of project-level validation configuration (FRO-189):
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

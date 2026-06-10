// Tests for server-side enforcement of harmonize_min_role (FRO-186).
//
// A target.cell.commit with harmonize_origin payload is the cell.commit.harmonize
// variant per AD-2. The server enforces harmonize_min_role from project_settings:
//   - No settings row → project_lead(500) hard floor (default)
//   - harmonize_min_role = 'project_lead' → floor is 500
//   - harmonize_min_role = 'maintainer'   → floor is 600
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
const PROJECT = 'proj-h'
const FILE = 'file-h'
const CELL = 'cell-h1'

async function makeToken(role: number, username = 'alice'): Promise<string> {
  return makeTestToken(SECRET, { projectId: PROJECT, fileId: FILE, role, username } as any)
}

async function makeRequest(events: unknown[], token: string): Promise<Request> {
  return new Request('https://worker/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
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
    `event ${event.id} should be accepted: ${JSON.stringify(body.rejected)}`,
  ).toHaveLength(0)
}

/** Seed file + cell so parent-chain for harmonize events resolves. */
async function seedFileAndCell(db: AquillaDb): Promise<void> {
  const ownerToken = await makeToken(700, 'owner')
  await postEvent(db, {
    id: 'evt-h-file',
    schemaVersion: 1,
    kind: 'file.create',
    projectId: PROJECT,
    fileId: FILE,
    parentId: null,
    author: 'owner',
    payload: { name: 'Harmonize Test', fileType: 'codex' },
    clientTs: 0,
  } as RawEvent<'file.create'>, ownerToken)

  const plToken = await makeToken(500, 'lead')
  await postEvent(db, {
    id: 'evt-h-cell',
    schemaVersion: 1,
    kind: 'target.cell.commit',
    projectId: PROJECT,
    fileId: FILE,
    cellId: CELL,
    parentId: null,
    author: 'lead',
    payload: { value: 'original translation' },
    clientTs: 100,
  } as RawEvent<'target.cell.commit'>, plToken)
}

async function setProjectSettings(db: AquillaDb, settings: Record<string, unknown>): Promise<void> {
  await db
    .prepare(
      `INSERT INTO project_settings (project_id, settings, version, updated_at)
       VALUES (?, ?, 1, CURRENT_TIMESTAMP)
       ON CONFLICT (project_id)
       DO UPDATE SET settings = excluded.settings, version = project_settings.version + 1`,
    )
    .bind(PROJECT, JSON.stringify(settings))
    .run()
}

function makeHarmonizeEvent(id: string, author: string, role = 500): RawEvent<'target.cell.commit'> {
  return {
    id,
    schemaVersion: 1,
    kind: 'target.cell.commit',
    projectId: PROJECT,
    fileId: FILE,
    cellId: CELL,
    // parent is the seeded cell commit
    parentId: 'evt-h-cell',
    author,
    payload: {
      value: 'harmonized translation',
      harmonize_origin: {
        rule_or_check_id: 'builtin:double-space',
        proposal_kind: 'batch-regex',
      },
    },
    clientTs: 200,
  }
}

// ── No settings (hard floor = project_lead 500) ───────────────────────────

describe('cell.commit.harmonize — no project settings', () => {
  it('project_lead(500) can harmonize with no settings row', async () => {
    const { db } = await makeTestDb()
    await seedFileAndCell(db)

    const plToken = await makeToken(500, 'lead')
    const res = await handleEventsWriteRequest(
      await makeRequest([makeHarmonizeEvent('evt-harm-noset-pl', 'lead')], plToken),
      makeEnv(db),
    )
    const body = (await res!.json()) as any
    expect(body.accepted).toHaveLength(1)
    expect(body.rejected).toHaveLength(0)
  })

  it('contributor(400) is rejected even with no settings row (hard floor 500)', async () => {
    const { db } = await makeTestDb()
    await seedFileAndCell(db)

    const contribToken = await makeToken(400, 'bob')
    const res = await handleEventsWriteRequest(
      await makeRequest([makeHarmonizeEvent('evt-harm-noset-contrib', 'bob')], contribToken),
      makeEnv(db),
    )
    const body = (await res!.json()) as any
    expect(body.rejected).toHaveLength(1)
    expect(body.rejected[0].status).toBe(403)
    expect(body.rejected[0].reason).toMatch(/role too low to harmonize/)
  })
})

// ── harmonize_min_role = 'project_lead' ───────────────────────────────────

describe("cell.commit.harmonize — harmonize_min_role = 'project_lead'", () => {
  it('project_lead(500) is accepted', async () => {
    const { db } = await makeTestDb()
    await seedFileAndCell(db)
    await setProjectSettings(db, { harmonize_min_role: 'project_lead' })

    const plToken = await makeToken(500, 'lead')
    const res = await handleEventsWriteRequest(
      await makeRequest([makeHarmonizeEvent('evt-harm-pl-accept', 'lead')], plToken),
      makeEnv(db),
    )
    const body = (await res!.json()) as any
    expect(body.accepted).toHaveLength(1)
    expect(body.rejected).toHaveLength(0)
  })

  it('reviewer(300) is rejected (fails base role gate for target.cell.commit, CONTRIBUTOR=400)', async () => {
    // reviewer(300) is below CONTRIBUTOR(400) — rejected by the base auth gate
    // before the harmonize-specific check is reached. The important invariant is
    // that the event is rejected with 403.
    const { db } = await makeTestDb()
    await seedFileAndCell(db)
    await setProjectSettings(db, { harmonize_min_role: 'project_lead' })

    const reviewerToken = await makeToken(300, 'carol')
    const res = await handleEventsWriteRequest(
      await makeRequest([makeHarmonizeEvent('evt-harm-pl-reject', 'carol')], reviewerToken),
      makeEnv(db),
    )
    const body = (await res!.json()) as any
    expect(body.rejected).toHaveLength(1)
    expect(body.rejected[0].status).toBe(403)
  })
})

// ── harmonize_min_role = 'maintainer' ────────────────────────────────────

describe("cell.commit.harmonize — harmonize_min_role = 'maintainer'", () => {
  it('maintainer(600) is accepted', async () => {
    const { db } = await makeTestDb()
    await seedFileAndCell(db)
    await setProjectSettings(db, { harmonize_min_role: 'maintainer' })

    const maintToken = await makeToken(600, 'maint')
    const res = await handleEventsWriteRequest(
      await makeRequest([makeHarmonizeEvent('evt-harm-maint-accept', 'maint')], maintToken),
      makeEnv(db),
    )
    const body = (await res!.json()) as any
    expect(body.accepted).toHaveLength(1)
    expect(body.rejected).toHaveLength(0)
  })

  it('project_lead(500) is rejected when floor is maintainer', async () => {
    const { db } = await makeTestDb()
    await seedFileAndCell(db)
    await setProjectSettings(db, { harmonize_min_role: 'maintainer' })

    const plToken = await makeToken(500, 'lead')
    const res = await handleEventsWriteRequest(
      await makeRequest([makeHarmonizeEvent('evt-harm-maint-reject', 'lead')], plToken),
      makeEnv(db),
    )
    const body = (await res!.json()) as any
    expect(body.rejected).toHaveLength(1)
    expect(body.rejected[0].status).toBe(403)
    expect(body.rejected[0].reason).toMatch(/maintainer/)
  })
})

// ── Non-harmonize target.cell.commit is unaffected ────────────────────────

describe('target.cell.commit without harmonize_origin — unaffected by harmonize gate', () => {
  it('contributor(400) can still make normal commits', async () => {
    const { db } = await makeTestDb()
    await seedFileAndCell(db)
    await setProjectSettings(db, { harmonize_min_role: 'maintainer' })

    const contribToken = await makeToken(400, 'translator')
    const normalCommit: RawEvent<'target.cell.commit'> = {
      id: 'evt-normal-commit',
      schemaVersion: 1,
      kind: 'target.cell.commit',
      projectId: PROJECT,
      fileId: FILE,
      cellId: CELL,
      parentId: 'evt-h-cell',
      author: 'translator',
      payload: { value: 'regular translation edit' },
      clientTs: 300,
    }
    const res = await handleEventsWriteRequest(
      await makeRequest([normalCommit], contribToken),
      makeEnv(db),
    )
    const body = (await res!.json()) as any
    // Normal commits are accepted regardless of harmonize floor.
    expect(body.accepted).toHaveLength(1)
    expect(body.rejected).toHaveLength(0)
  })
})

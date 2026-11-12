// AQU-1768 — the org may set defaults for the media settings; a project's own
// value wins; absent on both falls to each gate's built-in answer (timing
// LOCKED, track editing ON since AQU-2214, audio floor reviewer,
// self-validation ON). These pin the resolution on the server gates, which are
// what the settings mean.

import { describe, it, expect, vi } from 'vitest'

vi.mock('partyserver', () => ({
  getServerByName: vi.fn().mockResolvedValue({
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  }),
}))

import { handleEventsWriteRequest } from '../events/route'
import { resolveTimingLocked } from '../events/timing-authority'
import { resolveAllowTrackEditing } from '../events/track-editing-authority'
import { makeTestDb } from './helpers/pg-test-db'
import { makeTestToken } from './helpers/auth'
import type { RawEvent } from '../events/types'

const SECRET = 'media-org-default-secret'
const PROJECT = 'proj-media'
const FILE = 'file-media'

async function seedOrg(db: AquillaDb, orgSettings: Record<string, unknown> | null) {
  await db.prepare(`INSERT INTO organizations (id, name, owner_user_id) VALUES (42, 'Org', 1)`).run()
  await db
    .prepare(
      `INSERT INTO projects (id, name, org_id, created_by) VALUES (?, 'P', 42, 1)
       ON CONFLICT (id) DO UPDATE SET org_id = 42`,
    )
    .bind(PROJECT)
    .run()
  if (orgSettings) {
    await db
      .prepare(`INSERT INTO org_settings (org_id, settings, version) VALUES (42, ?, 1)`)
      .bind(JSON.stringify(orgSettings))
      .run()
  }
}

async function setProjectSettings(db: AquillaDb, settings: Record<string, unknown>) {
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

describe('timing lock — project → org → locked', () => {
  it('stays locked with nothing set anywhere', async () => {
    const { db } = await makeTestDb()
    await seedOrg(db, null)
    expect(await resolveTimingLocked(db, PROJECT)).toBe(true)
  })

  it('follows an org that unlocks, when the project sets nothing', async () => {
    const { db } = await makeTestDb()
    await seedOrg(db, { timingLocked: false })
    expect(await resolveTimingLocked(db, PROJECT)).toBe(false)
  })

  it("keeps the project's own lock over the org's unlock", async () => {
    const { db } = await makeTestDb()
    await seedOrg(db, { timingLocked: false })
    await setProjectSettings(db, { timingLocked: true })
    expect(await resolveTimingLocked(db, PROJECT)).toBe(true)
  })

  it("keeps the project's own unlock over the org's lock", async () => {
    const { db } = await makeTestDb()
    await seedOrg(db, { timingLocked: true })
    await setProjectSettings(db, { timingLocked: false })
    expect(await resolveTimingLocked(db, PROJECT)).toBe(false)
  })

  it('ignores an org value that is not a boolean', async () => {
    const { db } = await makeTestDb()
    await seedOrg(db, { timingLocked: 'false' })
    expect(await resolveTimingLocked(db, PROJECT)).toBe(true)
  })
})

describe('track editing — project → org → ON (AQU-2214)', () => {
  // The default flipped after the ETEN demo (Sam, Oct 27): adding a track is
  // the ordinary case, so a project nobody has asked may restructure its
  // timelines. The three tests under it are why that is a DEFAULT and not the
  // removal of the gate — an explicit no still refuses, from either level.
  it('is on with nothing set anywhere', async () => {
    const { db } = await makeTestDb()
    await seedOrg(db, null)
    expect(await resolveAllowTrackEditing(db, PROJECT)).toBe(true)
  })

  it('follows an org that turns it off, when the project sets nothing', async () => {
    const { db } = await makeTestDb()
    await seedOrg(db, { allowTrackEditing: false })
    expect(await resolveAllowTrackEditing(db, PROJECT)).toBe(false)
  })

  it("keeps the project's own off over the org's on", async () => {
    const { db } = await makeTestDb()
    await seedOrg(db, { allowTrackEditing: true })
    await setProjectSettings(db, { allowTrackEditing: false })
    expect(await resolveAllowTrackEditing(db, PROJECT)).toBe(false)
  })

  it("keeps the project's own on over the org's off", async () => {
    const { db } = await makeTestDb()
    await seedOrg(db, { allowTrackEditing: false })
    await setProjectSettings(db, { allowTrackEditing: true })
    expect(await resolveAllowTrackEditing(db, PROJECT)).toBe(true)
  })

  it('ignores a project value that is not a boolean and falls to the default', async () => {
    const { db } = await makeTestDb()
    await seedOrg(db, null)
    await setProjectSettings(db, { allowTrackEditing: 'false' })
    expect(await resolveAllowTrackEditing(db, PROJECT)).toBe(true)
  })
})

// ── Audio validation gates through the events route ───────────────────────

async function token(role: number, username: string): Promise<string> {
  return makeTestToken(SECRET, { projectId: PROJECT, fileId: FILE, role, username } as any)
}

async function post(db: AquillaDb, event: RawEvent, tok: string) {
  const res = await handleEventsWriteRequest(
    new Request('https://worker/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
      body: JSON.stringify({ events: [event] }),
    }),
    { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET },
  )
  return res!.json() as Promise<{ accepted: unknown[]; rejected: Array<{ reason: string }> }>
}

async function seedTake(db: AquillaDb, recorder: string) {
  const file: RawEvent<'file.create'> = {
    id: 'evt-media-file', schemaVersion: 1, kind: 'file.create', projectId: PROJECT, fileId: FILE,
    cellId: undefined, parentId: null, author: 'owner',
    payload: { name: 'Media', fileType: 'codex' }, clientTs: 0,
  }
  expect((await post(db, file, await token(700, 'owner'))).rejected).toHaveLength(0)
  const cell: RawEvent<'target.cell.create'> = {
    id: 'evt-media-cell', schemaVersion: 1, kind: 'target.cell.create', projectId: PROJECT, fileId: FILE,
    cellId: 'c1', parentId: null, author: 'alice', payload: { cellId: 'c1', value: 'text' }, clientTs: 100,
  }
  expect((await post(db, cell, await token(400, 'alice'))).rejected).toHaveLength(0)
  const attach: RawEvent<'cell.audio.attach'> = {
    id: 'evt-media-attach', schemaVersion: 1, kind: 'cell.audio.attach', projectId: PROJECT, fileId: FILE,
    cellId: 'c1', parentId: null, author: recorder,
    payload: { audioId: 'take-1', url: 'frontier-audio://take-1.wav', slot: 'recording' }, clientTs: 150,
  }
  expect((await post(db, attach, await token(400, recorder))).rejected).toHaveLength(0)
}

function validate(id: string, author: string): RawEvent<'cell.audio.validate'> {
  return {
    id, schemaVersion: 1, kind: 'cell.audio.validate', projectId: PROJECT, fileId: FILE,
    cellId: 'c1', parentId: null, author, payload: { audioId: 'take-1' }, clientTs: 200,
  }
}

describe('audio validation floor — project → org → reviewer', () => {
  it("refuses a reviewer when the org's floor is project lead and the project sets none", async () => {
    const { db } = await makeTestDb()
    await seedOrg(db, { validationRoleFloorAudio: 'project_lead' })
    await seedTake(db, 'alice')
    const body = await post(db, validate('evt-mv-1', 'bob'), await token(300, 'bob'))
    expect(body.rejected).toHaveLength(1)
    expect(body.rejected[0].reason).toMatch(/role too low to validate audio/)
  })

  it("lets the project's own reviewer floor win over the org's", async () => {
    const { db } = await makeTestDb()
    await seedOrg(db, { validationRoleFloorAudio: 'project_lead' })
    await setProjectSettings(db, { validationRoleFloorAudio: 'reviewer' })
    await seedTake(db, 'alice')
    const body = await post(db, validate('evt-mv-2', 'bob'), await token(300, 'bob'))
    expect(body.rejected).toHaveLength(0)
  })

  it('accepts a reviewer with nothing set anywhere', async () => {
    const { db } = await makeTestDb()
    await seedOrg(db, null)
    await seedTake(db, 'alice')
    const body = await post(db, validate('evt-mv-3', 'bob'), await token(300, 'bob'))
    expect(body.rejected).toHaveLength(0)
  })
})

describe('audio self-validation — project → org → allowed', () => {
  it('refuses the recorder when the org turns it off and the project sets nothing', async () => {
    const { db } = await makeTestDb()
    await seedOrg(db, { allowSelfValidationAudio: false })
    await seedTake(db, 'bob')
    const body = await post(db, validate('evt-ms-1', 'bob'), await token(300, 'bob'))
    expect(body.rejected).toHaveLength(1)
    expect(body.rejected[0].reason).toMatch(/validating your own recording/)
  })

  it("lets the project's own 'allowed' win over the org's 'off'", async () => {
    const { db } = await makeTestDb()
    await seedOrg(db, { allowSelfValidationAudio: false })
    await setProjectSettings(db, { allowSelfValidationAudio: true })
    await seedTake(db, 'bob')
    const body = await post(db, validate('evt-ms-2', 'bob'), await token(300, 'bob'))
    expect(body.rejected).toHaveLength(0)
  })
})

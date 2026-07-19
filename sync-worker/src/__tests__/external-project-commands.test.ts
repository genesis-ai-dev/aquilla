// Tests for the W2-A receipt-only project-lifecycle commands (Agent API v1.1
// §2): CreateProject + UpdateProjectSettings. These flow through the SAME
// prepare → commit changeset engine as SetTranslation/PlanImport but apply a
// plain row write via db/shared/projects.ts, NOT events — so the assertions here
// are about the projects / project_members / project_settings rows and the
// receipt-only receipt shape, plus the scope/role gates and version guard.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// commit.ts → events/route.ts → broadcast.ts → partyserver (cloudflare:*). The
// project-lifecycle commands never route through /events, but the import graph
// still loads it, so the same mock the other external suites use is required.
vi.mock('partyserver', () => ({
  getServerByName: vi.fn().mockResolvedValue({
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  }),
}))

import { handleExternalChangesetsRequest } from '../external/changesets-route'
import { mintApiToken } from '../../../db/shared/api-credentials'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'

const SECRET = 'test-secret'
const ORG_ID = 10

function makeEnv(db: AquillaDb) {
  return { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET, BASE_URL: 'https://aquilla.app' }
}

interface CredSpec {
  credentialId: string
  userId: number
  username: string
  orgId?: string | null
  projectId?: string | null
  mode?: 'ask' | 'act'
}

/** Seed a real users row + api_credentials row and mint a live `aqk_` token. */
async function credToken(tdb: TestDb, spec: CredSpec): Promise<string> {
  await tdb.pg.query(
    `INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, 'h')
     ON CONFLICT (id) DO NOTHING`,
    [spec.userId, spec.username, `${spec.username}@x.com`],
  )
  const { token, tokenHash, tokenPrefix } = await mintApiToken()
  await tdb.pg.query(
    `INSERT INTO api_credentials (id, user_id, name, token_prefix, token_hash, mode, org_id, project_id)
     VALUES ($1, $2, 'test', $3, $4, $5, $6, $7)`,
    [
      spec.credentialId,
      String(spec.userId),
      tokenPrefix,
      tokenHash,
      spec.mode ?? 'act',
      spec.orgId ?? null,
      spec.projectId ?? null,
    ],
  )
  return token
}

/** Seed an org and (optionally) the caller's org membership at `level`. */
async function seedOrgMember(tdb: TestDb, userId: number, level: number | null): Promise<void> {
  await tdb.pg.query(
    `INSERT INTO organizations (id, name, owner_user_id) VALUES ($1, 'Org', $2)
     ON CONFLICT (id) DO NOTHING`,
    [ORG_ID, userId],
  )
  if (level != null) {
    await tdb.pg.query(
      `INSERT INTO org_members (org_id, user_id, role_level) VALUES ($1, $2, $3)`,
      [ORG_ID, userId, level],
    )
  }
}

function changesetsUrl(projectId: string): string {
  return `https://w/api/v1/external/projects/${projectId}/changesets`
}

function prepareReq(projectId: string, token: string, body: unknown): Request {
  return new Request(changesetsUrl(projectId), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function commitReq(projectId: string, token: string, id: string): Request {
  return new Request(`${changesetsUrl(projectId)}/${id}/commit`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  })
}

async function prepare(
  env: ReturnType<typeof makeEnv>,
  projectId: string,
  token: string,
  commands: unknown,
) {
  const res = (await handleExternalChangesetsRequest(prepareReq(projectId, token, { commands }), env))!
  return { res, body: (await res.json()) as any }
}

async function commit(
  env: ReturnType<typeof makeEnv>,
  projectId: string,
  token: string,
  id: string,
) {
  const res = (await handleExternalChangesetsRequest(commitReq(projectId, token, id), env))!
  return { res, body: (await res.json()) as any }
}

/** Seed a valid, unconsumed human approval for a staged changeset — CreateProject
 *  is always ask-mode (blocker 3), so any create-commit needs one. */
async function seedConfirmation(
  tdb: TestDb,
  changesetId: string,
  digest: string,
  userId: number,
  credentialId: string,
): Promise<void> {
  await tdb.db
    .prepare(
      `INSERT INTO changeset_confirmations (id, changeset_id, user_id, credential_id, digest, expires_at, consumed_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`,
    )
    .bind(`conf-${changesetId.slice(0, 8)}`, changesetId, String(userId), credentialId, digest, new Date(Date.now() + 60_000).toISOString())
    .run()
}

let tdb: TestDb
beforeEach(async () => {
  tdb = await makeTestDb({})
})

// ── validation ───────────────────────────────────────────────────────────────

describe('project commands — validation', () => {
  it('CreateProject with an empty name → validation_failed', async () => {
    const env = makeEnv(tdb.db)
    await seedOrgMember(tdb, 1, 600)
    const token = await credToken(tdb, {
      credentialId: '00000000-0000-0000-0000-0000000000a1', userId: 1, username: 'alice',
      orgId: String(ORG_ID), projectId: null,
    })
    const { res, body } = await prepare(env, 'new-proj', token, [
      { kind: 'CreateProject', name: '', orgId: ORG_ID },
    ])
    expect(res.status).toBe(400)
    expect(body.error.code).toBe('validation_failed')
  })

  it('UpdateProjectSettings with a non-integer ifMatchVersion → validation_failed', async () => {
    const env = makeEnv(tdb.db)
    const token = await credToken(tdb, {
      credentialId: '00000000-0000-0000-0000-0000000000a2', userId: 1, username: 'alice',
      orgId: null, projectId: 'proj-a',
    })
    await tdb.pg.query(
      `INSERT INTO projects (id, name, created_by) VALUES ('proj-a', 'P', 1)`,
    )
    await tdb.pg.query(
      `INSERT INTO project_members (project_id, user_id, role_level) VALUES ('proj-a', 1, 600)`,
    )
    const { res, body } = await prepare(env, 'proj-a', token, [
      { kind: 'UpdateProjectSettings', projectId: 'proj-a', settings: {}, ifMatchVersion: 1.5 },
    ])
    expect(res.status).toBe(400)
    expect(body.error.code).toBe('validation_failed')
  })

  it('UpdateProjectSettings with non-object settings → validation_failed', async () => {
    const env = makeEnv(tdb.db)
    const token = await credToken(tdb, {
      credentialId: '00000000-0000-0000-0000-0000000000a3', userId: 1, username: 'alice',
      orgId: null, projectId: 'proj-a',
    })
    await tdb.pg.query(`INSERT INTO projects (id, name, created_by) VALUES ('proj-a', 'P', 1)`)
    await tdb.pg.query(`INSERT INTO project_members (project_id, user_id, role_level) VALUES ('proj-a', 1, 600)`)
    const { res, body } = await prepare(env, 'proj-a', token, [
      { kind: 'UpdateProjectSettings', projectId: 'proj-a', settings: [1, 2], ifMatchVersion: 0 },
    ])
    expect(res.status).toBe(400)
    expect(body.error.code).toBe('validation_failed')
  })
})

// ── CreateProject ──────────────────────────────────────────────────────────

describe('CreateProject — happy path (org-scoped maintainer)', () => {
  it('is ALWAYS staged ask-mode (blocker 3): an org-scoped act credential still needs approval, then commits the project + owner(700) row', async () => {
    const env = makeEnv(tdb.db)
    await seedOrgMember(tdb, 1, 600) // alice: org maintainer
    // NOTE: credential is mode 'act' AND org-scoped — the exact combination the
    // mint endpoint permits. prepare must still force the changeset to ask-mode,
    // so a direct commit is refused until a human approval is seeded.
    const token = await credToken(tdb, {
      credentialId: '00000000-0000-0000-0000-0000000000b1', userId: 1, username: 'alice',
      orgId: String(ORG_ID), projectId: null, mode: 'act',
    })

    const { body: prep } = await prepare(env, 'brand-new', token, [
      { kind: 'CreateProject', name: 'Brand New', orgId: ORG_ID },
    ])
    expect(prep.changeset.status).toBe('staged')
    // Forced ask-mode regardless of the act credential.
    expect(prep.changeset.autonomyMode).toBe('ask')

    // A direct commit (no approval) is refused — no project created unattended.
    const denied = await commit(env, 'brand-new', token, prep.changeset.id)
    expect(denied.res.status).toBe(428)
    expect(denied.body.error.code).toBe('confirmation_required')
    expect((await tdb.rows<{ id: string }>('projects')).filter((p) => p.id === 'brand-new')).toHaveLength(0)

    // Seed a human approval, then commit succeeds.
    await tdb.db
      .prepare(
        `INSERT INTO changeset_confirmations (id, changeset_id, user_id, credential_id, digest, expires_at, consumed_at)
         VALUES (?, ?, '1', ?, ?, ?, NULL)`,
      )
      .bind('conf-b1', prep.changeset.id, '00000000-0000-0000-0000-0000000000b1', prep.digest, new Date(Date.now() + 60_000).toISOString())
      .run()

    const { res, body } = await commit(env, 'brand-new', token, prep.changeset.id)
    expect(res.status).toBe(200)
    expect(body.receipt.command).toBe('CreateProject')
    expect(body.receipt.projectId).toBe('brand-new')
    expect(body.receipt.credentialId).toBe('00000000-0000-0000-0000-0000000000b1')
    expect(body.receipt.channel).toBe('rest')
    expect(body.receipt.changesetId).toBe(prep.changeset.id)

    // Project row exists with the resolved org + creator.
    const projects = await tdb.rows<{ id: string; org_id: string | number; created_by: string | number; name: string }>('projects')
    const created = projects.find((p) => p.id === 'brand-new')
    expect(created).toBeDefined()
    expect(String(created!.org_id)).toBe(String(ORG_ID))
    expect(String(created!.created_by)).toBe('1')
    expect(created!.name).toBe('Brand New')

    // Creator owner(700) membership row exists — the writeCreatorMembership: true
    // coverage wave 1 flagged as missing.
    const members = await tdb.rows<{ project_id: string; user_id: string | number; role_level: number }>('project_members')
    const ownerRow = members.find((m) => m.project_id === 'brand-new' && String(m.user_id) === '1')
    expect(ownerRow).toBeDefined()
    expect(ownerRow!.role_level).toBe(700)

    // Changeset committed with the receipt.
    const cs = await tdb.rows<{ status: string; receipt: unknown }>('changesets')
    expect(cs[0].status).toBe('committed')
    expect(cs[0].receipt).not.toBeNull()
  })
})

describe('CreateProject — scope + role gates', () => {
  it('a project-scoped credential → scope_denied at prepare', async () => {
    const env = makeEnv(tdb.db)
    await seedOrgMember(tdb, 1, 600)
    const token = await credToken(tdb, {
      credentialId: '00000000-0000-0000-0000-0000000000b2', userId: 1, username: 'alice',
      orgId: null, projectId: 'some-project', mode: 'act',
    })
    const { res, body } = await prepare(env, 'brand-new', token, [
      { kind: 'CreateProject', name: 'X', orgId: ORG_ID },
    ])
    expect(res.status).toBe(403)
    expect(body.error.code).toBe('scope_denied')
    expect(await tdb.rows('changesets')).toHaveLength(0)
  })

  it('org role below maintainer → permission_denied at prepare', async () => {
    const env = makeEnv(tdb.db)
    await seedOrgMember(tdb, 1, 400) // contributor, not maintainer
    const token = await credToken(tdb, {
      credentialId: '00000000-0000-0000-0000-0000000000b3', userId: 1, username: 'alice',
      orgId: String(ORG_ID), projectId: null, mode: 'act',
    })
    const { res, body } = await prepare(env, 'brand-new', token, [
      { kind: 'CreateProject', name: 'X', orgId: ORG_ID },
    ])
    expect(res.status).toBe(403)
    expect(body.error.code).toBe('permission_denied')
  })

  it('an org-scoped credential targeting a different org → scope_denied', async () => {
    const env = makeEnv(tdb.db)
    await seedOrgMember(tdb, 1, 600)
    const token = await credToken(tdb, {
      credentialId: '00000000-0000-0000-0000-0000000000b4', userId: 1, username: 'alice',
      orgId: '999', projectId: null, mode: 'act',
    })
    const { res, body } = await prepare(env, 'brand-new', token, [
      { kind: 'CreateProject', name: 'X', orgId: ORG_ID },
    ])
    expect(res.status).toBe(403)
    expect(body.error.code).toBe('scope_denied')
  })
})

describe('CreateProject — id collision', () => {
  it('an explicit project id already taken → validation_failed at prepare', async () => {
    const env = makeEnv(tdb.db)
    await tdb.pg.query(`INSERT INTO projects (id, name, created_by) VALUES ('taken', 'Existing', 99)`)
    // Unscoped credential creating a personal (org-less) project.
    const token = await credToken(tdb, {
      credentialId: '00000000-0000-0000-0000-0000000000c1', userId: 1, username: 'alice',
      orgId: null, projectId: null, mode: 'act',
    })
    const { res, body } = await prepare(env, 'taken', token, [
      { kind: 'CreateProject', projectId: 'taken', name: 'X' },
    ])
    expect(res.status).toBe(400)
    expect(body.error.code).toBe('validation_failed')
  })

  it('an id claimed by another caller between prepare and commit → conflict', async () => {
    const env = makeEnv(tdb.db)
    await seedOrgMember(tdb, 1, 600)
    const token = await credToken(tdb, {
      credentialId: '00000000-0000-0000-0000-0000000000c2', userId: 1, username: 'alice',
      orgId: String(ORG_ID), projectId: null, mode: 'act',
    })
    const { body: prep } = await prepare(env, 'raced', token, [
      { kind: 'CreateProject', name: 'Raced', orgId: ORG_ID },
    ])
    await seedConfirmation(tdb, prep.changeset.id, prep.digest, 1, '00000000-0000-0000-0000-0000000000c2')
    // Someone else creates the same id before commit.
    await tdb.pg.query(`INSERT INTO projects (id, name, created_by) VALUES ('raced', 'Other', 99)`)

    const { res, body } = await commit(env, 'raced', token, prep.changeset.id)
    expect(res.status).toBe(409)
    expect(body.error.code).toBe('conflict')

    // The changeset is moved off 'committing' so a retry cannot misclaim it.
    const cs = await tdb.rows<{ status: string }>('changesets')
    expect(cs[0].status).toBe('stale')
    // The other caller's project is untouched.
    const projects = await tdb.rows<{ id: string; created_by: string | number }>('projects')
    expect(String(projects.find((p) => p.id === 'raced')!.created_by)).toBe('99')
  })
})

// ── UpdateProjectSettings ────────────────────────────────────────────────────

/** Seed a project with the caller as maintainer + a settings row at `version`. */
async function seedSettingsProject(
  tdb: TestDb,
  projectId: string,
  userId: number,
  settings: Record<string, unknown>,
  version: number,
): Promise<void> {
  await tdb.pg.query(`INSERT INTO projects (id, name, created_by) VALUES ($1, 'P', 99)`, [projectId])
  await tdb.pg.query(
    `INSERT INTO project_members (project_id, user_id, role_level) VALUES ($1, $2, 600)`,
    [projectId, userId],
  )
  await tdb.pg.query(
    `INSERT INTO project_settings (project_id, settings, version, updated_by) VALUES ($1, $2, $3, $4)`,
    [projectId, JSON.stringify(settings), version, userId],
  )
}

describe('UpdateProjectSettings — happy path + version guard', () => {
  it('commits a version bump and returns the new version in the receipt', async () => {
    const env = makeEnv(tdb.db)
    await seedSettingsProject(tdb, 'proj-s', 1, { targetLanguage: 'fr' }, 1)
    const token = await credToken(tdb, {
      credentialId: '00000000-0000-0000-0000-0000000000d1', userId: 1, username: 'alice',
      orgId: null, projectId: 'proj-s', mode: 'act',
    })

    const { body: prep } = await prepare(env, 'proj-s', token, [
      { kind: 'UpdateProjectSettings', projectId: 'proj-s', settings: { targetLanguage: 'de' }, ifMatchVersion: 1 },
    ])
    expect(prep.changeset.status).toBe('staged')

    const { res, body } = await commit(env, 'proj-s', token, prep.changeset.id)
    expect(res.status).toBe(200)
    expect(body.receipt.command).toBe('UpdateProjectSettings')
    expect(body.receipt.version).toBe(2)

    const settings = await tdb.rows<{ project_id: string; settings: string; version: number }>('project_settings')
    const row = settings.find((s) => s.project_id === 'proj-s')!
    expect(row.version).toBe(2)
    expect(JSON.parse(row.settings).targetLanguage).toBe('de')
  })

  it('ifMatchVersion drift at prepare → plan_stale', async () => {
    const env = makeEnv(tdb.db)
    await seedSettingsProject(tdb, 'proj-s', 1, { targetLanguage: 'fr' }, 3)
    const token = await credToken(tdb, {
      credentialId: '00000000-0000-0000-0000-0000000000d2', userId: 1, username: 'alice',
      orgId: null, projectId: 'proj-s', mode: 'act',
    })
    const { res, body } = await prepare(env, 'proj-s', token, [
      { kind: 'UpdateProjectSettings', projectId: 'proj-s', settings: {}, ifMatchVersion: 0 },
    ])
    expect(res.status).toBe(409)
    expect(body.error.code).toBe('plan_stale')
    expect(await tdb.rows('changesets')).toHaveLength(0)
  })

  it('ifMatchVersion drift discovered at commit re-check → plan_stale + status stale', async () => {
    const env = makeEnv(tdb.db)
    await seedSettingsProject(tdb, 'proj-s', 1, { targetLanguage: 'fr' }, 1)
    const token = await credToken(tdb, {
      credentialId: '00000000-0000-0000-0000-0000000000d3', userId: 1, username: 'alice',
      orgId: null, projectId: 'proj-s', mode: 'act',
    })

    // Prepare pins version 1.
    const { body: prep } = await prepare(env, 'proj-s', token, [
      { kind: 'UpdateProjectSettings', projectId: 'proj-s', settings: { targetLanguage: 'de' }, ifMatchVersion: 1 },
    ])

    // Someone else bumps the settings version between prepare and commit.
    await tdb.db
      .prepare(`UPDATE project_settings SET version = 2 WHERE project_id = ?`)
      .bind('proj-s')
      .run()

    const { res, body } = await commit(env, 'proj-s', token, prep.changeset.id)
    expect(res.status).toBe(409)
    expect(body.error.code).toBe('plan_stale')
    const cs = await tdb.rows<{ status: string }>('changesets')
    expect(cs[0].status).toBe('stale')
  })
})

describe('UpdateProjectSettings — validation-threshold change triggers reprojection', () => {
  it('lowering validationCount re-derives cells.validated locally', async () => {
    const env = makeEnv(tdb.db)
    // Project + settings at threshold 3 (validationCount=3), caller maintainer.
    await seedSettingsProject(tdb, 'proj-v', 1, { validationCount: 3 }, 1)
    // A target cell with two validators pinned to its head event → validated 0
    // at threshold 3, but should flip to 1 once the threshold drops to 1.
    await tdb.pg.query(
      `INSERT INTO cells (project_id, file_id, cell_id, side, value, event_id, validated, target_lang, last_edit_at)
       VALUES ('proj-v', 'f1', 'c1', 'target', 'v', 'e1', 0, '', 1)`,
    )
    await tdb.pg.query(
      `INSERT INTO cell_validators (project_id, file_id, cell_id, target_lang, event_id, username, decided_ts)
       VALUES ('proj-v', 'f1', 'c1', '', 'e1', 'u1', 1), ('proj-v', 'f1', 'c1', '', 'e1', 'u2', 1)`,
    )

    const token = await credToken(tdb, {
      credentialId: '00000000-0000-0000-0000-0000000000e1', userId: 1, username: 'alice',
      orgId: null, projectId: 'proj-v', mode: 'act',
    })

    const { body: prep } = await prepare(env, 'proj-v', token, [
      { kind: 'UpdateProjectSettings', projectId: 'proj-v', settings: { validationCount: 1 }, ifMatchVersion: 1 },
    ])
    const { res } = await commit(env, 'proj-v', token, prep.changeset.id)
    expect(res.status).toBe(200)

    // The cell's validated flag was re-derived (2 validators >= threshold 1).
    const cells = await tdb.rows<{ cell_id: string; validated: number }>('cells')
    expect(cells.find((c) => c.cell_id === 'c1')!.validated).toBe(1)
  })
})

// ── crash-retry idempotency (receipt-only) ───────────────────────────────────

describe('project commands — commit crash-retry idempotency', () => {
  it('a CreateProject retry from `committing` re-applies the same id — no conflict, no duplicate row', async () => {
    const env = makeEnv(tdb.db)
    await seedOrgMember(tdb, 1, 600)
    const token = await credToken(tdb, {
      credentialId: '00000000-0000-0000-0000-0000000000f1', userId: 1, username: 'alice',
      orgId: String(ORG_ID), projectId: null, mode: 'act',
    })

    const { body: prep } = await prepare(env, 'retry-proj', token, [
      { kind: 'CreateProject', name: 'Retry', orgId: ORG_ID },
    ])
    await seedConfirmation(tdb, prep.changeset.id, prep.digest, 1, '00000000-0000-0000-0000-0000000000f1')
    const { res: res1 } = await commit(env, 'retry-proj', token, prep.changeset.id)
    expect(res1.status).toBe(200)

    // Simulate a crash after the row write but before the status flip to
    // 'committed' was durably written.
    await tdb.db
      .prepare(`UPDATE changesets SET status = 'committing' WHERE id = ?`)
      .bind(prep.changeset.id)
      .run()

    const { res: res2, body } = await commit(env, 'retry-proj', token, prep.changeset.id)
    expect(res2.status).toBe(200)
    expect(body.receipt.command).toBe('CreateProject')

    // Exactly one project row + one owner membership row.
    const projects = (await tdb.rows<{ id: string }>('projects')).filter((p) => p.id === 'retry-proj')
    expect(projects).toHaveLength(1)
    const members = (await tdb.rows<{ project_id: string; user_id: string | number }>('project_members'))
      .filter((m) => m.project_id === 'retry-proj')
    expect(members).toHaveLength(1)
  })

  it('an UpdateProjectSettings retry from `committing` is idempotent — one version bump, no plan_stale', async () => {
    // The version-guarded UPDATE bumps version by exactly 1. A crash-retry re-runs
    // the SAME version-guarded write, whose guard (WHERE version = ifMatchVersion)
    // now fails because the first attempt already advanced the version — commit.ts
    // must recognize "current == expected+1" as its OWN prior apply and return
    // success, NOT plan_stale, and must not bump the version a second time.
    const env = makeEnv(tdb.db)
    await seedSettingsProject(tdb, 'retry-settings', 1, { targetLanguage: 'fr' }, 1)
    const token = await credToken(tdb, {
      credentialId: '00000000-0000-0000-0000-0000000000f4', userId: 1, username: 'alice',
      orgId: null, projectId: 'retry-settings', mode: 'act',
    })

    const { body: prep } = await prepare(env, 'retry-settings', token, [
      { kind: 'UpdateProjectSettings', projectId: 'retry-settings', settings: { targetLanguage: 'de' }, ifMatchVersion: 1 },
    ])
    const { res: res1, body: body1 } = await commit(env, 'retry-settings', token, prep.changeset.id)
    expect(res1.status).toBe(200)
    expect(body1.receipt.version).toBe(2)

    // Simulate a crash after the row write but before the status flip to
    // 'committed' was durably persisted.
    await tdb.db
      .prepare(`UPDATE changesets SET status = 'committing', receipt = NULL WHERE id = ?`)
      .bind(prep.changeset.id)
      .run()

    const { res: res2, body: body2 } = await commit(env, 'retry-settings', token, prep.changeset.id)
    expect(res2.status).toBe(200)
    expect(body2.receipt.command).toBe('UpdateProjectSettings')
    // Version reported is still 2 — the retry did NOT bump to 3.
    expect(body2.receipt.version).toBe(2)

    const settings = await tdb.rows<{ project_id: string; version: number; settings: string }>('project_settings')
    const row = settings.find((s) => s.project_id === 'retry-settings')!
    expect(row.version).toBe(2)
    expect(JSON.parse(row.settings).targetLanguage).toBe('de')
  })

  it('blocker 1: an UpdateProjectSettings retry where a DIFFERENT user bumped the version → plan_stale (not false success)', async () => {
    // The crash-window hazard: current.version == expected+1 is NOT sufficient to
    // claim idempotent success — a concurrent maintainer writing during the window
    // leaves the same version but a different updated_by. Absorbing that as success
    // would silently DROP the agent's settings and return a false receipt. commit.ts
    // must disambiguate by author (updated_by == this credential's user).
    const env = makeEnv(tdb.db)
    await seedSettingsProject(tdb, 'stale-settings', 1, { targetLanguage: 'fr' }, 1)
    const token = await credToken(tdb, {
      credentialId: '00000000-0000-0000-0000-0000000000f5', userId: 1, username: 'alice',
      orgId: null, projectId: 'stale-settings', mode: 'act',
    })

    const { body: prep } = await prepare(env, 'stale-settings', token, [
      { kind: 'UpdateProjectSettings', projectId: 'stale-settings', settings: { targetLanguage: 'de' }, ifMatchVersion: 1 },
    ])

    // Put the changeset in the crash-retry state (committing), and simulate a
    // CONCURRENT maintainer (user 2) having written settings during the window:
    // version advances to expected+1 (2), but updated_by is 2, not the agent's 1.
    await tdb.db
      .prepare(`UPDATE changesets SET status = 'committing' WHERE id = ?`)
      .bind(prep.changeset.id)
      .run()
    await tdb.db
      .prepare(`UPDATE project_settings SET version = 2, updated_by = 2, settings = ? WHERE project_id = ?`)
      .bind(JSON.stringify({ targetLanguage: 'es' }), 'stale-settings')
      .run()

    const { res, body } = await commit(env, 'stale-settings', token, prep.changeset.id)
    expect(res.status).toBe(409)
    expect(body.error.code).toBe('plan_stale')

    // The agent's write was NOT applied and the concurrent write is untouched.
    const row = (await tdb.rows<{ project_id: string; version: number; settings: string; updated_by: number | string }>('project_settings'))
      .find((s) => s.project_id === 'stale-settings')!
    expect(row.version).toBe(2)
    expect(String(row.updated_by)).toBe('2')
    expect(JSON.parse(row.settings).targetLanguage).toBe('es')
    // Changeset moved off 'committing' so a later retry can't misread it.
    const cs = await tdb.rows<{ status: string }>('changesets')
    expect(cs[0].status).toBe('stale')
  })
})

// ── ask-mode confirmation for CreateProject (ask-mode-only by design) ────────

describe('CreateProject — ask mode requires a consumed confirmation', () => {
  it('commit without a confirmation → confirmation_required; nothing created', async () => {
    const env = makeEnv(tdb.db)
    await seedOrgMember(tdb, 1, 600)
    const token = await credToken(tdb, {
      credentialId: '00000000-0000-0000-0000-0000000000f2', userId: 1, username: 'alice',
      orgId: String(ORG_ID), projectId: null, mode: 'ask',
    })
    const { body: prep } = await prepare(env, 'ask-proj', token, [
      { kind: 'CreateProject', name: 'Ask', orgId: ORG_ID },
    ])
    expect(prep.changeset.autonomyMode).toBe('ask')

    const { res, body } = await commit(env, 'ask-proj', token, prep.changeset.id)
    expect(res.status).toBe(428)
    expect(body.error.code).toBe('confirmation_required')
    expect((await tdb.rows<{ id: string }>('projects')).filter((p) => p.id === 'ask-proj')).toHaveLength(0)
  })

  it('a valid confirmation lets the create commit', async () => {
    const env = makeEnv(tdb.db)
    await seedOrgMember(tdb, 1, 600)
    const token = await credToken(tdb, {
      credentialId: '00000000-0000-0000-0000-0000000000f3', userId: 1, username: 'alice',
      orgId: String(ORG_ID), projectId: null, mode: 'ask',
    })
    const { body: prep } = await prepare(env, 'ask-ok', token, [
      { kind: 'CreateProject', name: 'AskOk', orgId: ORG_ID },
    ])
    await tdb.db
      .prepare(
        `INSERT INTO changeset_confirmations (id, changeset_id, user_id, credential_id, digest, expires_at, consumed_at)
         VALUES (?, ?, '1', ?, ?, ?, NULL)`,
      )
      .bind('conf-cp', prep.changeset.id, '00000000-0000-0000-0000-0000000000f3', prep.digest, new Date(Date.now() + 60_000).toISOString())
      .run()

    const { res, body } = await commit(env, 'ask-ok', token, prep.changeset.id)
    expect(res.status).toBe(200)
    expect(body.receipt.projectId).toBe('ask-ok')
    expect((await tdb.rows<{ id: string }>('projects')).filter((p) => p.id === 'ask-ok')).toHaveLength(1)
  })
})

// ── discard guard: a committing changeset cannot be discarded ─────────────────

describe('discard — a committing changeset is rejected', () => {
  it('POST /discard on a `committing` changeset → validation_failed (not a silent no-op)', async () => {
    const env = makeEnv(tdb.db)
    await seedSettingsProject(tdb, 'proj-d', 1, {}, 0)
    const token = await credToken(tdb, {
      credentialId: '00000000-0000-0000-0000-000000000f10', userId: 1, username: 'alice',
      orgId: null, projectId: 'proj-d', mode: 'act',
    })
    const { body: prep } = await prepare(env, 'proj-d', token, [
      { kind: 'UpdateProjectSettings', projectId: 'proj-d', settings: { a: 1 }, ifMatchVersion: 0 },
    ])
    await tdb.db
      .prepare(`UPDATE changesets SET status = 'committing' WHERE id = ?`)
      .bind(prep.changeset.id)
      .run()

    const res = (await handleExternalChangesetsRequest(
      new Request(`${changesetsUrl('proj-d')}/${prep.changeset.id}/discard`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      }),
      env,
    ))!
    expect(res.status).toBe(400)
    expect((await res.json() as any).error.code).toBe('validation_failed')

    // Still committing — not discarded.
    const cs = await tdb.rows<{ status: string }>('changesets')
    expect(cs[0].status).toBe('committing')
  })
})

// ── blocker 4: receipt-only changesets stage a NON-EMPTY renderable summary ───

describe('blocker 4: receipt-only summary is renderable (no blind approval)', () => {
  it('CreateProject prepare stores the command kind, project name, definitive id, and target org', async () => {
    const env = makeEnv(tdb.db)
    await seedOrgMember(tdb, 1, 600)
    const token = await credToken(tdb, {
      credentialId: '00000000-0000-0000-0000-0000000004a1', userId: 1, username: 'alice',
      orgId: String(ORG_ID), projectId: null, mode: 'ask',
    })
    const { body: prep } = await prepare(env, 'summ-proj', token, [
      { kind: 'CreateProject', name: 'Summed Project', orgId: ORG_ID },
    ])
    // Summary carries flat, human-renderable fields (the /approve page filters to
    // string/number, so these must be strings — never nested objects only).
    expect(prep.summary.command).toBe('CreateProject')
    expect(prep.summary.projectName).toBe('Summed Project')
    expect(prep.summary.newProjectId).toBe('summ-proj')
    expect(prep.summary.targetOrg).toBe(String(ORG_ID))
    // The stored row (not just the response) carries them too.
    const cs = await tdb.rows<{ summary: any }>('changesets')
    const stored = typeof cs[0].summary === 'string' ? JSON.parse(cs[0].summary) : cs[0].summary
    expect(stored.command).toBe('CreateProject')
    expect(stored.newProjectId).toBe('summ-proj')
  })

  it('CreateProject for a personal (org-less) project shows targetOrg = "personal"', async () => {
    const env = makeEnv(tdb.db)
    const token = await credToken(tdb, {
      credentialId: '00000000-0000-0000-0000-0000000004a2', userId: 1, username: 'alice',
      orgId: null, projectId: null, mode: 'ask',
    })
    const { body: prep } = await prepare(env, 'personal-proj', token, [
      { kind: 'CreateProject', name: 'Mine' },
    ])
    expect(prep.summary.command).toBe('CreateProject')
    expect(prep.summary.targetOrg).toBe('personal')
  })

  it('UpdateProjectSettings prepare stores the kind, project id, pinned version, and per-key settings preview', async () => {
    const env = makeEnv(tdb.db)
    await seedSettingsProject(tdb, 'summ-settings', 1, { targetLanguage: 'fr' }, 1)
    const token = await credToken(tdb, {
      credentialId: '00000000-0000-0000-0000-0000000004a3', userId: 1, username: 'alice',
      orgId: null, projectId: 'summ-settings', mode: 'act',
    })
    const { body: prep } = await prepare(env, 'summ-settings', token, [
      {
        kind: 'UpdateProjectSettings',
        projectId: 'summ-settings',
        settings: { targetLanguage: 'de', validationCount: 5 },
        ifMatchVersion: 1,
      },
    ])
    expect(prep.summary.command).toBe('UpdateProjectSettings')
    expect(prep.summary.projectId).toBe('summ-settings')
    expect(prep.summary.ifMatchVersion).toBe(1)
    // Per-key preview of each new value (strings, truncated). Object rendered
    // explicitly by the approval page.
    expect(prep.summary.settingsChanges.targetLanguage).toBe('de')
    expect(prep.summary.settingsChanges.validationCount).toBe('5')
  })

  it('UpdateProjectSettings truncates a huge settings value in the preview', async () => {
    const env = makeEnv(tdb.db)
    await seedSettingsProject(tdb, 'big-settings', 1, {}, 0)
    const token = await credToken(tdb, {
      credentialId: '00000000-0000-0000-0000-0000000004a4', userId: 1, username: 'alice',
      orgId: null, projectId: 'big-settings', mode: 'act',
    })
    const huge = 'x'.repeat(500)
    const { body: prep } = await prepare(env, 'big-settings', token, [
      { kind: 'UpdateProjectSettings', projectId: 'big-settings', settings: { note: huge }, ifMatchVersion: 0 },
    ])
    const preview: string = prep.summary.settingsChanges.note
    expect(preview.length).toBeLessThanOrEqual(80)
    expect(preview.endsWith('…')).toBe(true)
  })
})

// ── blocker 2: a committed changeset's receipt is never clobbered by a loser ──

describe('blocker 2: committed receipts survive a stale-write / double commit', () => {
  it('the guarded stale-write does NOT alter a committed row (unit contract)', async () => {
    // The loser of a flip race used to run an UNCONDITIONAL
    // `UPDATE changesets SET status='stale' WHERE id=?`, which could overwrite a
    // sibling's status='committed' and make the stored receipt permanently
    // unreachable. The guard `AND status IN ('staged','committing')` must protect
    // a committed row.
    await seedSettingsProject(tdb, 'guard-proj', 1, {}, 0)
    const receipt = JSON.stringify({ command: 'UpdateProjectSettings', version: 1 })
    await tdb.pg.query(
      `INSERT INTO changesets (id, project_id, created_by_user_id, credential_id, autonomy_mode,
         status, commands, preconditions, summary, digest, expires_at, receipt, committed_at)
       VALUES ('cs-committed', 'guard-proj', '1', '00000000-0000-0000-0000-0000000002a1', 'act',
         'committed', '[]'::jsonb, '[]'::jsonb, '{"warnings":[]}'::jsonb, 'd', now() + interval '1 hour',
         $1::jsonb, now())`,
      [receipt],
    )

    await tdb.db
      .prepare(`UPDATE changesets SET status = 'stale' WHERE id = ? AND status IN ('staged','committing')`)
      .bind('cs-committed')
      .run()

    const row = (await tdb.rows<{ id: string; status: string; receipt: any }>('changesets'))
      .find((c) => c.id === 'cs-committed')!
    expect(row.status).toBe('committed')
    const stored = typeof row.receipt === 'string' ? JSON.parse(row.receipt) : row.receipt
    expect(stored.command).toBe('UpdateProjectSettings')
  })

  it('a second sequential commit returns the SAME stored receipt twice and never flips to stale', async () => {
    const env = makeEnv(tdb.db)
    await seedSettingsProject(tdb, 'twice-settings', 1, { targetLanguage: 'fr' }, 1)
    const token = await credToken(tdb, {
      credentialId: '00000000-0000-0000-0000-0000000002b1', userId: 1, username: 'alice',
      orgId: null, projectId: 'twice-settings', mode: 'act',
    })
    const { body: prep } = await prepare(env, 'twice-settings', token, [
      { kind: 'UpdateProjectSettings', projectId: 'twice-settings', settings: { targetLanguage: 'de' }, ifMatchVersion: 1 },
    ])

    const { res: r1, body: b1 } = await commit(env, 'twice-settings', token, prep.changeset.id)
    expect(r1.status).toBe(200)
    expect(b1.receipt.version).toBe(2)

    // A committed changeset short-circuits and returns its stored receipt — the
    // second call must NOT re-apply, NOT mark stale, and NOT change the receipt.
    const { res: r2, body: b2 } = await commit(env, 'twice-settings', token, prep.changeset.id)
    expect(r2.status).toBe(200)
    expect(b2.receipt.version).toBe(2)
    expect(b2.receipt.appliedAt).toBe(b1.receipt.appliedAt)

    const cs = await tdb.rows<{ status: string }>('changesets')
    expect(cs[0].status).toBe('committed')
    // Version bumped exactly once.
    const settings = (await tdb.rows<{ project_id: string; version: number }>('project_settings'))
      .find((s) => s.project_id === 'twice-settings')!
    expect(settings.version).toBe(2)
  })
})

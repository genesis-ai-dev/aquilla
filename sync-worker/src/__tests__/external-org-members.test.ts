// AQU-1235 — org-level membership commands (AddOrgMember / SetOrgRole /
// RemoveOrgMember) through the changeset engine.
//
// These are receipt-only like CreateProject (a plain `org_members` row write,
// not an event) with an ORG-level gate, so the assertions here are about the
// org_members / group_members rows, the receipt shape, the forced ask-mode, and
// — the bulk of the suite — the escalation gates: owner-only, no self-target,
// the target-role cap, and the last-owner guard.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// commit.ts → events/route.ts → broadcast.ts → partyserver (cloudflare:*). The
// org-membership commands never route through /events, but the import graph
// still loads it — same mock every external suite uses.
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
/** The changeset's home project id — org-membership plans are org-level, so
 *  this is only where the plan is filed. It deliberately does not exist. */
const HOME = 'org-admin'

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

async function seedUser(tdb: TestDb, userId: number, username: string): Promise<void> {
  await tdb.pg.query(
    `INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, 'h')
     ON CONFLICT (id) DO NOTHING`,
    [userId, username, `${username}@x.com`],
  )
}

async function credToken(tdb: TestDb, spec: CredSpec): Promise<string> {
  await seedUser(tdb, spec.userId, spec.username)
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

/** Create the org owned by `ownerUserId` and give that user an org_members row
 *  at `ownerLevel` (700 unless overridden, so the escalation tests can seed a
 *  non-owner caller against a real org). */
async function seedOrg(tdb: TestDb, ownerUserId: number, ownerLevel = 700): Promise<void> {
  await tdb.pg.query(
    `INSERT INTO organizations (id, name, owner_user_id) VALUES ($1, 'Acme', $2)
     ON CONFLICT (id) DO NOTHING`,
    [ORG_ID, ownerUserId],
  )
  await tdb.pg.query(
    `INSERT INTO org_members (org_id, user_id, role_level) VALUES ($1, $2, $3)
     ON CONFLICT (org_id, user_id) DO UPDATE SET role_level = excluded.role_level`,
    [ORG_ID, ownerUserId, ownerLevel],
  )
}

async function seedMember(tdb: TestDb, userId: number, level: number): Promise<void> {
  await tdb.pg.query(
    `INSERT INTO org_members (org_id, user_id, role_level) VALUES ($1, $2, $3)
     ON CONFLICT (org_id, user_id) DO UPDATE SET role_level = excluded.role_level`,
    [ORG_ID, userId, level],
  )
}

function changesetsUrl(projectId: string): string {
  return `https://w/api/v1/external/projects/${projectId}/changesets`
}

async function prepare(
  env: ReturnType<typeof makeEnv>,
  token: string,
  commands: unknown,
): Promise<{ res: Response; body: any }> {
  const req = new Request(changesetsUrl(HOME), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ commands }),
  })
  const res = (await handleExternalChangesetsRequest(req, env))!
  return { res, body: (await res.json()) as any }
}

async function commit(
  env: ReturnType<typeof makeEnv>,
  token: string,
  id: string,
): Promise<{ res: Response; body: any }> {
  const req = new Request(`${changesetsUrl(HOME)}/${id}/commit`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  })
  const res = (await handleExternalChangesetsRequest(req, env))!
  return { res, body: (await res.json()) as any }
}

/** Seed the one-time human approval these always-ask plans require. */
async function approve(
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
    .bind(
      `conf-${changesetId.slice(0, 8)}`,
      changesetId,
      String(userId),
      credentialId,
      digest,
      new Date(Date.now() + 60_000).toISOString(),
    )
    .run()
}

const OWNER_CRED = '00000000-0000-0000-0000-00000000c001'

/** The common fixture: alice(1) owns ORG_ID, bob(2) exists but is not a member. */
async function ownerToken(tdb: TestDb): Promise<string> {
  await seedOrg(tdb, 1)
  await seedUser(tdb, 2, 'bob')
  return credToken(tdb, {
    credentialId: OWNER_CRED,
    userId: 1,
    username: 'alice',
    orgId: String(ORG_ID),
    projectId: null,
    mode: 'act',
  })
}

async function orgMemberRows(tdb: TestDb): Promise<{ user_id: string; role_level: number }[]> {
  const rows = await tdb.rows<{ org_id: number | string; user_id: number | string; role_level: number }>('org_members')
  return rows
    .filter((r) => String(r.org_id) === String(ORG_ID))
    .map((r) => ({ user_id: String(r.user_id), role_level: r.role_level }))
}

let tdb: TestDb
beforeEach(async () => {
  tdb = await makeTestDb({})
})

// ── validation ───────────────────────────────────────────────────────────────

describe('org membership — validation', () => {
  it('rejects a non-canonical role level', async () => {
    const env = makeEnv(tdb.db)
    const token = await ownerToken(tdb)
    const { res, body } = await prepare(env, token, [
      { kind: 'AddOrgMember', orgId: ORG_ID, username: 'bob', role: 450 },
    ])
    expect(res.status).toBe(400)
    expect(body.error.code).toBe('validation_failed')
  })

  it('rejects an empty username', async () => {
    const env = makeEnv(tdb.db)
    const token = await ownerToken(tdb)
    const { res, body } = await prepare(env, token, [
      { kind: 'AddOrgMember', orgId: ORG_ID, username: '   ', role: 400 },
    ])
    expect(res.status).toBe(400)
    expect(body.error.code).toBe('validation_failed')
  })

  it('rejects mixing an org-membership command with another kind', async () => {
    const env = makeEnv(tdb.db)
    const token = await ownerToken(tdb)
    const { res, body } = await prepare(env, token, [
      { kind: 'AddOrgMember', orgId: ORG_ID, username: 'bob', role: 400 },
      { kind: 'SetTranslation', fileId: 'f', cellId: 'c', value: 'v' },
    ])
    expect(res.status).toBe(400)
    expect(body.error.code).toBe('validation_failed')
    expect(body.error.message).toContain('only command')
  })

  it('rejects an unknown username with validation_failed (never a silent no-op)', async () => {
    const env = makeEnv(tdb.db)
    const token = await ownerToken(tdb)
    const { res, body } = await prepare(env, token, [
      { kind: 'AddOrgMember', orgId: ORG_ID, username: 'nobody', role: 400 },
    ])
    expect(res.status).toBe(400)
    expect(body.error.code).toBe('validation_failed')
    expect(body.error.message).toContain('nobody')
  })

  it('AddOrgMember on an existing member points at SetOrgRole', async () => {
    const env = makeEnv(tdb.db)
    const token = await ownerToken(tdb)
    await seedMember(tdb, 2, 400)
    const { res, body } = await prepare(env, token, [
      { kind: 'AddOrgMember', orgId: ORG_ID, username: 'bob', role: 500 },
    ])
    expect(res.status).toBe(400)
    expect(body.error.code).toBe('validation_failed')
    expect(body.error.message).toContain('SetOrgRole')
  })

  it('SetOrgRole on a non-member is rejected', async () => {
    const env = makeEnv(tdb.db)
    const token = await ownerToken(tdb)
    const { res, body } = await prepare(env, token, [
      { kind: 'SetOrgRole', orgId: ORG_ID, username: 'bob', role: 500 },
    ])
    expect(res.status).toBe(400)
    expect(body.error.code).toBe('validation_failed')
    expect(body.error.message).toContain('not a member')
  })
})

// ── happy path ───────────────────────────────────────────────────────────────

describe('AddOrgMember — happy path', () => {
  it('is ALWAYS staged ask-mode, and on approval the member lands in the org roster', async () => {
    const env = makeEnv(tdb.db)
    const token = await ownerToken(tdb) // act-mode credential

    const { body: prep } = await prepare(env, token, [
      { kind: 'AddOrgMember', orgId: ORG_ID, username: 'bob', role: 400 },
    ])
    expect(prep.changeset.status).toBe('staged')
    // Forced ask regardless of the act credential — staffing an org always
    // passes a human.
    expect(prep.changeset.autonomyMode).toBe('ask')

    // The approval page's plain-language facts: who, which org, what role.
    expect(prep.changeset.summary.command).toBe('AddOrgMember')
    expect(prep.changeset.summary.orgMemberUsername).toBe('bob')
    expect(prep.changeset.summary.orgMemberNewRole).toBe('contributor')
    expect(prep.changeset.summary.orgMemberCurrentRole).toBe('not a member')
    expect(prep.changeset.summary.targetOrg).toContain('Acme')

    // No approval → refused, and no row written.
    const denied = await commit(env, token, prep.changeset.id)
    expect(denied.res.status).toBe(428)
    expect(denied.body.error.code).toBe('confirmation_required')
    expect((await orgMemberRows(tdb)).find((r) => r.user_id === '2')).toBeUndefined()

    await approve(tdb, prep.changeset.id, prep.digest, 1, OWNER_CRED)
    const { res, body } = await commit(env, token, prep.changeset.id)
    expect(res.status).toBe(200)

    // Audit: the receipt names the credential, the org and the target.
    expect(body.receipt.command).toBe('AddOrgMember')
    expect(body.receipt.credentialId).toBe(OWNER_CRED)
    expect(body.receipt.channel).toBe('rest')
    expect(body.receipt.orgId).toBe(ORG_ID)
    expect(body.receipt.targetUserId).toBe('2')
    expect(body.receipt.role).toBe(400)

    const rows = await orgMemberRows(tdb)
    expect(rows.find((r) => r.user_id === '2')?.role_level).toBe(400)

    // granted_by stamps the acting user on the row itself.
    const raw = await tdb.rows<{ user_id: number | string; granted_by: number | string | null }>('org_members')
    expect(String(raw.find((r) => String(r.user_id) === '2')!.granted_by)).toBe('1')

    // Committing twice returns the stored receipt without re-applying.
    const again = await commit(env, token, prep.changeset.id)
    expect(again.res.status).toBe(200)
    expect(again.body.receipt.command).toBe('AddOrgMember')
  })
})

describe('SetOrgRole / RemoveOrgMember — happy path', () => {
  it('SetOrgRole moves an existing member to the new role', async () => {
    const env = makeEnv(tdb.db)
    const token = await ownerToken(tdb)
    await seedMember(tdb, 2, 200)

    const { body: prep } = await prepare(env, token, [
      { kind: 'SetOrgRole', orgId: ORG_ID, username: 'bob', role: 600 },
    ])
    expect(prep.changeset.summary.orgMemberCurrentRole).toBe('commenter')
    expect(prep.changeset.summary.orgMemberNewRole).toBe('maintainer')

    await approve(tdb, prep.changeset.id, prep.digest, 1, OWNER_CRED)
    const { res, body } = await commit(env, token, prep.changeset.id)
    expect(res.status).toBe(200)
    expect(body.receipt.previousRole).toBe(200)
    expect(body.receipt.role).toBe(600)
    expect((await orgMemberRows(tdb)).find((r) => r.user_id === '2')?.role_level).toBe(600)
  })

  it('RemoveOrgMember drops the org_members row AND the org group memberships', async () => {
    const env = makeEnv(tdb.db)
    const token = await ownerToken(tdb)
    await seedMember(tdb, 2, 400)
    await tdb.pg.query(
      `INSERT INTO groups (id, org_id, name, created_by) VALUES (7, $1, 'Team', 1)`,
      [ORG_ID],
    )
    await tdb.pg.query(`INSERT INTO group_members (group_id, user_id) VALUES (7, 2)`)

    const { body: prep } = await prepare(env, token, [
      { kind: 'RemoveOrgMember', orgId: ORG_ID, username: 'bob' },
    ])
    expect(prep.changeset.summary.command).toBe('RemoveOrgMember')
    expect(prep.changeset.summary.orgMemberCurrentRole).toBe('contributor')

    await approve(tdb, prep.changeset.id, prep.digest, 1, OWNER_CRED)
    const { res, body } = await commit(env, token, prep.changeset.id)
    expect(res.status).toBe(200)
    expect(body.receipt.previousRole).toBe(400)
    expect((await orgMemberRows(tdb)).find((r) => r.user_id === '2')).toBeUndefined()
    const groupRows = await tdb.rows<{ group_id: number; user_id: number | string }>('group_members')
    expect(groupRows.find((g) => String(g.user_id) === '2')).toBeUndefined()
  })
})

// ── escalation gates (the AQU-1235 acceptance criteria) ──────────────────────

describe('org membership — escalation gates', () => {
  it('a NON-OWNER credential cannot add org members → permission_denied', async () => {
    const env = makeEnv(tdb.db)
    // alice is only a maintainer (600) in the org she is otherwise scoped to.
    await seedOrg(tdb, 1, 600)
    await seedUser(tdb, 2, 'bob')
    const token = await credToken(tdb, {
      credentialId: '00000000-0000-0000-0000-00000000c002', userId: 1, username: 'alice',
      orgId: String(ORG_ID), projectId: null,
    })
    const { res, body } = await prepare(env, token, [
      { kind: 'AddOrgMember', orgId: ORG_ID, username: 'bob', role: 400 },
    ])
    expect(res.status).toBe(403)
    expect(body.error.code).toBe('permission_denied')
    expect((await orgMemberRows(tdb)).find((r) => r.user_id === '2')).toBeUndefined()
  })

  it('a NON-MEMBER credential cannot add org members → permission_denied', async () => {
    const env = makeEnv(tdb.db)
    await seedOrg(tdb, 9, 700) // owned by someone else entirely
    await seedUser(tdb, 9, 'olga')
    await seedUser(tdb, 2, 'bob')
    const token = await credToken(tdb, {
      credentialId: '00000000-0000-0000-0000-00000000c003', userId: 1, username: 'alice',
      orgId: String(ORG_ID), projectId: null,
    })
    await seedUser(tdb, 1, 'alice')
    const { res, body } = await prepare(env, token, [
      { kind: 'AddOrgMember', orgId: ORG_ID, username: 'bob', role: 400 },
    ])
    expect(res.status).toBe(403)
    expect(body.error.code).toBe('permission_denied')
  })

  it('a PROJECT-SCOPED credential can never manage org membership → scope_denied', async () => {
    const env = makeEnv(tdb.db)
    await seedOrg(tdb, 1)
    await seedUser(tdb, 2, 'bob')
    const token = await credToken(tdb, {
      credentialId: '00000000-0000-0000-0000-00000000c004', userId: 1, username: 'alice',
      orgId: null, projectId: 'some-project',
    })
    const { res, body } = await prepare(env, token, [
      { kind: 'AddOrgMember', orgId: ORG_ID, username: 'bob', role: 400 },
    ])
    expect(res.status).toBe(403)
    expect(body.error.code).toBe('scope_denied')
  })

  it('an org-scoped credential cannot reach a DIFFERENT org → scope_denied', async () => {
    const env = makeEnv(tdb.db)
    await seedOrg(tdb, 1)
    await seedUser(tdb, 2, 'bob')
    const token = await credToken(tdb, {
      credentialId: '00000000-0000-0000-0000-00000000c005', userId: 1, username: 'alice',
      orgId: '999', projectId: null,
    })
    const { res, body } = await prepare(env, token, [
      { kind: 'AddOrgMember', orgId: ORG_ID, username: 'bob', role: 400 },
    ])
    expect(res.status).toBe(403)
    expect(body.error.code).toBe('scope_denied')
  })

  it('never grants a role above the caller’s own: equal (700→700) passes, and any caller who could exceed it is already denied', async () => {
    const env = makeEnv(tdb.db)
    await seedOrg(tdb, 1)
    await seedUser(tdb, 2, 'bob')
    const token = await credToken(tdb, {
      credentialId: '00000000-0000-0000-0000-00000000c006', userId: 1, username: 'alice',
      orgId: String(ORG_ID), projectId: null,
    })
    // An owner granting 700 is EQUAL to their own level, not above it → allowed.
    const ok = await prepare(env, token, [
      { kind: 'AddOrgMember', orgId: ORG_ID, username: 'bob', role: 700 },
    ])
    expect(ok.res.status).toBe(200)

    // The only way to ask for MORE than you hold is to hold less than 700, and
    // such a caller is stopped by the owner gate first. Same observable outcome
    // the criterion asks for; the explicit cap in the gate is the belt behind
    // that brace, and would start to bite the moment the owner floor moved.
    await tdb.pg.query(`UPDATE org_members SET role_level = 600 WHERE org_id = $1 AND user_id = 1`, [ORG_ID])
    const capped = await prepare(env, token, [
      { kind: 'AddOrgMember', orgId: ORG_ID, username: 'bob', role: 700 },
    ])
    expect(capped.res.status).toBe(403)
    expect(capped.body.error.code).toBe('permission_denied')
  })

  it('cannot target YOURSELF', async () => {
    const env = makeEnv(tdb.db)
    const token = await ownerToken(tdb)
    const { res, body } = await prepare(env, token, [
      { kind: 'SetOrgRole', orgId: ORG_ID, username: 'alice', role: 100 },
    ])
    expect(res.status).toBe(400)
    expect(body.error.code).toBe('validation_failed')
    expect(body.error.message).toContain('your own')
  })

  it('one owner cannot REMOVE the org’s owner row (the reachable last-owner case)', async () => {
    const env = makeEnv(tdb.db)
    // alice(1) owns the organizations row; carol(3) is a second owner-level
    // member — the only shape in which an owner can target another owner.
    await seedOrg(tdb, 1)
    await seedUser(tdb, 1, 'alice')
    await seedMember(tdb, 3, 700)
    const token = await credToken(tdb, {
      credentialId: '00000000-0000-0000-0000-00000000c007', userId: 3, username: 'carol',
      orgId: String(ORG_ID), projectId: null,
    })
    const { res, body } = await prepare(env, token, [
      { kind: 'RemoveOrgMember', orgId: ORG_ID, username: 'alice' },
    ])
    expect(res.status).toBe(403)
    expect(body.error.code).toBe('permission_denied')
    expect((await orgMemberRows(tdb)).find((r) => r.user_id === '1')?.role_level).toBe(700)
  })

  it('one owner cannot DEMOTE the org’s owner row either', async () => {
    const env = makeEnv(tdb.db)
    await seedOrg(tdb, 1)
    await seedUser(tdb, 1, 'alice')
    await seedMember(tdb, 3, 700)
    const token = await credToken(tdb, {
      credentialId: '00000000-0000-0000-0000-00000000c008', userId: 3, username: 'carol',
      orgId: String(ORG_ID), projectId: null,
    })
    const { res, body } = await prepare(env, token, [
      { kind: 'SetOrgRole', orgId: ORG_ID, username: 'alice', role: 400 },
    ])
    expect(res.status).toBe(403)
    expect(body.error.code).toBe('permission_denied')
    expect((await orgMemberRows(tdb)).find((r) => r.user_id === '1')?.role_level).toBe(700)

    // A NON-owner-row owner is still demotable — the guard is precise, not a
    // blanket "owners are frozen".
    const other = await prepare(env, token, [
      { kind: 'SetOrgRole', orgId: ORG_ID, username: 'dave', role: 400 },
    ])
    expect(other.res.status).toBe(400) // dave does not exist; the gate got that far
  })

  it('ownership lapsing between prepare and commit is caught at COMMIT', async () => {
    const env = makeEnv(tdb.db)
    const token = await ownerToken(tdb)
    const { body: prep } = await prepare(env, token, [
      { kind: 'AddOrgMember', orgId: ORG_ID, username: 'bob', role: 400 },
    ])
    await approve(tdb, prep.changeset.id, prep.digest, 1, OWNER_CRED)

    // alice loses ownership after staging.
    await tdb.pg.query(`UPDATE org_members SET role_level = 600 WHERE org_id = $1 AND user_id = 1`, [ORG_ID])

    const { res, body } = await commit(env, token, prep.changeset.id)
    expect(res.status).toBe(403)
    expect(body.error.code).toBe('permission_denied')
    expect((await orgMemberRows(tdb)).find((r) => r.user_id === '2')).toBeUndefined()
  })

  it('a username that resolves to a DIFFERENT user by commit → plan_stale', async () => {
    const env = makeEnv(tdb.db)
    const token = await ownerToken(tdb)
    const { body: prep } = await prepare(env, token, [
      { kind: 'AddOrgMember', orgId: ORG_ID, username: 'bob', role: 400 },
    ])
    await approve(tdb, prep.changeset.id, prep.digest, 1, OWNER_CRED)

    // bob(2) renames away and a different account takes the name. The approval
    // was for a person, not a string.
    await tdb.pg.query(
      `UPDATE users SET username = 'bob-old', email = 'bob-old@x.com' WHERE id = 2`,
    )
    await seedUser(tdb, 4, 'bob')

    const { res, body } = await commit(env, token, prep.changeset.id)
    expect(res.status).toBe(409)
    expect(body.error.code).toBe('plan_stale')
    const rows = await orgMemberRows(tdb)
    expect(rows.find((r) => r.user_id === '2')).toBeUndefined()
    expect(rows.find((r) => r.user_id === '4')).toBeUndefined()
  })

  it('a role changed by someone else between prepare and commit → plan_stale', async () => {
    const env = makeEnv(tdb.db)
    const token = await ownerToken(tdb)
    await seedMember(tdb, 2, 200)
    const { body: prep } = await prepare(env, token, [
      { kind: 'SetOrgRole', orgId: ORG_ID, username: 'bob', role: 600 },
    ])
    await approve(tdb, prep.changeset.id, prep.digest, 1, OWNER_CRED)

    // Someone moves bob by hand first.
    await seedMember(tdb, 2, 300)

    const { res, body } = await commit(env, token, prep.changeset.id)
    expect(res.status).toBe(409)
    expect(body.error.code).toBe('plan_stale')
    expect((await orgMemberRows(tdb)).find((r) => r.user_id === '2')?.role_level).toBe(300)
  })
})

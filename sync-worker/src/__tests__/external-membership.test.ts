// AQU-1185 — Agent API membership commands (InviteMember / SetRole /
// RemoveMember).
//
// The ticket's standing instruction for this surface: "privilege-escalation
// tests are not optional." So the bulk of this file is the refusals — a
// MAINTAINER credential trying to grant OWNER, remove an OWNER, elevate
// itself, or act on a peer — asserted at BOTH prepare and commit, because the
// caller's role and the target's role can both move while a changeset sits
// staged for its hour.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// commit.ts → events/route.ts → broadcast.ts → partyserver (cloudflare:*). The
// membership commands never route through /events, but the import graph still
// loads it, so the same mock the other external suites use is required.
vi.mock('partyserver', () => ({
  getServerByName: vi.fn().mockResolvedValue({
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  }),
}))

import { handleExternalChangesetsRequest } from '../external/changesets-route'
import { mintApiToken } from '../../../db/shared/api-credentials'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'

const SECRET = 'test-secret'
const PROJECT = 'proj-m'

// Users. `creator` owns PROJECT through the creator path (no direct row), which
// is the case the widened target cap exists for.
const CREATOR = { id: 1, name: 'creator' }
const CALLER = { id: 2, name: 'maintainer' }
const TARGET = { id: 3, name: 'ana' }
const PEER = { id: 4, name: 'peer' }
const OWNER_ROW = { id: 5, name: 'owner' }

const ROLE = {
  VIEWER: 100,
  REVIEWER: 300,
  CONTRIBUTOR: 400,
  PROJECT_LEAD: 500,
  MAINTAINER: 600,
  OWNER: 700,
}

function makeEnv(db: AquillaDb) {
  return { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET, BASE_URL: 'https://aquilla.app' }
}

let tdb: TestDb
beforeEach(async () => {
  tdb = await makeTestDb({})
})

async function seedUser(u: { id: number; name: string }): Promise<void> {
  await tdb.pg.query(
    `INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, 'h')
     ON CONFLICT (id) DO NOTHING`,
    [u.id, u.name, `${u.name}@x.com`],
  )
}

/** Seed the project (owned via creator path by CREATOR) plus every user. */
async function seedProject(): Promise<void> {
  for (const u of [CREATOR, CALLER, TARGET, PEER, OWNER_ROW]) await seedUser(u)
  await tdb.pg.query(`INSERT INTO projects (id, name, created_by) VALUES ($1, 'P', $2)`, [
    PROJECT,
    CREATOR.id,
  ])
}

async function setDirectRole(userId: number, level: number): Promise<void> {
  await tdb.pg.query(
    `INSERT INTO project_members (project_id, user_id, role_level) VALUES ($1, $2, $3)
     ON CONFLICT (project_id, user_id) DO UPDATE SET role_level = excluded.role_level`,
    [PROJECT, userId, level],
  )
}

async function clearDirectRole(userId: number): Promise<void> {
  await tdb.pg.query(`DELETE FROM project_members WHERE project_id = $1 AND user_id = $2`, [
    PROJECT,
    userId,
  ])
}

async function directRole(userId: number): Promise<number | null> {
  const r = await tdb.pg.query<{ role_level: number }>(
    `SELECT role_level FROM project_members WHERE project_id = $1 AND user_id = $2`,
    [PROJECT, userId],
  )
  return r.rows[0] ? Number(r.rows[0].role_level) : null
}

let credSeq = 0
/** Seed an api_credentials row for `user` and mint a live `aqk_` token. */
async function credToken(
  user: { id: number; name: string },
  mode: 'ask' | 'act' = 'act',
): Promise<{ token: string; credentialId: string }> {
  credSeq += 1
  const credentialId = `00000000-0000-0000-0000-${String(credSeq).padStart(12, '0')}`
  const { token, tokenHash, tokenPrefix } = await mintApiToken()
  await tdb.pg.query(
    `INSERT INTO api_credentials (id, user_id, name, token_prefix, token_hash, mode, org_id, project_id)
     VALUES ($1, $2, 'test', $3, $4, $5, NULL, $6)`,
    [credentialId, String(user.id), tokenPrefix, tokenHash, mode, PROJECT],
  )
  return { token, credentialId }
}

const url = `https://w/api/v1/external/projects/${PROJECT}/changesets`

async function prepare(token: string, commands: unknown) {
  const res = (await handleExternalChangesetsRequest(
    new Request(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands }),
    }),
    makeEnv(tdb.db),
  ))!
  return { res, body: (await res.json()) as any }
}

async function commit(token: string, id: string) {
  const res = (await handleExternalChangesetsRequest(
    new Request(`${url}/${id}/commit`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    }),
    makeEnv(tdb.db),
  ))!
  return { res, body: (await res.json()) as any }
}

/** Seed the human approval a membership changeset always needs (forced ask). */
async function approve(
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

/** The common case: CALLER is a direct MAINTAINER on the project. */
async function seedMaintainerCaller() {
  await seedProject()
  await setDirectRole(CALLER.id, ROLE.MAINTAINER)
  return credToken(CALLER)
}

// ── validation ───────────────────────────────────────────────────────────────

describe('membership — validation', () => {
  it('rejects a role level off the canonical ladder', async () => {
    const { token } = await seedMaintainerCaller()
    const { res, body } = await prepare(token, [
      { kind: 'InviteMember', projectId: PROJECT, username: TARGET.name, role: 450 },
    ])
    expect(res.status).toBe(400)
    expect(body.error.code).toBe('validation_failed')
  })

  it('rejects an empty username', async () => {
    const { token } = await seedMaintainerCaller()
    const { res, body } = await prepare(token, [
      { kind: 'RemoveMember', projectId: PROJECT, username: '' },
    ])
    expect(res.status).toBe(400)
    expect(body.error.code).toBe('validation_failed')
  })

  it('rejects membership mixed with another command kind', async () => {
    const { token } = await seedMaintainerCaller()
    const { res, body } = await prepare(token, [
      { kind: 'InviteMember', projectId: PROJECT, username: TARGET.name, role: ROLE.CONTRIBUTOR },
      { kind: 'SetTranslation', fileId: 'f1', cellId: 'c1', value: 'x' },
    ])
    expect(res.status).toBe(400)
    expect(body.error.code).toBe('validation_failed')
    expect(body.error.message).toMatch(/cannot be mixed/)
  })

  it('rejects two commands targeting the same person', async () => {
    const { token } = await seedMaintainerCaller()
    const { res, body } = await prepare(token, [
      { kind: 'InviteMember', projectId: PROJECT, username: TARGET.name, role: ROLE.CONTRIBUTOR },
      { kind: 'SetRole', projectId: PROJECT, username: TARGET.name.toUpperCase(), role: ROLE.REVIEWER },
    ])
    expect(res.status).toBe(400)
    expect(body.error.message).toMatch(/more than one membership command/)
  })

  it('rejects a projectId that is not the changeset project', async () => {
    const { token } = await seedMaintainerCaller()
    const { res, body } = await prepare(token, [
      { kind: 'InviteMember', projectId: 'other', username: TARGET.name, role: ROLE.CONTRIBUTOR },
    ])
    expect(res.status).toBe(400)
    expect(body.error.message).toMatch(/must match the changeset project/)
  })

  it('rejects an unknown target user with not_found', async () => {
    const { token } = await seedMaintainerCaller()
    const { res, body } = await prepare(token, [
      { kind: 'InviteMember', projectId: PROJECT, username: 'nobody', role: ROLE.CONTRIBUTOR },
    ])
    expect(res.status).toBe(404)
    expect(body.error.details.code).toBe('user_not_found')
  })
})

// ── the MAINTAINER floor ─────────────────────────────────────────────────────

describe('membership — role floor', () => {
  it('denies a PROJECT_LEAD caller (the UI floor for add-member is lower; the agent floor is not)', async () => {
    await seedProject()
    await setDirectRole(CALLER.id, ROLE.PROJECT_LEAD)
    const { token } = await credToken(CALLER)
    const { res, body } = await prepare(token, [
      { kind: 'InviteMember', projectId: PROJECT, username: TARGET.name, role: ROLE.CONTRIBUTOR },
    ])
    expect(res.status).toBe(403)
    expect(body.error.code).toBe('permission_denied')
    expect(body.error.details.requiredRole).toBe(600)
  })

  it('denies a caller with no project membership at all', async () => {
    await seedProject()
    const { token } = await credToken(CALLER)
    const { res, body } = await prepare(token, [
      { kind: 'RemoveMember', projectId: PROJECT, username: TARGET.name },
    ])
    expect(res.status).toBe(403)
    expect(body.error.code).toBe('permission_denied')
  })
})

// ── privilege escalation (the acceptance criteria) ───────────────────────────

describe('membership — escalation is refused server-side', () => {
  it('a MAINTAINER cannot grant OWNER', async () => {
    const { token } = await seedMaintainerCaller()
    const { res, body } = await prepare(token, [
      { kind: 'InviteMember', projectId: PROJECT, username: TARGET.name, role: ROLE.OWNER },
    ])
    expect(res.status).toBe(403)
    expect(body.error.code).toBe('permission_denied')
    expect(body.error.details.code).toBe('role_above_caller')
    expect(await directRole(TARGET.id)).toBeNull()
  })

  it('a MAINTAINER cannot remove an OWNER who holds a direct row', async () => {
    const { token } = await seedMaintainerCaller()
    await setDirectRole(OWNER_ROW.id, ROLE.OWNER)
    const { res, body } = await prepare(token, [
      { kind: 'RemoveMember', projectId: PROJECT, username: OWNER_ROW.name },
    ])
    expect(res.status).toBe(403)
    expect(body.error.details.code).toBe('target_outranks_caller')
    expect(await directRole(OWNER_ROW.id)).toBe(ROLE.OWNER)
  })

  it('a MAINTAINER cannot remove an OWNER who holds the project via the creator path (no direct row)', async () => {
    // The UI's cap reads the DIRECT row, which is absent here — this asserts the
    // widened effective-role cap that keeps the agent surface from no-op
    // "succeeding" against a project's actual owner.
    const { token } = await seedMaintainerCaller()
    const { res, body } = await prepare(token, [
      { kind: 'RemoveMember', projectId: PROJECT, username: CREATOR.name },
    ])
    expect(res.status).toBe(403)
    expect(body.error.details.code).toBe('target_outranks_caller')
  })

  it('a MAINTAINER cannot self-elevate', async () => {
    const { token } = await seedMaintainerCaller()
    const { res, body } = await prepare(token, [
      { kind: 'SetRole', projectId: PROJECT, username: CALLER.name, role: ROLE.OWNER },
    ])
    expect(res.status).toBe(403)
    // The grant cap fires first — OWNER is above the caller's own level either way.
    expect(body.error.details.code).toBe('role_above_caller')
    expect(await directRole(CALLER.id)).toBe(ROLE.MAINTAINER)
  })

  it('a MAINTAINER cannot act on themselves even at a role they could grant', async () => {
    const { token } = await seedMaintainerCaller()
    const { res, body } = await prepare(token, [
      { kind: 'SetRole', projectId: PROJECT, username: CALLER.name, role: ROLE.CONTRIBUTOR },
    ])
    expect(res.status).toBe(403)
    expect(body.error.details.code).toBe('self_target')
  })

  it('a MAINTAINER cannot demote a peer MAINTAINER', async () => {
    const { token } = await seedMaintainerCaller()
    await setDirectRole(PEER.id, ROLE.MAINTAINER)
    const { res, body } = await prepare(token, [
      { kind: 'SetRole', projectId: PROJECT, username: PEER.name, role: ROLE.CONTRIBUTOR },
    ])
    expect(res.status).toBe(403)
    expect(body.error.details.code).toBe('target_outranks_caller')
    expect(await directRole(PEER.id)).toBe(ROLE.MAINTAINER)
  })

  it('an OWNER may modify a MAINTAINER (positive control — the caps are role-relative, not blanket)', async () => {
    await seedProject()
    await setDirectRole(CALLER.id, ROLE.OWNER)
    await setDirectRole(PEER.id, ROLE.MAINTAINER)
    const { token, credentialId } = await credToken(CALLER)
    const { res, body } = await prepare(token, [
      { kind: 'SetRole', projectId: PROJECT, username: PEER.name, role: ROLE.CONTRIBUTOR },
    ])
    expect(res.status).toBe(200)
    await approve(body.changeset.id, body.digest, CALLER.id, credentialId)
    const done = await commit(token, body.changeset.id)
    expect(done.res.status).toBe(200)
    expect(await directRole(PEER.id)).toBe(ROLE.CONTRIBUTOR)
  })
})

// ── escalation re-checked LIVE at commit ─────────────────────────────────────

describe('membership — gates re-run at commit against the live role graph', () => {
  it('denies the commit when the caller was demoted after staging', async () => {
    const { token, credentialId } = await seedMaintainerCaller()
    const { body } = await prepare(token, [
      { kind: 'InviteMember', projectId: PROJECT, username: TARGET.name, role: ROLE.CONTRIBUTOR },
    ])
    await approve(body.changeset.id, body.digest, CALLER.id, credentialId)
    await setDirectRole(CALLER.id, ROLE.PROJECT_LEAD)

    const done = await commit(token, body.changeset.id)
    expect(done.res.status).toBe(403)
    expect(done.body.error.code).toBe('permission_denied')
    expect(await directRole(TARGET.id)).toBeNull()
  })

  it('denies the commit when the target outranks the caller by the time it lands', async () => {
    const { token, credentialId } = await seedMaintainerCaller()
    await setDirectRole(TARGET.id, ROLE.CONTRIBUTOR)
    const { body } = await prepare(token, [
      { kind: 'SetRole', projectId: PROJECT, username: TARGET.name, role: ROLE.REVIEWER },
    ])
    await approve(body.changeset.id, body.digest, CALLER.id, credentialId)
    await setDirectRole(TARGET.id, ROLE.OWNER)

    const done = await commit(token, body.changeset.id)
    expect(done.res.status).toBe(403)
    expect(done.body.error.details.code).toBe('target_outranks_caller')
    expect(await directRole(TARGET.id)).toBe(ROLE.OWNER)
  })
})

// ── ask-mode is forced ───────────────────────────────────────────────────────

describe('membership — always human-approved', () => {
  it('an act-mode credential still stages ask-mode and cannot commit without an approval', async () => {
    await seedProject()
    await setDirectRole(CALLER.id, ROLE.MAINTAINER)
    const { token } = await credToken(CALLER, 'act')
    const { res, body } = await prepare(token, [
      { kind: 'InviteMember', projectId: PROJECT, username: TARGET.name, role: ROLE.CONTRIBUTOR },
    ])
    expect(res.status).toBe(200)
    expect(body.changeset.autonomyMode).toBe('ask')

    const done = await commit(token, body.changeset.id)
    expect(done.res.status).toBe(428)
    expect(done.body.error.code).toBe('confirmation_required')
    expect(await directRole(TARGET.id)).toBeNull()
  })

  it('the staged summary names each change in plain language for the approval page', async () => {
    const { token } = await seedMaintainerCaller()
    await setDirectRole(PEER.id, ROLE.CONTRIBUTOR)
    const { body } = await prepare(token, [
      { kind: 'InviteMember', projectId: PROJECT, username: TARGET.name, role: ROLE.REVIEWER },
      { kind: 'RemoveMember', projectId: PROJECT, username: PEER.name },
    ])
    expect(body.summary.command).toBe('Membership')
    expect(body.summary.membershipChanges).toEqual([
      `Add ${TARGET.name} to ${PROJECT} as reviewer (300)`,
      `Remove ${PEER.name} from ${PROJECT}`,
    ])
  })
})

// ── happy path + audit trail ─────────────────────────────────────────────────

describe('membership — approved changes apply', () => {
  it('invites a reviewer at CONTRIBUTOR, a human approves, and the membership exists', async () => {
    const { token, credentialId } = await seedMaintainerCaller()
    const { res, body } = await prepare(token, [
      { kind: 'InviteMember', projectId: PROJECT, username: TARGET.name, role: ROLE.CONTRIBUTOR },
    ])
    expect(res.status).toBe(200)
    expect(await directRole(TARGET.id)).toBeNull() // nothing applied at prepare

    await approve(body.changeset.id, body.digest, CALLER.id, credentialId)
    const done = await commit(token, body.changeset.id)
    expect(done.res.status).toBe(200)
    expect(await directRole(TARGET.id)).toBe(ROLE.CONTRIBUTOR)

    // Audit: the receipt names the credential and exactly what it did to whom.
    expect(done.body.receipt.credentialId).toBe(credentialId)
    expect(done.body.receipt.command).toBe('Membership')
    expect(done.body.receipt.membership).toEqual([
      {
        kind: 'InviteMember',
        userId: String(TARGET.id),
        username: TARGET.name,
        role: ROLE.CONTRIBUTOR,
        previousRole: null,
      },
    ])
    // …and the changeset row itself still carries the staging credential.
    const rows = await tdb.rows<{ credential_id: string; status: string }>('changesets')
    expect(rows[0].credential_id).toBe(credentialId)
    expect(rows[0].status).toBe('committed')

    // `granted_by` attributes the row to the credential's human owner.
    const granted = await tdb.pg.query<{ granted_by: number }>(
      `SELECT granted_by FROM project_members WHERE project_id = $1 AND user_id = $2`,
      [PROJECT, TARGET.id],
    )
    expect(Number(granted.rows[0].granted_by)).toBe(CALLER.id)
  })

  it('removes a member and re-roles another in one approved batch', async () => {
    const { token, credentialId } = await seedMaintainerCaller()
    await setDirectRole(TARGET.id, ROLE.CONTRIBUTOR)
    await setDirectRole(PEER.id, ROLE.REVIEWER)
    const { body } = await prepare(token, [
      { kind: 'SetRole', projectId: PROJECT, username: TARGET.name, role: ROLE.PROJECT_LEAD },
      { kind: 'RemoveMember', projectId: PROJECT, username: PEER.name },
    ])
    await approve(body.changeset.id, body.digest, CALLER.id, credentialId)
    const done = await commit(token, body.changeset.id)
    expect(done.res.status).toBe(200)
    expect(await directRole(TARGET.id)).toBe(ROLE.PROJECT_LEAD)
    expect(await directRole(PEER.id)).toBeNull()
  })

  it('is idempotent on a repeated commit — the stored receipt is replayed, not re-applied', async () => {
    const { token, credentialId } = await seedMaintainerCaller()
    const { body } = await prepare(token, [
      { kind: 'InviteMember', projectId: PROJECT, username: TARGET.name, role: ROLE.CONTRIBUTOR },
    ])
    await approve(body.changeset.id, body.digest, CALLER.id, credentialId)
    await commit(token, body.changeset.id)
    await setDirectRole(TARGET.id, ROLE.REVIEWER) // a human re-roles them afterwards

    const again = await commit(token, body.changeset.id)
    expect(again.res.status).toBe(200)
    expect(await directRole(TARGET.id)).toBe(ROLE.REVIEWER) // untouched by the replay
  })
})

// ── state preconditions + drift ──────────────────────────────────────────────

describe('membership — state preconditions', () => {
  it('InviteMember on an existing direct member is a conflict, not a silent demotion', async () => {
    const { token } = await seedMaintainerCaller()
    await setDirectRole(TARGET.id, ROLE.PROJECT_LEAD)
    const { res, body } = await prepare(token, [
      { kind: 'InviteMember', projectId: PROJECT, username: TARGET.name, role: ROLE.VIEWER },
    ])
    expect(res.status).toBe(409)
    expect(body.error.details.code).toBe('already_member')
    expect(await directRole(TARGET.id)).toBe(ROLE.PROJECT_LEAD)
  })

  it('SetRole on someone with no direct row is a conflict', async () => {
    const { token } = await seedMaintainerCaller()
    const { res, body } = await prepare(token, [
      { kind: 'SetRole', projectId: PROJECT, username: TARGET.name, role: ROLE.CONTRIBUTOR },
    ])
    expect(res.status).toBe(409)
    expect(body.error.details.code).toBe('not_a_direct_member')
  })

  it('RemoveMember on someone with no direct row is a conflict', async () => {
    const { token } = await seedMaintainerCaller()
    const { res, body } = await prepare(token, [
      { kind: 'RemoveMember', projectId: PROJECT, username: TARGET.name },
    ])
    expect(res.status).toBe(409)
    expect(body.error.details.code).toBe('not_a_direct_member')
  })

  it('a plan a human already carried out commits as superseded, not stale', async () => {
    const { token, credentialId } = await seedMaintainerCaller()
    await setDirectRole(TARGET.id, ROLE.CONTRIBUTOR)
    const { body } = await prepare(token, [
      { kind: 'RemoveMember', projectId: PROJECT, username: TARGET.name },
    ])
    await approve(body.changeset.id, body.digest, CALLER.id, credentialId)
    await clearDirectRole(TARGET.id) // the human got there first

    const done = await commit(token, body.changeset.id)
    expect(done.res.status).toBe(409)
    expect(done.body.error.code).toBe('plan_stale')
    expect(done.body.error.details.status).toBe('superseded')
    const rows = await tdb.rows<{ status: string }>('changesets')
    expect(rows[0].status).toBe('superseded')
  })

  it('a SetRole whose target lost their direct row commits as stale', async () => {
    const { token, credentialId } = await seedMaintainerCaller()
    await setDirectRole(TARGET.id, ROLE.CONTRIBUTOR)
    const { body } = await prepare(token, [
      { kind: 'SetRole', projectId: PROJECT, username: TARGET.name, role: ROLE.REVIEWER },
    ])
    await approve(body.changeset.id, body.digest, CALLER.id, credentialId)
    await clearDirectRole(TARGET.id)

    const done = await commit(token, body.changeset.id)
    expect(done.res.status).toBe(409)
    expect(done.body.error.details.status).toBe('stale')
    expect(await directRole(TARGET.id)).toBeNull()
  })
})

// Tests for the receipt-only `CreateOrg` external command (AQU-1221).
//
// CreateOrg flows through the SAME prepare → commit changeset engine as
// CreateProject but creates a whole new TENANT, so the assertions here are
// about the `organizations` / `org_members` rows, the guardrails that keep an
// agent from minting one unattended or over-privileged (forced ask-mode,
// unscoped-credential-only, no billing fields, a per-credential throttle), and
// the end-to-end "create an org, then a project inside it" flow that used to
// stall at the first step.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// commit.ts → events/route.ts → broadcast.ts → partyserver (cloudflare:*). The
// tenant-lifecycle commands never route through /events, but the import graph
// still loads it, so the same mock the other external suites use is required.
vi.mock('partyserver', () => ({
  getServerByName: vi.fn().mockResolvedValue({
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  }),
}))

import { handleExternalChangesetsRequest } from '../external/changesets-route'
import { CREATE_ORG_MAX_PER_CREDENTIAL } from '../external/prepare'
import { mintApiToken } from '../../../db/shared/api-credentials'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'

const SECRET = 'test-secret'
/** The changeset's URL project id. For CreateOrg this is a FILING id only —
 *  no project by this id is ever created, which is exactly what the tests below
 *  assert. */
const FILING_PROJECT = 'filing-placeholder'

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

function changesetsUrl(projectId: string): string {
  return `https://w/api/v1/external/projects/${projectId}/changesets`
}

async function prepare(
  env: ReturnType<typeof makeEnv>,
  projectId: string,
  token: string,
  commands: unknown,
) {
  const req = new Request(changesetsUrl(projectId), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ commands }),
  })
  const res = (await handleExternalChangesetsRequest(req, env))!
  return { res, body: (await res.json()) as any }
}

async function commit(
  env: ReturnType<typeof makeEnv>,
  projectId: string,
  token: string,
  id: string,
) {
  const req = new Request(`${changesetsUrl(projectId)}/${id}/commit`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  })
  const res = (await handleExternalChangesetsRequest(req, env))!
  return { res, body: (await res.json()) as any }
}

/** Seed the one-time human approval a forced-ask-mode plan needs to commit. */
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
    .bind(
      // Full changeset id, not a prefix: UUIDv7 ids minted in the same test share
      // their leading timestamp characters, so a prefix collides.
      `conf-${changesetId}`,
      changesetId,
      String(userId),
      credentialId,
      digest,
      new Date(Date.now() + 60_000).toISOString(),
    )
    .run()
}

const UNSCOPED_CRED = '00000000-0000-0000-0000-00000000c001'

/** The default caller: an UNSCOPED credential — the only scope CreateOrg
 *  accepts — deliberately minted in `act` mode, so every happy-path test also
 *  proves ask-mode is FORCED rather than inherited. */
async function unscopedToken(tdb: TestDb, userId = 1, username = 'alice'): Promise<string> {
  return credToken(tdb, {
    credentialId: UNSCOPED_CRED,
    userId,
    username,
    orgId: null,
    projectId: null,
    mode: 'act',
  })
}

let tdb: TestDb
beforeEach(async () => {
  tdb = await makeTestDb({})
})

// ── validation / guardrails ──────────────────────────────────────────────────

describe('CreateOrg — validation', () => {
  it('rejects an empty name', async () => {
    const env = makeEnv(tdb.db)
    const token = await unscopedToken(tdb)
    const { res, body } = await prepare(env, FILING_PROJECT, token, [
      { kind: 'CreateOrg', name: '   ' },
    ])
    expect(res.status).toBe(400)
    expect(body.error.code).toBe('validation_failed')
  })

  it.each(['tier', 'plan', 'addonPacks', 'stripeCustomerId', 'entitlements', 'hardCapWords'])(
    'rejects the billing/entitlement field %s, naming it',
    async (field) => {
      const env = makeEnv(tdb.db)
      const token = await unscopedToken(tdb)
      const { res, body } = await prepare(env, FILING_PROJECT, token, [
        { kind: 'CreateOrg', name: 'Partner Co', [field]: 'enterprise' },
      ])
      expect(res.status).toBe(400)
      expect(body.error.code).toBe('validation_failed')
      // The field must be named, so the agent can self-correct rather than guess.
      expect(JSON.stringify(body.error.details)).toContain(field)
      expect(await tdb.rows('organizations')).toHaveLength(0)
    },
  )

  it('rejects any other unknown field, naming it', async () => {
    const env = makeEnv(tdb.db)
    const token = await unscopedToken(tdb)
    const { res, body } = await prepare(env, FILING_PROJECT, token, [
      { kind: 'CreateOrg', name: 'Partner Co', ownerUserId: 99 },
    ])
    expect(res.status).toBe(400)
    expect(body.error.code).toBe('validation_failed')
    expect(JSON.stringify(body.error.details)).toContain('ownerUserId')
  })

  it('must be the sole command in its changeset', async () => {
    const env = makeEnv(tdb.db)
    const token = await unscopedToken(tdb)
    const { res, body } = await prepare(env, FILING_PROJECT, token, [
      { kind: 'CreateOrg', name: 'Partner Co' },
      { kind: 'CreateProject', name: 'P' },
    ])
    expect(res.status).toBe(400)
    expect(body.error.code).toBe('validation_failed')
  })
})

// ── scope ────────────────────────────────────────────────────────────────────

describe('CreateOrg — scope', () => {
  it('an org-scoped credential cannot create an org (a new tenant is outside its scope)', async () => {
    const env = makeEnv(tdb.db)
    await tdb.pg.query(`INSERT INTO organizations (id, name, owner_user_id) VALUES (10, 'Org', 1)`)
    const token = await credToken(tdb, {
      credentialId: '00000000-0000-0000-0000-00000000c002',
      userId: 1,
      username: 'alice',
      orgId: '10',
      projectId: null,
    })
    const { res, body } = await prepare(env, FILING_PROJECT, token, [
      { kind: 'CreateOrg', name: 'Partner Co' },
    ])
    expect(res.status).toBe(403)
    expect(body.error.code).toBe('scope_denied')
  })

  it('a project-scoped credential cannot create an org', async () => {
    const env = makeEnv(tdb.db)
    const token = await credToken(tdb, {
      credentialId: '00000000-0000-0000-0000-00000000c003',
      userId: 1,
      username: 'alice',
      orgId: null,
      projectId: 'proj-a',
    })
    const { res, body } = await prepare(env, FILING_PROJECT, token, [
      { kind: 'CreateOrg', name: 'Partner Co' },
    ])
    expect(res.status).toBe(403)
    expect(body.error.code).toBe('scope_denied')
  })
})

// ── happy path ───────────────────────────────────────────────────────────────

describe('CreateOrg — happy path', () => {
  it('is ALWAYS staged ask-mode, summarizes the org + owner, and on approval creates the org with the minting user as OWNER', async () => {
    const env = makeEnv(tdb.db)
    const token = await unscopedToken(tdb) // mode: 'act'

    const { body: prep } = await prepare(env, FILING_PROJECT, token, [
      { kind: 'CreateOrg', name: 'Partner Co' },
    ])
    expect(prep.changeset.status).toBe('staged')
    // Forced ask-mode regardless of the act credential — a tenant is never
    // minted unattended.
    expect(prep.changeset.autonomyMode).toBe('ask')
    // The approval page renders these two facts in plain language.
    expect(prep.summary.command).toBe('CreateOrg')
    expect(prep.summary.orgName).toBe('Partner Co')
    expect(prep.summary.orgOwner).toBe('alice')
    expect(prep.approvalUrl).toContain(prep.changeset.id)

    // A direct commit without approval is refused — nothing created.
    const denied = await commit(env, FILING_PROJECT, token, prep.changeset.id)
    expect(denied.res.status).toBe(428)
    expect(denied.body.error.code).toBe('confirmation_required')
    expect(await tdb.rows('organizations')).toHaveLength(0)

    await seedConfirmation(tdb, prep.changeset.id, prep.digest, 1, UNSCOPED_CRED)

    const { res, body } = await commit(env, FILING_PROJECT, token, prep.changeset.id)
    expect(res.status).toBe(200)
    expect(body.receipt.command).toBe('CreateOrg')
    expect(typeof body.receipt.orgId).toBe('number')
    // No project is involved, so the receipt carries no project id.
    expect(body.receipt.projectId).toBeUndefined()

    const orgs = await tdb.rows<{ id: number; name: string; owner_user_id: string }>('organizations')
    expect(orgs).toHaveLength(1)
    expect(orgs[0].name).toBe('Partner Co')
    expect(String(orgs[0].owner_user_id)).toBe('1')
    expect(Number(orgs[0].id)).toBe(body.receipt.orgId)

    // Owner assignment: the minting user holds role 700 in the new org…
    const members = await tdb.rows<{ org_id: string; user_id: string; role_level: number }>('org_members')
    expect(members).toHaveLength(1)
    expect(String(members[0].user_id)).toBe('1')
    expect(members[0].role_level).toBe(700)

    // …and the default tier is "no billing row at all" — the agent surface has
    // no path to plan/entitlement state.
    expect(await tdb.rows('org_billing')).toHaveLength(0)
    // The filing project id really is a placeholder: no project was created.
    expect(await tdb.rows('projects')).toHaveLength(0)
  })

  it('unblocks the stalled flow: the same credential can then CreateProject into the new org', async () => {
    const env = makeEnv(tdb.db)
    const token = await unscopedToken(tdb)

    const { body: orgPrep } = await prepare(env, FILING_PROJECT, token, [
      { kind: 'CreateOrg', name: 'Partner Co' },
    ])
    await seedConfirmation(tdb, orgPrep.changeset.id, orgPrep.digest, 1, UNSCOPED_CRED)
    const { body: orgCommit } = await commit(env, FILING_PROJECT, token, orgPrep.changeset.id)
    const orgId: number = orgCommit.receipt.orgId

    // The creator's org membership is what carries them over the CreateProject
    // org-role floor (MAINTAINER) — no human had to create the org shell first.
    const { body: projPrep } = await prepare(env, 'partner-proj', token, [
      { kind: 'CreateProject', name: 'Partner Project', orgId },
    ])
    expect(projPrep.changeset.status).toBe('staged')
    await seedConfirmation(tdb, projPrep.changeset.id, projPrep.digest, 1, UNSCOPED_CRED)

    const { res, body } = await commit(env, 'partner-proj', token, projPrep.changeset.id)
    expect(res.status).toBe(200)
    expect(body.receipt.command).toBe('CreateProject')

    const projects = await tdb.rows<{ id: string; org_id: string }>('projects')
    expect(projects).toHaveLength(1)
    expect(projects[0].id).toBe('partner-proj')
    expect(String(projects[0].org_id)).toBe(String(orgId))
  })

  it('a crash-retry re-committing the same plan absorbs its own prior insert instead of minting a second org', async () => {
    const env = makeEnv(tdb.db)
    const token = await unscopedToken(tdb)

    const { body: prep } = await prepare(env, FILING_PROJECT, token, [
      { kind: 'CreateOrg', name: 'Partner Co' },
    ])
    await seedConfirmation(tdb, prep.changeset.id, prep.digest, 1, UNSCOPED_CRED)
    const first = await commit(env, FILING_PROJECT, token, prep.changeset.id)
    const orgId: number = first.body.receipt.orgId

    // Simulate the crash window: the org row landed, but the process died
    // before the receipt was written, leaving the changeset in `committing`.
    await tdb.db
      .prepare(`UPDATE changesets SET status = 'committing', receipt = NULL WHERE id = ?`)
      .bind(prep.changeset.id)
      .run()

    const retry = await commit(env, FILING_PROJECT, token, prep.changeset.id)
    expect(retry.res.status).toBe(200)
    expect(retry.body.receipt.orgId).toBe(orgId)
    expect(await tdb.rows('organizations')).toHaveLength(1)
  })
})

// ── rate limiting ────────────────────────────────────────────────────────────

describe('CreateOrg — rate limiting', () => {
  it(`rejects staging past ${CREATE_ORG_MAX_PER_CREDENTIAL} creations per credential with rate_limited`, async () => {
    const env = makeEnv(tdb.db)
    const token = await unscopedToken(tdb)

    for (let i = 0; i < CREATE_ORG_MAX_PER_CREDENTIAL; i += 1) {
      const { res } = await prepare(env, `${FILING_PROJECT}-${i}`, token, [
        { kind: 'CreateOrg', name: `Partner ${i}` },
      ])
      expect(res.status).toBe(200)
    }

    const { res, body } = await prepare(env, `${FILING_PROJECT}-over`, token, [
      { kind: 'CreateOrg', name: 'One Too Many' },
    ])
    expect(res.status).toBe(429)
    expect(body.error.code).toBe('rate_limited')
    // The documented limit is stated in the message so the agent can back off.
    expect(body.error.message).toContain(String(CREATE_ORG_MAX_PER_CREDENTIAL))
  })
})

// No-AI-credits regression guard for the external Agent API (design §5, W3-B).
//
// WHY this test exists: external agents bring their OWN models — Aquilla incurs
// no LLM/inference cost on the external write path, so the external API must
// NEVER accrue AI credits. The billing rails (`llm`/`agent`/`tts`) roll up into
// org_credit_usage_daily; an external commit that touched that table would mean
// Aquilla was billing a customer for compute it never spent. This is a
// by-construction invariant (the external path calls no LLM and never calls
// recordCredit) — this test is the enforcement that keeps it true.
//
// It runs a full external commit of each write shape that lands real state — an
// event commit (SetTranslation) and a receipt-only commit (CreateProject) — and
// asserts org_credit_usage_daily has ZERO rows afterward. If a future change
// wires a credit write into the external path (or shares a helper that does),
// this fails loudly.
//
// See docs/superpowers/specs/2026-07-17-agent-api-v1.1-design.md §5.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// commit.ts → events/route.ts → broadcast.ts → partyserver (cloudflare:*).
vi.mock('partyserver', () => ({
  getServerByName: vi.fn().mockResolvedValue({
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  }),
}))

import { handleExternalChangesetsRequest } from '../external/changesets-route'
import { mintApiToken } from '../../../db/shared/api-credentials'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'

const SECRET = 'test-secret'
const PROJECT = 'proj-a'
const FILE = 'file-x'
const ORG_ID = 77

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

function prepareReq(projectId: string, token: string, commands: unknown[]): Request {
  return new Request(`https://w/api/v1/external/projects/${projectId}/changesets`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ commands }),
  })
}

function commitReq(projectId: string, token: string, id: string): Request {
  return new Request(`https://w/api/v1/external/projects/${projectId}/changesets/${id}/commit`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'x-agent-meta': JSON.stringify({ model: 'byo-model' }) },
  })
}

async function prepare(env: ReturnType<typeof makeEnv>, projectId: string, token: string, commands: unknown[]) {
  const res = (await handleExternalChangesetsRequest(prepareReq(projectId, token, commands), env))!
  return { res, body: (await res.json()) as any }
}

async function commit(env: ReturnType<typeof makeEnv>, projectId: string, token: string, id: string) {
  const res = (await handleExternalChangesetsRequest(commitReq(projectId, token, id), env))!
  return { res, body: (await res.json()) as any }
}

/** Seed a project that BELONGS to an org — so that if any credit write ever
 *  fired on the external path, it would have a concrete org to attribute to and
 *  a row would appear. A row-less table is only meaningful if attribution was
 *  possible. */
async function seedOrgProject(): Promise<TestDb> {
  const tdb = await makeTestDb({
    organizations: [{ id: ORG_ID, name: 'Billing Org', owner_user_id: 99 }],
    projects: [{ id: PROJECT, name: 'P', created_by: 99, org_id: ORG_ID }],
    project_members: [{ project_id: PROJECT, user_id: 1, role_level: 400 }], // alice: contributor
    cells: [
      {
        project_id: PROJECT, file_id: FILE, cell_id: 'cell-1', side: 'source',
        value: 'source one', event_id: 'src-evt-1', last_edit_at: 1,
      },
    ],
  })
  await tdb.pg.query(
    `INSERT INTO users (id, username, email, password_hash) VALUES (99, 'owner', 'owner@x.com', 'h')
     ON CONFLICT (id) DO NOTHING`,
  )
  return tdb
}

let tdb: TestDb
beforeEach(async () => {
  tdb = await seedOrgProject()
})

describe('external API accrues zero AI credits (design §5 billing guard)', () => {
  it('a SetTranslation event commit leaves org_credit_usage_daily untouched', async () => {
    const env = makeEnv(tdb.db)
    // Project-scoped act credential (org-attributed via the project's org_id).
    const token = await credToken(tdb, {
      credentialId: '00000000-0000-0000-0000-0000000000a1', userId: 1, username: 'alice',
      orgId: String(ORG_ID), projectId: PROJECT, mode: 'act',
    })

    const { body: prep } = await prepare(env, PROJECT, token, [
      { kind: 'SetTranslation', fileId: FILE, cellId: 'cell-1', value: 'hola' },
    ])
    const { res, body } = await commit(env, PROJECT, token, prep.changeset.id)

    // The write really happened — this is a genuine external commit, not a no-op.
    expect(res.status).toBe(200)
    expect(body.receipt.appliedCount).toBe(1)
    const targets = (await tdb.rows<{ side: string; value: string }>('cells')).filter((c) => c.side === 'target')
    expect(targets).toHaveLength(1)
    expect(targets[0].value).toBe('hola')

    // …and it charged NOTHING. Zero rows across every billing rail.
    expect(await tdb.rows('org_credit_usage_daily')).toHaveLength(0)
  })

  it('a CreateProject receipt-only commit leaves org_credit_usage_daily untouched', async () => {
    const env = makeEnv(tdb.db)
    // Org-scoped maintainer credential. CreateProject is ALWAYS staged ask-mode
    // (blocker 3), so even this act credential needs a seeded human approval to
    // commit — the point of THIS test is only that the commit charges no credits.
    await tdb.pg.query(
      `INSERT INTO org_members (org_id, user_id, role_level) VALUES ($1, 1, 600)`,
      [ORG_ID],
    )
    const token = await credToken(tdb, {
      credentialId: '00000000-0000-0000-0000-0000000000a2', userId: 1, username: 'alice',
      orgId: String(ORG_ID), projectId: null, mode: 'act',
    })

    const { body: prep } = await prepare(env, 'brand-new', token, [
      { kind: 'CreateProject', name: 'Brand New', orgId: ORG_ID },
    ])
    await tdb.db
      .prepare(
        `INSERT INTO changeset_confirmations (id, changeset_id, user_id, credential_id, digest, expires_at, consumed_at)
         VALUES (?, ?, '1', ?, ?, ?, NULL)`,
      )
      .bind('conf-nc', prep.changeset.id, '00000000-0000-0000-0000-0000000000a2', prep.digest, new Date(Date.now() + 60_000).toISOString())
      .run()
    const { res, body } = await commit(env, 'brand-new', token, prep.changeset.id)

    // The project really got created (receipt-only apply landed a row).
    expect(res.status).toBe(200)
    expect(body.receipt.command).toBe('CreateProject')
    expect((await tdb.rows<{ id: string }>('projects')).some((p) => p.id === 'brand-new')).toBe(true)

    // …and it charged NOTHING.
    expect(await tdb.rows('org_credit_usage_daily')).toHaveLength(0)
  })
})

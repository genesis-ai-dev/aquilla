// Tests for the Agent API changeset engine (AQU-533 §3 + §2 provenance).
//
// Exercises the full prepare → commit pipeline through the same /events
// perimeter the in-app path uses: real events + projection rows land, and the
// server-stamped provenance envelope is written. Covers ask/act autonomy,
// one-time confirmation consumption, precondition drift (plan_stale), scope
// denial, and role enforcement (which comes free via the perimeter — asserted).

import { describe, it, expect, vi, beforeEach } from 'vitest'

// commit.ts → events/route.ts → broadcast.ts → partyserver (cloudflare:*).
vi.mock('partyserver', () => ({
  getServerByName: vi.fn().mockResolvedValue({
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  }),
}))

import { handleExternalChangesetsRequest } from '../external/changesets-route'
import { handleEventsWriteRequest } from '../events/route'
import {
  makeStubCredentialToken,
  type ApiCredentialContext,
} from '../external/__stubs__/api-credentials'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'
import { makeTestToken } from './helpers/auth'
import type { RawEvent } from '../events/types'

const SECRET = 'test-secret'
const PROJECT = 'proj-a'
const FILE = 'file-x'

function makeEnv(db: AquillaDb) {
  return { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET, BASE_URL: 'https://aquilla.app' }
}

/** Contributor (role 400) credential owned by user 1, scoped to PROJECT. */
function contributorCred(overrides: Partial<ApiCredentialContext> = {}): ApiCredentialContext {
  return {
    credentialId: 'cred-1',
    userId: 1,
    username: 'alice',
    orgId: null,
    projectId: PROJECT,
    autonomyMode: 'act',
    ...overrides,
  }
}

async function seedProject(): Promise<TestDb> {
  return makeTestDb({
    projects: [{ id: PROJECT, name: 'P', created_by: 99, org_id: null }],
    project_members: [
      { project_id: PROJECT, user_id: 1, role_level: 400 }, // alice: contributor
      { project_id: PROJECT, user_id: 2, role_level: 100 }, // vic: viewer
    ],
    cells: [
      {
        project_id: PROJECT, file_id: FILE, cell_id: 'cell-1', side: 'source',
        value: 'source one', event_id: 'src-evt-1', last_edit_at: 1,
      },
      {
        project_id: PROJECT, file_id: FILE, cell_id: 'cell-2', side: 'source',
        value: 'source two', event_id: 'src-evt-2', last_edit_at: 1,
      },
    ],
  })
}

function prepareReq(token: string, body: unknown): Request {
  return new Request(`https://w/api/v1/external/projects/${PROJECT}/changesets`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function commitReq(token: string, id: string, agentMeta?: unknown): Request {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
  if (agentMeta !== undefined) headers['x-agent-meta'] = JSON.stringify(agentMeta)
  return new Request(
    `https://w/api/v1/external/projects/${PROJECT}/changesets/${id}/commit`,
    { method: 'POST', headers },
  )
}

async function prepare(env: ReturnType<typeof makeEnv>, token: string, commands: unknown, extra: Record<string, unknown> = {}) {
  const res = (await handleExternalChangesetsRequest(prepareReq(token, { commands, ...extra }), env))!
  return { res, body: (await res.json()) as any }
}

/** Insert an ask-mode confirmation directly (stands in for the approval page). */
async function insertConfirmation(
  db: AquillaDb,
  args: { id: string; changesetId: string; credentialId: string; digest: string; consumed?: boolean; expired?: boolean },
): Promise<void> {
  const expiresAt = new Date(Date.now() + (args.expired ? -1000 : 60_000)).toISOString()
  const consumedAt = args.consumed ? new Date().toISOString() : null
  await db
    .prepare(
      `INSERT INTO changeset_confirmations
         (id, changeset_id, user_id, credential_id, digest, expires_at, consumed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(args.id, args.changesetId, '1', args.credentialId, args.digest, expiresAt, consumedAt)
    .run()
}

let tdb: TestDb
beforeEach(async () => {
  tdb = await seedProject()
})

// ── prepare → commit happy path ────────────────────────────────────────────

describe('changesets — prepare → commit (act mode)', () => {
  it('lands real events + projection rows with provenance stamped', async () => {
    const env = makeEnv(tdb.db)
    const token = makeStubCredentialToken(contributorCred())

    const { body: prep } = await prepare(env, token, [
      { kind: 'SetTranslation', fileId: FILE, cellId: 'cell-1', value: 'hello', valueHtml: '<p>hello</p>' },
    ])
    expect(prep.summary.translationsAdded).toBe(1)
    expect(prep.summary.translationsModified).toBe(0)
    expect(prep.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(prep.approvalUrl).toBe(`https://aquilla.app/approve/${prep.changeset.id}`)

    const res = (await handleExternalChangesetsRequest(commitReq(token, prep.changeset.id, { model: 'claude' }), env))!
    expect(res.status).toBe(200)
    const commitBody = (await res.json()) as any
    expect(commitBody.receipt.appliedCount).toBe(1)
    expect(commitBody.receipt.eventIds).toHaveLength(1)

    // Real event landed.
    const events = await tdb.rows<{ id: string; kind: string; provenance: unknown; author: string }>('events')
    const commit = events.find((e) => e.kind === 'target.cell.commit')
    expect(commit).toBeDefined()
    expect(commit!.author).toBe('alice')

    // Provenance envelope stamped (server-verified fields).
    const prov = typeof commit!.provenance === 'string' ? JSON.parse(commit!.provenance) : commit!.provenance
    expect(prov.origin).toBe('agent')
    expect(prov.channel).toBe('rest')
    expect(prov.autonomy_mode).toBe('act')
    expect(prov.changeset_id).toBe(prep.changeset.id)
    expect(prov.human_authority).toEqual({ user_id: '1', credential_id: 'cred-1' })
    expect(prov.agent).toEqual({ model: 'claude' }) // caller-declared, recorded verbatim
    expect(prov.confirmation_id).toBeUndefined() // act mode: no confirmation

    // Projection row: target cell value + AD-9 source pin.
    const cells = await tdb.rows<{ side: string; value: string; source_event_id: string | null }>('cells')
    const target = cells.find((c) => c.side === 'target')
    expect(target?.value).toBe('hello')
    expect(target?.source_event_id).toBe('src-evt-1') // pinned to current source head

    // Changeset marked committed with a receipt.
    const cs = await tdb.rows<{ status: string; receipt: unknown }>('changesets')
    expect(cs[0].status).toBe('committed')
    expect(cs[0].receipt).not.toBeNull()
  })

  it('summary counts: added vs modified vs missing', async () => {
    const env = makeEnv(tdb.db)
    const token = makeStubCredentialToken(contributorCred())

    // Give cell-2 an existing target head so it counts as "modified".
    const seedTok = await makeTestToken(SECRET, { projectId: PROJECT, fileId: FILE, userId: 1, username: 'alice', role: 400 })
    const create: RawEvent<'target.cell.create'> = {
      id: 'pre-target-c2', schemaVersion: 1, kind: 'target.cell.create',
      projectId: PROJECT, fileId: FILE, cellId: 'cell-2', parentId: null,
      author: 'alice', payload: { cellId: 'cell-2', value: 'existing' }, clientTs: 1,
    }
    await handleEventsWriteRequest(
      new Request('https://w/events', {
        method: 'POST', headers: { Authorization: `Bearer ${seedTok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ events: [create] }),
      }),
      makeEnv(tdb.db),
    )

    const { body: prep } = await prepare(env, token, [
      { kind: 'SetTranslation', fileId: FILE, cellId: 'cell-1', value: 'a' }, // source only → added
      { kind: 'SetTranslation', fileId: FILE, cellId: 'cell-2', value: 'b' }, // has target → modified
      { kind: 'SetTranslation', fileId: FILE, cellId: 'cell-99', value: 'c' }, // no cell → missing
    ])
    expect(prep.summary.translationsAdded).toBe(1)
    expect(prep.summary.translationsModified).toBe(1)
    const missing = prep.summary.warnings.filter((w: any) => w.code === 'missing_cell')
    expect(missing).toHaveLength(1)
    expect(missing[0].cellId).toBe('cell-99')
  })
})

// ── ask-mode confirmation ────────────────────────────────────────────────────

describe('changesets — ask-mode confirmation', () => {
  it('commit without a confirmation → confirmation_required', async () => {
    const env = makeEnv(tdb.db)
    const token = makeStubCredentialToken(contributorCred({ autonomyMode: 'ask' }))
    const { body: prep } = await prepare(env, token, [
      { kind: 'SetTranslation', fileId: FILE, cellId: 'cell-1', value: 'x' },
    ])
    expect(prep.changeset.autonomyMode).toBe('ask')

    const res = (await handleExternalChangesetsRequest(commitReq(token, prep.changeset.id), env))!
    expect(res.status).toBe(428)
    expect((await res.json() as any).error.code).toBe('confirmation_required')

    // Nothing applied.
    const events = await tdb.rows('events')
    expect(events.filter((e: any) => e.kind === 'target.cell.commit')).toHaveLength(0)
  })

  it('consumed or expired confirmation → confirmation_required', async () => {
    const env = makeEnv(tdb.db)
    const token = makeStubCredentialToken(contributorCred({ autonomyMode: 'ask' }))
    const { body: prep } = await prepare(env, token, [
      { kind: 'SetTranslation', fileId: FILE, cellId: 'cell-1', value: 'x' },
    ])

    await insertConfirmation(tdb.db, {
      id: 'conf-consumed', changesetId: prep.changeset.id, credentialId: 'cred-1',
      digest: prep.digest, consumed: true,
    })
    await insertConfirmation(tdb.db, {
      id: 'conf-expired', changesetId: prep.changeset.id, credentialId: 'cred-1',
      digest: prep.digest, expired: true,
    })

    const res = (await handleExternalChangesetsRequest(commitReq(token, prep.changeset.id), env))!
    expect(res.status).toBe(428)
    expect((await res.json() as any).error.code).toBe('confirmation_required')
  })

  it('valid confirmation commits once; a second commit returns the receipt without double-applying', async () => {
    const env = makeEnv(tdb.db)
    const token = makeStubCredentialToken(contributorCred({ autonomyMode: 'ask' }))
    const { body: prep } = await prepare(env, token, [
      { kind: 'SetTranslation', fileId: FILE, cellId: 'cell-1', value: 'approved' },
    ])
    await insertConfirmation(tdb.db, {
      id: 'conf-ok', changesetId: prep.changeset.id, credentialId: 'cred-1', digest: prep.digest,
    })

    const res1 = (await handleExternalChangesetsRequest(commitReq(token, prep.changeset.id), env))!
    expect(res1.status).toBe(200)
    const r1 = (await res1.json()) as any
    expect(r1.receipt.appliedCount).toBe(1)

    // Confirmation is now consumed exactly once.
    const conf = await tdb.rows<{ consumed_at: unknown }>('changeset_confirmations')
    expect(conf[0].consumed_at).not.toBeNull()

    // Provenance carries the consumed confirmation id.
    const events = await tdb.rows<{ kind: string; provenance: unknown }>('events')
    const commit = events.find((e) => e.kind === 'target.cell.commit')!
    const prov = typeof commit.provenance === 'string' ? JSON.parse(commit.provenance) : commit.provenance
    expect(prov.confirmation_id).toBe('conf-ok')

    // Second commit: idempotent, no new events.
    const res2 = (await handleExternalChangesetsRequest(commitReq(token, prep.changeset.id), env))!
    expect(res2.status).toBe(200)
    const r2 = (await res2.json()) as any
    expect(r2.receipt.eventIds).toEqual(r1.receipt.eventIds)

    const commitEvents = (await tdb.rows('events')).filter((e: any) => e.kind === 'target.cell.commit')
    expect(commitEvents).toHaveLength(1) // NOT double-applied
  })
})

// ── precondition drift → plan_stale ─────────────────────────────────────────

describe('changesets — precondition drift', () => {
  it('a direct write between prepare and commit yields 409 plan_stale + status stale', async () => {
    const env = makeEnv(tdb.db)
    const token = makeStubCredentialToken(contributorCred())
    const { body: prep } = await prepare(env, token, [
      { kind: 'SetTranslation', fileId: FILE, cellId: 'cell-1', value: 'planned' },
    ])

    // Interleave a direct target.cell.commit — moves cell-1's target head from
    // null to a real event id, drifting the pinned precondition.
    const seedTok = await makeTestToken(SECRET, { projectId: PROJECT, fileId: FILE, userId: 1, username: 'alice', role: 400 })
    const interleave: RawEvent<'target.cell.commit'> = {
      id: 'interleave-1', schemaVersion: 1, kind: 'target.cell.commit',
      projectId: PROJECT, fileId: FILE, cellId: 'cell-1', parentId: null,
      author: 'alice', payload: { value: 'someone else' }, clientTs: 5,
    }
    await handleEventsWriteRequest(
      new Request('https://w/events', {
        method: 'POST', headers: { Authorization: `Bearer ${seedTok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ events: [interleave] }),
      }),
      makeEnv(tdb.db),
    )

    const res = (await handleExternalChangesetsRequest(commitReq(token, prep.changeset.id), env))!
    expect(res.status).toBe(409)
    const body = (await res.json()) as any
    expect(body.error.code).toBe('plan_stale')

    const cs = await tdb.rows<{ status: string }>('changesets')
    expect(cs[0].status).toBe('stale')

    // The planned value never overwrote the interleaved write.
    const target = (await tdb.rows<{ side: string; value: string }>('cells')).find((c) => c.side === 'target')
    expect(target?.value).toBe('someone else')

    // A subsequent commit on a stale changeset stays plan_stale.
    const res2 = (await handleExternalChangesetsRequest(commitReq(token, prep.changeset.id), env))!
    expect(res2.status).toBe(409)
    expect((await res2.json() as any).error.code).toBe('plan_stale')
  })
})

// ── scope denial ────────────────────────────────────────────────────────────

describe('changesets — credential scope', () => {
  it('prepare for a project outside the credential scope → scope_denied', async () => {
    const env = makeEnv(tdb.db)
    const token = makeStubCredentialToken(contributorCred({ projectId: 'other-project' }))
    const res = (await handleExternalChangesetsRequest(
      prepareReq(token, { commands: [{ kind: 'SetTranslation', fileId: FILE, cellId: 'cell-1', value: 'x' }] }),
      env,
    ))!
    expect(res.status).toBe(403)
    expect((await res.json() as any).error.code).toBe('scope_denied')
  })

  it('an invalid credential → permission_denied', async () => {
    const env = makeEnv(tdb.db)
    const res = (await handleExternalChangesetsRequest(prepareReq('not-a-key', { commands: [] }), env))!
    expect(res.status).toBe(403)
    expect((await res.json() as any).error.code).toBe('permission_denied')
  })
})

// ── role enforcement via the perimeter ──────────────────────────────────────

describe('changesets — role enforcement (via /events perimeter)', () => {
  it("a viewer-role user's credential cannot commit translations", async () => {
    const env = makeEnv(tdb.db)
    // Credential owned by user 2, who is only a VIEWER (role 100) on the project.
    const token = makeStubCredentialToken(
      contributorCred({ credentialId: 'cred-viewer', userId: 2, username: 'vic' }),
    )

    // Prepare succeeds (staging is not gated on write role).
    const { body: prep } = await prepare(env, token, [
      { kind: 'SetTranslation', fileId: FILE, cellId: 'cell-1', value: 'nope' },
    ])
    expect(prep.changeset.status).toBe('staged')

    // Commit is rejected — target.cell.commit needs CONTRIBUTOR(400); the
    // internal token carries the live-resolved viewer role, so the perimeter
    // 403s and no event is applied.
    const res = (await handleExternalChangesetsRequest(commitReq(token, prep.changeset.id), env))!
    expect(res.status).toBe(403)
    expect((await res.json() as any).error.code).toBe('permission_denied')

    const commits = (await tdb.rows('events')).filter((e: any) => e.kind === 'target.cell.commit')
    expect(commits).toHaveLength(0)
    const target = (await tdb.rows<{ side: string }>('cells')).find((c) => c.side === 'target')
    expect(target).toBeUndefined()
  })
})

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
import { mintApiToken } from '../../../db/shared/api-credentials'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'
import { makeTestToken } from './helpers/auth'
import type { RawEvent } from '../events/types'

const SECRET = 'test-secret'
const PROJECT = 'proj-a'
const FILE = 'file-x'
const CRED_1 = '00000000-0000-0000-0000-000000000001'
const CRED_VIEWER = '00000000-0000-0000-0000-000000000002'

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

/** Contributor (role 400) credential owned by user 1, scoped to PROJECT. */
function contributorCred(overrides: Partial<CredSpec> = {}): CredSpec {
  return {
    credentialId: CRED_1,
    userId: 1,
    username: 'alice',
    orgId: null,
    projectId: PROJECT,
    mode: 'act',
    ...overrides,
  }
}

/** Seed a real users row + api_credentials row and mint a live `aqk_` token
 *  through the shared credential module — no more decode-stub tokens. */
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
    const token = await credToken(tdb, contributorCred())

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
    expect(prov.human_authority).toEqual({ user_id: '1', credential_id: CRED_1 })
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
    const token = await credToken(tdb, contributorCred())

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

  it("DO fan-out marks agent commits `via: 'external'` with `by` = the credential owner", async () => {
    // The commit routes through /events with a token-bridge token, so the
    // event.applied broadcast carries by = the OWNER's username. If that owner
    // has the project open in the editor, isOwnWriteEcho (ws-reconciler.ts)
    // would suppress the refetch as an own-write echo — but no outbox write
    // happened, so the editor would never show the agent's translation until a
    // manual reload. The `via: 'external'` marker is what defeats that
    // suppression; this test pins it through the FULL agent path
    // (token-bridge → /events perimeter → ProjectSync fan-out).
    const bodies: Array<Record<string, unknown>> = []
    const stubFetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    })
    const env = {
      ...makeEnv(tdb.db),
      ProjectSync: {
        idFromName: vi.fn().mockReturnValue({ id: 'do-id' }),
        get: vi.fn().mockReturnValue({ fetch: stubFetch }),
      } as unknown as DurableObjectNamespace,
    }
    const token = await credToken(tdb, contributorCred())

    const { body: prep } = await prepare(env, token, [
      { kind: 'SetTranslation', fileId: FILE, cellId: 'cell-1', value: 'hola', valueHtml: '<p>hola</p>' },
    ])
    const res = (await handleExternalChangesetsRequest(commitReq(token, prep.changeset.id), env))!
    expect(res.status).toBe(200)

    const applied = bodies
      .flatMap((b) => (b.t === 'broadcast.batch' ? (b.messages as Array<Record<string, unknown>>) : [b]))
      .filter((m) => m.t === 'event.applied')
    expect(applied.length).toBeGreaterThan(0)
    for (const m of applied) {
      expect(m.by).toBe('alice')
      expect(m.via).toBe('external')
    }
  })
})

// ── ask-mode confirmation ────────────────────────────────────────────────────

describe('changesets — ask-mode confirmation', () => {
  it('commit without a confirmation → confirmation_required', async () => {
    const env = makeEnv(tdb.db)
    const token = await credToken(tdb, contributorCred({ mode: 'ask' }))
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
    const token = await credToken(tdb, contributorCred({ mode: 'ask' }))
    const { body: prep } = await prepare(env, token, [
      { kind: 'SetTranslation', fileId: FILE, cellId: 'cell-1', value: 'x' },
    ])

    await insertConfirmation(tdb.db, {
      id: 'conf-consumed', changesetId: prep.changeset.id, credentialId: CRED_1,
      digest: prep.digest, consumed: true,
    })
    await insertConfirmation(tdb.db, {
      id: 'conf-expired', changesetId: prep.changeset.id, credentialId: CRED_1,
      digest: prep.digest, expired: true,
    })

    const res = (await handleExternalChangesetsRequest(commitReq(token, prep.changeset.id), env))!
    expect(res.status).toBe(428)
    expect((await res.json() as any).error.code).toBe('confirmation_required')
  })

  // races-F1 (burn-without-apply): the one-time confirmation must be consumed
  // ONLY once the commit is owned (the staged→committing flip won). A commit that
  // fails the approval step must burn nothing and leave the changeset RECOVERABLE
  // (reverted to 'staged', never stranded in 'committing'), so a later commit
  // with a valid approval still succeeds — and, critically, still REQUIRES that
  // approval (it is not silently applied).
  it('a commit blocked at the confirmation step burns nothing and stays recoverable', async () => {
    const env = makeEnv(tdb.db)
    const token = await credToken(tdb, contributorCred({ mode: 'ask' }))
    const { body: prep } = await prepare(env, token, [
      { kind: 'SetTranslation', fileId: FILE, cellId: 'cell-1', value: 'approved' },
    ])

    // No approval yet → confirmation_required, and NOTHING applied.
    const res1 = (await handleExternalChangesetsRequest(commitReq(token, prep.changeset.id), env))!
    expect(res1.status).toBe(428)
    expect((await res1.json() as any).error.code).toBe('confirmation_required')
    const commits1 = (await tdb.rows('events')).filter((e: any) => e.kind === 'target.cell.commit')
    expect(commits1).toHaveLength(0)

    // The changeset was RELEASED back to 'staged' (not stranded in 'committing').
    const csRows = await tdb.rows<{ id: string; status: string }>('changesets')
    expect(csRows.find((r) => r.id === prep.changeset.id)?.status).toBe('staged')

    // A valid approval now commits it (approval was preserved / never demanded twice).
    await insertConfirmation(tdb.db, {
      id: 'conf-ok', changesetId: prep.changeset.id, credentialId: CRED_1, digest: prep.digest,
    })
    const res2 = (await handleExternalChangesetsRequest(commitReq(token, prep.changeset.id), env))!
    expect(res2.status).toBe(200)
    expect((await res2.json() as any).receipt.appliedCount).toBe(1)

    // Confirmation consumed exactly once; provenance carries it.
    const conf = await tdb.rows<{ consumed_at: unknown }>('changeset_confirmations')
    expect(conf.filter((c) => c.consumed_at != null)).toHaveLength(1)
    const commit = (await tdb.rows<{ kind: string; provenance: unknown }>('events')).find((e) => e.kind === 'target.cell.commit')!
    const prov = typeof commit.provenance === 'string' ? JSON.parse(commit.provenance) : commit.provenance
    expect(prov.confirmation_id).toBe('conf-ok')
  })

  it('valid confirmation commits once; a second commit returns the receipt without double-applying', async () => {
    const env = makeEnv(tdb.db)
    const token = await credToken(tdb, contributorCred({ mode: 'ask' }))
    const { body: prep } = await prepare(env, token, [
      { kind: 'SetTranslation', fileId: FILE, cellId: 'cell-1', value: 'approved' },
    ])
    await insertConfirmation(tdb.db, {
      id: 'conf-ok', changesetId: prep.changeset.id, credentialId: CRED_1, digest: prep.digest,
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
    const token = await credToken(tdb, contributorCred())
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
    const token = await credToken(tdb, contributorCred({ projectId: 'other-project' }))
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

describe('changesets — role enforcement (prepare gate + /events perimeter)', () => {
  it("a viewer-role user's credential cannot stage a translation changeset", async () => {
    const env = makeEnv(tdb.db)
    // Credential owned by user 2, who is only a VIEWER (role 100) on the project.
    const token = await credToken(
      tdb,
      contributorCred({ credentialId: CRED_VIEWER, userId: 2, username: 'vic' }),
    )

    // Prepare is now gated at the SetTranslation floor (target.cell.commit →
    // CONTRIBUTOR 400): a viewer is denied at staging, so no plan is created and
    // the server-computed effect summary is never leaked.
    const { res, body } = await prepare(env, token, [
      { kind: 'SetTranslation', fileId: FILE, cellId: 'cell-1', value: 'nope' },
    ])
    expect(res.status).toBe(403)
    expect(body.error.code).toBe('permission_denied')
    expect(body.changeset).toBeUndefined()

    // Nothing staged, nothing applied.
    expect(await tdb.rows('changesets')).toHaveLength(0)
    const commits = (await tdb.rows('events')).filter((e: any) => e.kind === 'target.cell.commit')
    expect(commits).toHaveLength(0)
    const target = (await tdb.rows<{ side: string }>('cells')).find((c) => c.side === 'target')
    expect(target).toBeUndefined()
  })
})

// ── live role re-resolution on GET / commit / discard ───────────────────────
// §2 "live role/membership resolution on every call": a user removed from the
// project after staging must not be able to view, commit, or discard the plan.

describe('changesets — member removed after prepare is denied on GET/commit/discard', () => {
  it('GET, commit, and discard all 403 permission_denied once membership is gone', async () => {
    const env = makeEnv(tdb.db)
    const token = await credToken(tdb, contributorCred()) // alice, contributor (400)

    const { body: prep } = await prepare(env, token, [
      { kind: 'SetTranslation', fileId: FILE, cellId: 'cell-1', value: 'hi' },
    ])
    expect(prep.changeset.status).toBe('staged')
    const id = prep.changeset.id

    // Alice loses all project access — her live role now resolves to null
    // (project creator is user 99, no org/group path).
    await tdb.db.prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?').bind(PROJECT, 1).run()

    const getRes = (await handleExternalChangesetsRequest(
      new Request(`https://w/api/v1/external/projects/${PROJECT}/changesets/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
      env,
    ))!
    expect(getRes.status).toBe(403)
    expect((await getRes.json() as any).error.code).toBe('permission_denied')

    const commitRes = (await handleExternalChangesetsRequest(commitReq(token, id), env))!
    expect(commitRes.status).toBe(403)
    expect((await commitRes.json() as any).error.code).toBe('permission_denied')

    const discardRes = (await handleExternalChangesetsRequest(
      new Request(`https://w/api/v1/external/projects/${PROJECT}/changesets/${id}/discard`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      }),
      env,
    ))!
    expect(discardRes.status).toBe(403)
    expect((await discardRes.json() as any).error.code).toBe('permission_denied')

    // The plan was never committed or discarded — it remains staged.
    const cs = await tdb.rows<{ status: string }>('changesets')
    expect(cs[0].status).toBe('staged')
  })
})

// ── commit replay: crash-retry idempotency (W1-B §4/§9) ─────────────────────
// The bug this guards: pre-W1-B, commit minted event ids at commit time and
// flipped to 'committed' only at the end, so a worker eviction mid-commit left
// the changeset re-committable and a retry minted FRESH ids → duplicate events.
// Now ids are minted at prepare and stored; a retry (status='committing')
// re-posts identical ids that the /events idempotency layer dedupes.

describe('changesets — commit replay (crash-retry idempotency)', () => {
  it('a SetTranslation retry from `committing` re-uses stored ids — no duplicate events', async () => {
    const env = makeEnv(tdb.db)
    const token = await credToken(tdb, contributorCred())
    const { body: prep } = await prepare(env, token, [
      { kind: 'SetTranslation', fileId: FILE, cellId: 'cell-1', value: 'hello' },
      { kind: 'SetTranslation', fileId: FILE, cellId: 'cell-2', value: 'world' },
    ])

    // First commit applies both target.cell.commit events.
    const res1 = (await handleExternalChangesetsRequest(commitReq(token, prep.changeset.id), env))!
    expect(res1.status).toBe(200)
    const r1 = (await res1.json()) as any
    expect(r1.receipt.appliedCount).toBe(2)
    const firstEventIds = [...r1.receipt.eventIds].sort()
    expect(
      (await tdb.rows('events')).filter((e: any) => e.kind === 'target.cell.commit'),
    ).toHaveLength(2)

    // Simulate a worker eviction AFTER the events applied but BEFORE the status
    // flip to 'committed' was durably written — the changeset is left in the
    // transient 'committing' state.
    await tdb.db
      .prepare(`UPDATE changesets SET status = 'committing' WHERE id = ?`)
      .bind(prep.changeset.id)
      .run()

    // Retry: re-enters via the 'committing' gate (drift/expiry/confirmation are
    // skipped), re-posts the SAME stored event ids, and converges to committed.
    const res2 = (await handleExternalChangesetsRequest(commitReq(token, prep.changeset.id), env))!
    expect(res2.status).toBe(200)
    const r2 = (await res2.json()) as any
    // Identical event ids prove the prepare-time ids were reused, not re-minted.
    expect([...r2.receipt.eventIds].sort()).toEqual(firstEventIds)

    // No duplicate events: still exactly two target.cell.commit rows.
    const afterRetry = (await tdb.rows<{ id: string; kind: string }>('events')).filter(
      (e) => e.kind === 'target.cell.commit',
    )
    expect(afterRetry).toHaveLength(2)
    expect(afterRetry.map((e) => e.id).sort()).toEqual(firstEventIds)

    // Single changeset row, back to committed.
    const cs = await tdb.rows<{ status: string }>('changesets')
    expect(cs).toHaveLength(1)
    expect(cs[0].status).toBe('committed')
  })
})

// ── target-language lanes (AQU-538) ─────────────────────────────────────────
// A lane is a language tag registered in settings.targetLanes; SetTranslation's
// optional laneId writes that lane's independent target row/chain. These pin:
//   1. unregistered lane → rejected at prepare (teaches UpdateProjectSettings)
//   2. two lanes on one cell in one changeset → two lane rows, lane-stamped events
//   3. preconditions are lane-scoped — a sibling-lane write never stales a plan

describe('changesets — target-language lanes', () => {
  async function registerLanes(lanes: string[]): Promise<void> {
    await tdb.pg.query(
      `INSERT INTO project_settings (project_id, settings, version) VALUES ($1, $2::jsonb, 1)`,
      [PROJECT, JSON.stringify({ targetLanes: lanes })],
    )
  }

  it('rejects a SetTranslation naming an unregistered lane at prepare', async () => {
    const env = makeEnv(tdb.db)
    const token = await credToken(tdb, contributorCred())
    await registerLanes(['es'])

    const { res, body } = await prepare(env, token, [
      { kind: 'SetTranslation', fileId: FILE, cellId: 'cell-1', value: 'olá', laneId: 'pt' },
    ])
    expect(res.status).toBe(400)
    expect(body.error.code).toBe('validation_failed')
    expect(body.error.message).toContain('unregistered lane "pt"')
    expect(body.error.message).toContain('UpdateProjectSettings')
  })

  it('two lanes on one cell in one changeset land two independent lane rows', async () => {
    const env = makeEnv(tdb.db)
    const token = await credToken(tdb, contributorCred())
    await registerLanes(['es', 'pt'])

    const { body: prep } = await prepare(env, token, [
      { kind: 'SetTranslation', fileId: FILE, cellId: 'cell-1', value: 'hola', laneId: 'es' },
      { kind: 'SetTranslation', fileId: FILE, cellId: 'cell-1', value: 'olá', laneId: 'pt' },
    ])
    // Same cell, different lanes = two independent slots, not a duplicate.
    expect(prep.summary.warnings).toEqual([])
    expect(prep.summary.translationsAdded).toBe(2)

    const res = (await handleExternalChangesetsRequest(commitReq(token, prep.changeset.id), env))!
    expect(res.status).toBe(200)
    expect(((await res.json()) as any).receipt.appliedCount).toBe(2)

    // Compiled events carry the lane in their payload.
    const commits = (await tdb.rows<{ kind: string; payload: string }>('events'))
      .filter((e) => e.kind === 'target.cell.commit')
      .map((e) => (typeof e.payload === 'string' ? JSON.parse(e.payload) : e.payload))
    expect(commits.map((p) => p.targetLang).sort()).toEqual(['es', 'pt'])

    // Projection: one target row per lane, source pin intact; no default-lane row.
    const targets = (await tdb.rows<{ side: string; target_lang: string; value: string; source_event_id: string | null }>('cells'))
      .filter((c) => c.side === 'target')
    expect(targets.map((t) => [t.target_lang, t.value]).sort()).toEqual([
      ['es', 'hola'],
      ['pt', 'olá'],
    ])
    for (const t of targets) expect(t.source_event_id).toBe('src-evt-1')
  })

  it('a sibling-lane write between prepare and commit does not stale the plan', async () => {
    const env = makeEnv(tdb.db)
    const token = await credToken(tdb, contributorCred())
    await registerLanes(['es', 'pt'])

    const { body: prep } = await prepare(env, token, [
      { kind: 'SetTranslation', fileId: FILE, cellId: 'cell-1', value: 'hola', laneId: 'es' },
    ])

    // Interleave a direct commit on the SAME cell in the pt lane.
    const seedTok = await makeTestToken(SECRET, { projectId: PROJECT, fileId: FILE, userId: 1, username: 'alice', role: 400 })
    const interleave: RawEvent<'target.cell.commit'> = {
      id: 'interleave-pt-1', schemaVersion: 1, kind: 'target.cell.commit',
      projectId: PROJECT, fileId: FILE, cellId: 'cell-1', parentId: null,
      author: 'alice', payload: { value: 'olá direto', targetLang: 'pt' }, clientTs: 5,
    }
    await handleEventsWriteRequest(
      new Request('https://w/events', {
        method: 'POST', headers: { Authorization: `Bearer ${seedTok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ events: [interleave] }),
      }),
      makeEnv(tdb.db),
    )

    // The es-lane plan is untouched by the pt write: commit succeeds.
    const res = (await handleExternalChangesetsRequest(commitReq(token, prep.changeset.id), env))!
    expect(res.status).toBe(200)

    const targets = (await tdb.rows<{ side: string; target_lang: string; value: string }>('cells'))
      .filter((c) => c.side === 'target')
    expect(targets.map((t) => [t.target_lang, t.value]).sort()).toEqual([
      ['es', 'hola'],
      ['pt', 'olá direto'],
    ])
  })

  it('a same-lane write between prepare and commit still yields plan_stale', async () => {
    const env = makeEnv(tdb.db)
    const token = await credToken(tdb, contributorCred())
    await registerLanes(['es'])

    const { body: prep } = await prepare(env, token, [
      { kind: 'SetTranslation', fileId: FILE, cellId: 'cell-1', value: 'hola', laneId: 'es' },
    ])

    const seedTok = await makeTestToken(SECRET, { projectId: PROJECT, fileId: FILE, userId: 1, username: 'alice', role: 400 })
    const interleave: RawEvent<'target.cell.commit'> = {
      id: 'interleave-es-1', schemaVersion: 1, kind: 'target.cell.commit',
      projectId: PROJECT, fileId: FILE, cellId: 'cell-1', parentId: null,
      author: 'alice', payload: { value: 'hola directa', targetLang: 'es' }, clientTs: 5,
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
    expect(((await res.json()) as any).error.code).toBe('plan_stale')
  })
})

// ── approvalUrl is always absolute ──────────────────────────────────────────
// Observed in the field: an env without BASE_URL handed agents a relative
// "/approve/:id" they could not open. The fallback keeps the deep link
// absolute (production SPA host) even when BASE_URL is unset or empty.

describe('changesets — approvalUrl', () => {
  it('falls back to the production app host when BASE_URL is unset', async () => {
    const env = { AQUILLA_PG: tdb.db, SYNC_SECRET_KEY: SECRET } as ReturnType<typeof makeEnv>
    const token = await credToken(tdb, contributorCred())
    const { body: prep } = await prepare(env, token, [
      { kind: 'SetTranslation', fileId: FILE, cellId: 'cell-1', value: 'hello' },
    ])
    expect(prep.approvalUrl).toBe(`https://aquilla.app/approve/${prep.changeset.id}`)
  })
})

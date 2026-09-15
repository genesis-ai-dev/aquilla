// Agent API changeset LIFECYCLE (AQU-1177): listing, the approval long-poll,
// and an ask-mode expiry that outlives human deliberation.
//
// The engine itself (prepare → commit, drift, provenance) is covered by
// external-changesets.test.ts. This suite covers only what an agent needs in
// order to hand a plan to a human and pick it back up afterwards:
//
//   §1  GET /changesets — status filter, cursor pagination, credential scoping
//   §2  GET /changesets/:id/wait — settles on approval, honors its timeout
//   §3  ask-mode 24h TTL — a changeset approved 3 hours after prepare commits

import { describe, it, expect, beforeEach, vi } from 'vitest'

// commit.ts → events/route.ts → broadcast.ts → partyserver (cloudflare:*).
vi.mock('partyserver', () => ({
  getServerByName: vi.fn().mockResolvedValue({
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  }),
}))

import { handleExternalChangesetsRequest } from '../external/changesets-route'
import { CHANGESET_ASK_TTL_MS, CHANGESET_TTL_MS } from '../external/stage'
import { WAIT_MAX_TIMEOUT_MS } from '../external/changeset-wait'
import { mintApiToken } from '../../../db/shared/api-credentials'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'

const SECRET = 'test-secret'
const PROJECT = 'proj-a'
const OTHER_PROJECT = 'proj-b'
const FILE = 'file-x'
const CRED_ALICE = '00000000-0000-0000-0000-000000000001'
const CRED_ALICE_2 = '00000000-0000-0000-0000-000000000002'
const CRED_OTHER_PROJECT = '00000000-0000-0000-0000-000000000003'

function makeEnv(db: AquillaDb) {
  return { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET, BASE_URL: 'https://aquilla.app' }
}

interface CredSpec {
  credentialId: string
  userId?: number
  username?: string
  projectId?: string | null
  mode?: 'ask' | 'act'
}

/** Seed a users row + api_credentials row and mint a live `aqk_` token. */
async function credToken(tdb: TestDb, spec: CredSpec): Promise<string> {
  const userId = spec.userId ?? 1
  const username = spec.username ?? 'alice'
  await tdb.pg.query(
    `INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, 'h')
     ON CONFLICT (id) DO NOTHING`,
    [userId, username, `${username}@x.com`],
  )
  const { token, tokenHash, tokenPrefix } = await mintApiToken()
  await tdb.pg.query(
    `INSERT INTO api_credentials (id, user_id, name, token_prefix, token_hash, mode, org_id, project_id)
     VALUES ($1, $2, 'test', $3, $4, $5, NULL, $6)`,
    [
      spec.credentialId,
      String(userId),
      tokenPrefix,
      tokenHash,
      spec.mode ?? 'act',
      spec.projectId === undefined ? PROJECT : spec.projectId,
    ],
  )
  return token
}

async function seedProject(): Promise<TestDb> {
  return makeTestDb({
    projects: [
      { id: PROJECT, name: 'P', created_by: 99, org_id: null },
      { id: OTHER_PROJECT, name: 'Q', created_by: 99, org_id: null },
    ],
    project_members: [
      { project_id: PROJECT, user_id: 1, role_level: 400 }, // alice: contributor
      { project_id: OTHER_PROJECT, user_id: 1, role_level: 400 },
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

/** Stage one SetTranslation plan; returns the prepare response body. */
async function prepare(
  env: ReturnType<typeof makeEnv>,
  token: string,
  value: string,
  cellId = 'cell-1',
): Promise<{ changeset: { id: string; expiresAt: string; status: string }; digest: string }> {
  const req = new Request(`https://w/api/v1/external/projects/${PROJECT}/changesets`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ commands: [{ kind: 'SetTranslation', fileId: FILE, cellId, value }] }),
  })
  const res = (await handleExternalChangesetsRequest(req, env))!
  expect(res.status).toBe(200)
  return (await res.json()) as never
}

function get(token: string, path: string, projectId = PROJECT): Request {
  return new Request(`https://w/api/v1/external/projects/${projectId}/changesets${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
}

/** Insert an ask-mode confirmation directly — stands in for the approval page. */
async function approve(
  db: AquillaDb,
  args: { changesetId: string; credentialId: string; digest: string },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO changeset_confirmations
         (id, changeset_id, user_id, credential_id, digest, expires_at)
       VALUES (?, ?, '1', ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      args.changesetId,
      args.credentialId,
      args.digest,
      new Date(Date.now() + 15 * 60_000).toISOString(),
    )
    .run()
}

let tdb: TestDb
beforeEach(async () => {
  tdb = await seedProject()
})

// ── §1 list ────────────────────────────────────────────────────────────────

describe('GET /changesets — list (AQU-1177 §1)', () => {
  it('returns this credential\'s changesets newest-first, with the approval url', async () => {
    const env = makeEnv(tdb.db)
    const token = await credToken(tdb, { credentialId: CRED_ALICE })

    const first = await prepare(env, token, 'one')
    const second = await prepare(env, token, 'two', 'cell-2')

    const res = (await handleExternalChangesetsRequest(get(token, ''), env))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.changesets).toHaveLength(2)
    expect(body.changesets.map((c: any) => c.id)).toEqual([second.changeset.id, first.changeset.id])
    expect(body.changesets[0].approvalUrl).toBe(`https://aquilla.app/approve/${second.changeset.id}`)
    expect(body.nextCursor).toBeNull()
  })

  it('filters by status exactly, and rejects a status that is not in the schema', async () => {
    const env = makeEnv(tdb.db)
    const token = await credToken(tdb, { credentialId: CRED_ALICE })
    const keep = await prepare(env, token, 'kept')
    const drop = await prepare(env, token, 'dropped', 'cell-2')

    await handleExternalChangesetsRequest(
      new Request(`https://w/api/v1/external/projects/${PROJECT}/changesets/${drop.changeset.id}/discard`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      }),
      env,
    )

    const staged = (await handleExternalChangesetsRequest(get(token, '?status=staged'), env))!
    const stagedBody = (await staged.json()) as any
    expect(stagedBody.changesets.map((c: any) => c.id)).toEqual([keep.changeset.id])

    const discarded = (await handleExternalChangesetsRequest(get(token, '?status=discarded'), env))!
    const discardedBody = (await discarded.json()) as any
    expect(discardedBody.changesets.map((c: any) => c.id)).toEqual([drop.changeset.id])

    const bogus = (await handleExternalChangesetsRequest(get(token, '?status=pending'), env))!
    expect(bogus.status).toBe(400)
    const bogusBody = (await bogus.json()) as any
    expect(bogusBody.error.code).toBe('validation_failed')
    // The error names the legal values so an agent can self-correct.
    expect(bogusBody.error.details.statuses).toContain('staged')
  })

  it('pages with an opaque cursor and stops with a null nextCursor', async () => {
    const env = makeEnv(tdb.db)
    const token = await credToken(tdb, { credentialId: CRED_ALICE })
    const a = await prepare(env, token, 'a')
    const b = await prepare(env, token, 'b', 'cell-2')
    const c = await prepare(env, token, 'c')
    const newestFirst = [c.changeset.id, b.changeset.id, a.changeset.id]

    const page1 = (await handleExternalChangesetsRequest(get(token, '?limit=2'), env))!
    const body1 = (await page1.json()) as any
    expect(body1.changesets.map((x: any) => x.id)).toEqual(newestFirst.slice(0, 2))
    expect(body1.nextCursor).toBeTruthy()

    const page2 = (await handleExternalChangesetsRequest(
      get(token, `?limit=2&cursor=${encodeURIComponent(body1.nextCursor)}`),
      env,
    ))!
    const body2 = (await page2.json()) as any
    expect(body2.changesets.map((x: any) => x.id)).toEqual(newestFirst.slice(2))
    // Exactly the tail: no page-3 cursor dangling behind an empty page.
    expect(body2.nextCursor).toBeNull()
  })

  it('never leaks another credential\'s changesets, even in the same project', async () => {
    const env = makeEnv(tdb.db)
    const mine = await credToken(tdb, { credentialId: CRED_ALICE })
    // Same human, same project, second PAT — the isolation is per CREDENTIAL,
    // matching the per-item rule on GET /changesets/:id.
    const theirs = await credToken(tdb, { credentialId: CRED_ALICE_2 })

    const ours = await prepare(env, mine, 'ours')
    await prepare(env, theirs, 'theirs', 'cell-2')

    const res = (await handleExternalChangesetsRequest(get(mine, ''), env))!
    const body = (await res.json()) as any
    expect(body.changesets.map((c: any) => c.id)).toEqual([ours.changeset.id])
  })

  it('denies a PAT scoped to a different project with 403 scope_denied', async () => {
    const env = makeEnv(tdb.db)
    const wrongProject = await credToken(tdb, {
      credentialId: CRED_OTHER_PROJECT,
      projectId: OTHER_PROJECT,
    })

    const res = (await handleExternalChangesetsRequest(get(wrongProject, ''), env))!
    expect(res.status).toBe(403)
    expect(((await res.json()) as any).error.code).toBe('scope_denied')
  })

  it('rejects a missing credential', async () => {
    const env = makeEnv(tdb.db)
    const res = (await handleExternalChangesetsRequest(
      new Request(`https://w/api/v1/external/projects/${PROJECT}/changesets`),
      env,
    ))!
    expect(res.status).toBe(403)
    expect(((await res.json()) as any).error.code).toBe('permission_denied')
  })
})

// ── §2 wait ────────────────────────────────────────────────────────────────

describe('GET /changesets/:id/wait — approval long-poll (AQU-1177 §2)', () => {
  it('resolves within a second of a human approving', async () => {
    const env = makeEnv(tdb.db)
    const token = await credToken(tdb, { credentialId: CRED_ALICE, mode: 'ask' })
    const prep = await prepare(env, token, 'awaiting a human')

    // Approval lands ~50ms into a 5s wait; the call must return promptly rather
    // than sitting out the full budget.
    const startedAt = Date.now()
    const waiting = handleExternalChangesetsRequest(
      get(token, `/${prep.changeset.id}/wait?timeoutMs=5000`),
      env,
    )
    setTimeout(() => {
      void approve(tdb.db, {
        changesetId: prep.changeset.id,
        credentialId: CRED_ALICE,
        digest: prep.digest,
      })
    }, 50)

    const res = (await waiting)!
    const elapsed = Date.now() - startedAt
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.approved).toBe(true)
    expect(body.timedOut).toBe(false)
    // Approval does NOT move the status — that is exactly why polling the
    // status alone would have slept through this.
    expect(body.changeset.status).toBe('staged')
    expect(elapsed).toBeLessThan(4000)
  })

  it('returns timedOut with the current row when nothing happens, without overrunning the budget', async () => {
    const env = makeEnv(tdb.db)
    const token = await credToken(tdb, { credentialId: CRED_ALICE, mode: 'ask' })
    const prep = await prepare(env, token, 'nobody is coming')

    const startedAt = Date.now()
    const res = (await handleExternalChangesetsRequest(
      get(token, `/${prep.changeset.id}/wait?timeoutMs=300`),
      env,
    ))!
    const elapsed = Date.now() - startedAt

    const body = (await res.json()) as any
    expect(body.timedOut).toBe(true)
    expect(body.approved).toBe(false)
    expect(body.changeset.id).toBe(prep.changeset.id)
    expect(body.maxTimeoutMs).toBe(WAIT_MAX_TIMEOUT_MS)
    // Honors the timeout in both directions: it waited, and it stopped waiting.
    expect(elapsed).toBeGreaterThanOrEqual(250)
    expect(elapsed).toBeLessThan(3000)
  })

  it('returns immediately when the plan already left staged (e.g. the human rejected it)', async () => {
    const env = makeEnv(tdb.db)
    const token = await credToken(tdb, { credentialId: CRED_ALICE, mode: 'ask' })
    const prep = await prepare(env, token, 'rejected')
    await handleExternalChangesetsRequest(
      new Request(`https://w/api/v1/external/projects/${PROJECT}/changesets/${prep.changeset.id}/discard`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      }),
      env,
    )

    const startedAt = Date.now()
    const res = (await handleExternalChangesetsRequest(
      // A long budget must not delay an ALREADY-settled answer.
      get(token, `/${prep.changeset.id}/wait?timeoutMs=30000`),
      env,
    ))!
    const body = (await res.json()) as any
    expect(body.changeset.status).toBe('discarded')
    expect(body.timedOut).toBe(false)
    expect(Date.now() - startedAt).toBeLessThan(2000)
  })

  it('supports timeoutMs=0 as a non-blocking check', async () => {
    const env = makeEnv(tdb.db)
    const token = await credToken(tdb, { credentialId: CRED_ALICE, mode: 'ask' })
    const prep = await prepare(env, token, 'peek')

    const res = (await handleExternalChangesetsRequest(
      get(token, `/${prep.changeset.id}/wait?timeoutMs=0`),
      env,
    ))!
    const body = (await res.json()) as any
    expect(body.timedOut).toBe(true)
    expect(body.waitedMs).toBeLessThan(500)
  })

  it('denies waiting on a changeset another credential staged', async () => {
    const env = makeEnv(tdb.db)
    const mine = await credToken(tdb, { credentialId: CRED_ALICE })
    const theirs = await credToken(tdb, { credentialId: CRED_ALICE_2 })
    const prep = await prepare(env, theirs, 'not yours')

    const res = (await handleExternalChangesetsRequest(
      get(mine, `/${prep.changeset.id}/wait?timeoutMs=0`),
      env,
    ))!
    expect(res.status).toBe(403)
    expect(((await res.json()) as any).error.code).toBe('permission_denied')
  })
})

// ── §3 ask-mode expiry ─────────────────────────────────────────────────────

describe('ask-mode expiry outlives human deliberation (AQU-1177 §3)', () => {
  it('gives an ask-mode plan 24h and an act-mode plan 1h', async () => {
    const env = makeEnv(tdb.db)
    const askToken = await credToken(tdb, { credentialId: CRED_ALICE, mode: 'ask' })
    const actToken = await credToken(tdb, { credentialId: CRED_ALICE_2, mode: 'act' })

    const ask = await prepare(env, askToken, 'ask plan')
    const act = await prepare(env, actToken, 'act plan', 'cell-2')

    const askWindow = new Date(ask.changeset.expiresAt).getTime() - Date.now()
    const actWindow = new Date(act.changeset.expiresAt).getTime() - Date.now()

    // Generous slack: the assertion under test is the ORDER OF MAGNITUDE of the
    // window, not clock precision.
    expect(askWindow).toBeGreaterThan(CHANGESET_ASK_TTL_MS - 60_000)
    expect(askWindow).toBeLessThanOrEqual(CHANGESET_ASK_TTL_MS)
    expect(actWindow).toBeGreaterThan(CHANGESET_TTL_MS - 60_000)
    expect(actWindow).toBeLessThanOrEqual(CHANGESET_TTL_MS)

    // The regression this guards: three hours of human deliberation used to
    // land past a one-hour deadline.
    expect(askWindow).toBeGreaterThan(3 * 60 * 60 * 1000)
  })

  it('commits a plan approved 3 hours after prepare', async () => {
    const env = makeEnv(tdb.db)
    const token = await credToken(tdb, { credentialId: CRED_ALICE, mode: 'ask' })
    const prep = await prepare(env, token, 'slow human')

    // Fast-forward three hours by ageing the row rather than the clock: rewind
    // both timestamps by 3h, leaving expires_at exactly where a 24h TTL would
    // have put it at T+3h. Under the old 1h TTL this row would be expired.
    await tdb.pg.query(
      `UPDATE changesets
          SET created_at = created_at - interval '3 hours',
              expires_at = expires_at - interval '3 hours'
        WHERE id = $1`,
      [prep.changeset.id],
    )
    const aged = await tdb.pg.query<{ expires_at: Date }>(
      `SELECT expires_at FROM changesets WHERE id = $1`,
      [prep.changeset.id],
    )
    expect(new Date(aged.rows[0].expires_at).getTime()).toBeGreaterThan(Date.now())

    // The human approves NOW, three hours in.
    await approve(tdb.db, {
      changesetId: prep.changeset.id,
      credentialId: CRED_ALICE,
      digest: prep.digest,
    })

    const res = (await handleExternalChangesetsRequest(
      new Request(`https://w/api/v1/external/projects/${PROJECT}/changesets/${prep.changeset.id}/commit`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      }),
      env,
    ))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.receipt.appliedCount).toBe(1)

    const rows = await tdb.rows<{ status: string }>('changesets')
    expect(rows[0].status).toBe('committed')
  })

  it('still expires a plan past its deadline', async () => {
    const env = makeEnv(tdb.db)
    const token = await credToken(tdb, { credentialId: CRED_ALICE, mode: 'ask' })
    const prep = await prepare(env, token, 'too slow')

    // 25 hours on: past even the ask-mode window. The deadline is longer, not
    // absent.
    await tdb.pg.query(
      `UPDATE changesets SET expires_at = now() - interval '1 hour' WHERE id = $1`,
      [prep.changeset.id],
    )
    await approve(tdb.db, {
      changesetId: prep.changeset.id,
      credentialId: CRED_ALICE,
      digest: prep.digest,
    })

    const res = (await handleExternalChangesetsRequest(
      new Request(`https://w/api/v1/external/projects/${PROJECT}/changesets/${prep.changeset.id}/commit`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      }),
      env,
    ))!
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error.message).toMatch(/expired/)

    const rows = await tdb.rows<{ status: string }>('changesets')
    expect(rows[0].status).toBe('expired')
  })
})

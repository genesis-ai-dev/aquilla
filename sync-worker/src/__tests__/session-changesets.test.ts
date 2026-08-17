// Tests for the session-token changeset routes (AQU-926, command registry §3):
// the in-app surface over the SAME changeset engine the external Agent API
// uses, authenticated with the browser's sync token. Asserts the §3 contract:
// forced ask-mode, the 'session' credential sentinel, creator-only access, the
// 'app' provenance channel, list semantics, and ask-mode confirmation
// consumption (confirmations minted with credential_id='session', as
// auth-worker's approve route stamps them).

import { describe, it, expect, vi, beforeEach } from 'vitest'

// commit core → events/route.ts → broadcast.ts → partyserver (cloudflare:*).
vi.mock('partyserver', () => ({
  getServerByName: vi.fn().mockResolvedValue({
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  }),
}))

import { handleSessionChangesetsRequest } from '../external/session-routes'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'
import { makeTestToken } from './helpers/auth'

const SECRET = 'test-secret'
const PROJECT = 'proj-a'
const FILE = 'file-x'

function makeEnv(db: AquillaDb) {
  return { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET, BASE_URL: 'https://aquilla.app' }
}

/** Project-scoped session sync token (fileId irrelevant for these routes). */
async function sessionToken(userId: number, username: string, role: number): Promise<string> {
  return makeTestToken(SECRET, { projectId: PROJECT, fileId: '', userId, username, role })
}

async function seedProject(): Promise<TestDb> {
  const tdb = await makeTestDb({
    users: [
      { id: 1, username: 'alice', email: 'a@x.com', password_hash: 'h' },
      { id: 2, username: 'bob', email: 'b@x.com', password_hash: 'h' },
    ],
    projects: [{ id: PROJECT, name: 'P', created_by: 99, org_id: null }],
    project_members: [
      { project_id: PROJECT, user_id: 1, role_level: 400 }, // alice: contributor
      { project_id: PROJECT, user_id: 2, role_level: 400 }, // bob: contributor
    ],
    cells: [
      {
        project_id: PROJECT, file_id: FILE, cell_id: 'cell-1', side: 'source',
        value: 'source one', event_id: 'src-evt-1', last_edit_at: 1,
      },
    ],
  })
  return tdb
}

const BASE = `https://w/api/v1/changesets/${PROJECT}`

function req(token: string, path: string, method: string, body?: unknown): Request {
  return new Request(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

async function call(env: ReturnType<typeof makeEnv>, request: Request) {
  const res = (await handleSessionChangesetsRequest(request, env))!
  return { res, body: (await res.json()) as any }
}

/** Insert an ask-mode confirmation as auth-worker's approve route would:
 *  credential_id = the changeset's own credential_id ('session' here). */
async function insertConfirmation(
  db: AquillaDb,
  args: { id: string; changesetId: string; digest: string; userId?: number },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO changeset_confirmations
         (id, changeset_id, user_id, credential_id, digest, expires_at, consumed_at)
       VALUES (?, ?, ?, 'session', ?, ?, NULL)`,
    )
    .bind(args.id, args.changesetId, String(args.userId ?? 1), args.digest,
      new Date(Date.now() + 60_000).toISOString())
    .run()
}

let tdb: TestDb
beforeEach(async () => {
  tdb = await seedProject()
})

describe('session changesets — prepare', () => {
  it('stages with credential_id=session, forced ask, and the standard response shape', async () => {
    const env = makeEnv(tdb.db)
    const token = await sessionToken(1, 'alice', 400)

    const { res, body } = await call(env, req(token, '', 'POST', {
      commands: [{ kind: 'SetTranslation', fileId: FILE, cellId: 'cell-1', value: 'hola' }],
      // A session caller asking for act must still be forced to ask.
      autonomyMode: 'act',
    }))
    expect(res.status).toBe(200)
    expect(body.changeset.autonomyMode).toBe('ask')
    expect(body.changeset.credentialId).toBe('session')
    expect(body.changeset.createdByUserId).toBe('1')
    expect(body.changeset.status).toBe('staged')
    expect(body.summary.translationsAdded).toBe(1)
    expect(body.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(body.approvalUrl).toBe(`https://aquilla.app/approve/${body.changeset.id}`)

    const rows = await tdb.rows<{ credential_id: string; autonomy_mode: string }>('changesets')
    expect(rows[0].credential_id).toBe('session')
    expect(rows[0].autonomy_mode).toBe('ask')
  })

  it('rejects a missing/invalid sync token with the external error envelope', async () => {
    const env = makeEnv(tdb.db)
    const res = (await handleSessionChangesetsRequest(
      new Request(`${BASE}`, { method: 'POST', body: '{}' }), env,
    ))!
    expect(res.status).toBe(401)
    const body = (await res.json()) as any
    expect(body.error.code).toBe('permission_denied')
  })

  it("rejects a token scoped to a different project", async () => {
    const env = makeEnv(tdb.db)
    const foreign = await makeTestToken(SECRET, { projectId: 'other', fileId: '', userId: 1, username: 'alice', role: 400 })
    const { res, body } = await call(env, req(foreign, '', 'POST', { commands: [] }))
    expect(res.status).toBe(403)
    expect(body.error.code).toBe('permission_denied')
  })

  it('enforces the same command floors as the PAT surface (EmitEvents file.delete needs 500)', async () => {
    const env = makeEnv(tdb.db)
    await tdb.pg.query(
      `INSERT INTO files (id, project_id, name, event_id) VALUES ('file-x', $1, 'F', 'f-evt-1')`, [PROJECT],
    )
    const token = await sessionToken(1, 'alice', 400) // contributor
    const { res, body } = await call(env, req(token, '', 'POST', {
      commands: [{ kind: 'EmitEvents', events: [{ kind: 'file.delete', fileId: FILE }] }],
    }))
    expect(res.status).toBe(403)
    expect(body.error.code).toBe('permission_denied')
  })
})

describe('session changesets — creator-only access', () => {
  it('a non-creator cannot read, commit, or discard the changeset', async () => {
    const env = makeEnv(tdb.db)
    const alice = await sessionToken(1, 'alice', 400)
    const bob = await sessionToken(2, 'bob', 400)

    const { body: prep } = await call(env, req(alice, '', 'POST', {
      commands: [{ kind: 'SetTranslation', fileId: FILE, cellId: 'cell-1', value: 'hola' }],
    }))
    const id = prep.changeset.id as string

    for (const attempt of [
      req(bob, `/${id}`, 'GET'),
      req(bob, `/${id}/commit`, 'POST'),
      req(bob, `/${id}/discard`, 'POST'),
    ]) {
      const { res, body } = await call(env, attempt)
      expect(res.status).toBe(403)
      expect(body.error.code).toBe('permission_denied')
    }

    // The creator still reads it fine.
    const { res: mine } = await call(env, req(alice, `/${id}`, 'GET'))
    expect(mine.status).toBe(200)
  })
})

describe('session changesets — commit', () => {
  it('requires an unconsumed confirmation, then lands events with app-channel provenance', async () => {
    const env = makeEnv(tdb.db)
    const token = await sessionToken(1, 'alice', 400)

    const { body: prep } = await call(env, req(token, '', 'POST', {
      commands: [{ kind: 'SetTranslation', fileId: FILE, cellId: 'cell-1', value: 'hola' }],
    }))
    const id = prep.changeset.id as string

    // Ask-mode without an approval → confirmation_required, nothing applied.
    const { res: denied, body: deniedBody } = await call(env, req(token, `/${id}/commit`, 'POST'))
    expect(denied.status).toBe(428)
    expect(deniedBody.error.code).toBe('confirmation_required')
    expect(await tdb.rows('events')).toHaveLength(0)

    await insertConfirmation(tdb.db, { id: 'conf-1', changesetId: id, digest: prep.digest })
    const { res, body } = await call(env, req(token, `/${id}/commit`, 'POST'))
    expect(res.status).toBe(200)
    // Session commit returns the full record (the card renders the status
    // transition), unlike the PAT surface's bare { receipt }.
    expect(body.changeset.status).toBe('committed')
    expect(body.changeset.receipt.appliedCount).toBe(1)

    // §3 provenance: channel 'app', ask mode, session human authority.
    const events = await tdb.rows<{ kind: string; provenance: unknown; author: string }>('events')
    const commit = events.find((e) => e.kind === 'target.cell.commit')!
    expect(commit.author).toBe('alice')
    const prov = typeof commit.provenance === 'string' ? JSON.parse(commit.provenance) : commit.provenance as any
    expect(prov.channel).toBe('app')
    expect(prov.autonomy_mode).toBe('ask')
    expect(prov.human_authority).toEqual({ user_id: '1', credential_id: 'session' })
    expect(prov.confirmation_id).toBe('conf-1')

    // Idempotent re-commit returns the stored receipt.
    const { res: again, body: againBody } = await call(env, req(token, `/${id}/commit`, 'POST'))
    expect(again.status).toBe(200)
    expect(againBody.changeset.status).toBe('committed')
    expect(againBody.changeset.receipt.eventIds).toEqual(body.changeset.receipt.eventIds)
  })
})

describe('session changesets — list + discard', () => {
  it("lists only the caller's changesets, newest-first, with status filter and cap validation", async () => {
    const env = makeEnv(tdb.db)
    const alice = await sessionToken(1, 'alice', 400)
    const bob = await sessionToken(2, 'bob', 400)

    const idA = '00000000-0000-7000-8000-00000000000a'
    const idB = '00000000-0000-7000-8000-00000000000b'
    const idBob = '00000000-0000-7000-8000-0000000000bb'
    await call(env, req(alice, '', 'POST', {
      id: idA,
      commands: [{ kind: 'SetTranslation', fileId: FILE, cellId: 'cell-1', value: 'one' }],
    }))
    await call(env, req(alice, '', 'POST', {
      id: idB,
      commands: [{ kind: 'SetTranslation', fileId: FILE, cellId: 'cell-1', value: 'two' }],
    }))
    await call(env, req(bob, '', 'POST', {
      id: idBob,
      commands: [{ kind: 'SetTranslation', fileId: FILE, cellId: 'cell-1', value: 'three' }],
    }))

    const { res, body } = await call(env, req(alice, '', 'GET'))
    expect(res.status).toBe(200)
    const ids = body.changesets.map((c: { id: string }) => c.id)
    expect(ids).toHaveLength(2)
    expect(ids).not.toContain(idBob)
    // Newest-first: same created_at second is tie-broken by id DESC.
    expect(ids).toEqual([idB, idA])

    // Discard one, then filter by status.
    await call(env, req(alice, `/${idA}/discard`, 'POST'))
    const { body: staged } = await call(env, req(alice, '?status=staged', 'GET'))
    expect(staged.changesets.map((c: { id: string }) => c.id)).toEqual([idB])
    const { body: discarded } = await call(env, req(alice, '?status=discarded', 'GET'))
    expect(discarded.changesets.map((c: { id: string }) => c.id)).toEqual([idA])

    const { res: badStatus, body: badStatusBody } = await call(env, req(alice, '?status=bogus', 'GET'))
    expect(badStatus.status).toBe(400)
    expect(badStatusBody.error.code).toBe('validation_failed')

    const { res: badLimit } = await call(env, req(alice, '?limit=0', 'GET'))
    expect(badLimit.status).toBe(400)

    const { body: limited } = await call(env, req(alice, '?limit=1', 'GET'))
    expect(limited.changesets).toHaveLength(1)
  })

  it('discard flips a staged changeset to discarded and refuses a committed one', async () => {
    const env = makeEnv(tdb.db)
    const token = await sessionToken(1, 'alice', 400)
    const { body: prep } = await call(env, req(token, '', 'POST', {
      commands: [{ kind: 'SetTranslation', fileId: FILE, cellId: 'cell-1', value: 'hola' }],
    }))
    const id = prep.changeset.id as string

    const { res, body } = await call(env, req(token, `/${id}/discard`, 'POST'))
    expect(res.status).toBe(200)
    expect(body.changeset.status).toBe('discarded')

    // A discarded changeset cannot commit.
    await insertConfirmation(tdb.db, { id: 'conf-x', changesetId: id, digest: prep.digest })
    const { res: commitRes, body: commitBody } = await call(env, req(token, `/${id}/commit`, 'POST'))
    expect(commitRes.status).toBe(400)
    expect(commitBody.error.code).toBe('validation_failed')
  })
})

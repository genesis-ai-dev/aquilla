// AQU-1242 — a read-only PAT cannot change anything through the Agent API.
//
// What these guard is a promise made to a partner, not a field's shape: "hand
// this token to your agent and it cannot touch your translations." A hole
// anywhere in the write surface breaks that promise silently — the agent's
// changeset applies, the partner never sees a refusal, and the only evidence is
// an edit they did not authorize. So the assertions below are deliberately
// written from the OUTSIDE: real `aqk_` tokens seeded through the shared credential
// module, validated by the real `validateApiCredential`, driven through the real
// route handlers against real Postgres, and then checked against the DATABASE —
// no changeset row, no event row — rather than against the response code alone.
// (auth-worker's credentials.test.ts covers the other half of the seam: that
// minting `access: "read"` is what validation reports back.)
//
// The write surface of the external API, enumerated so a new one is a visible
// omission here: changeset prepare, changeset commit, and artifact upload. Every
// other external route is GET-only, and every event write — whatever route asks
// for it — has to pass `mintInternalSyncToken`, which is why that funnel is
// tested directly at the bottom.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// commit.ts → events/route.ts → broadcast.ts → partyserver (cloudflare:*).
vi.mock('partyserver', () => ({
  getServerByName: vi.fn().mockResolvedValue({
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  }),
}))

import { handleExternalChangesetsRequest } from '../external/changesets-route'
import { handleExternalArtifactsRequest } from '../external/artifacts-route'
import { handleExternalReadRequest } from '../external/read-routes'
import { sessionPrincipal } from '../external/session-routes'
import { mintInternalSyncToken } from '../external/token-bridge'
import { ExternalError } from '../external/errors'
import { mintApiToken, validateApiCredential } from '../../../db/shared/api-credentials'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'

const SECRET = 'test-secret'
const PROJECT = 'proj-a'
const FILE = 'file-x'
const CRED_READ = '00000000-0000-0000-0000-0000000000a1'
const CRED_WRITE = '00000000-0000-0000-0000-0000000000b1'

function makeEnv(db: AquillaDb) {
  return { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET, BASE_URL: 'https://aquilla.app' }
}

/** Seed a real credential row and mint a live token for it. `access` is written
 *  through the same column the mint route uses, so nothing here stubs the flag. */
async function credToken(
  tdb: TestDb,
  spec: { credentialId: string; access: 'read' | 'write'; mode?: 'ask' | 'act' },
): Promise<string> {
  await tdb.pg.query(
    `INSERT INTO users (id, username, email, password_hash) VALUES (1, 'alice', 'a@x.com', 'h')
     ON CONFLICT (id) DO NOTHING`,
  )
  const { token, tokenHash, tokenPrefix } = await mintApiToken()
  await tdb.pg.query(
    `INSERT INTO api_credentials (id, user_id, name, token_prefix, token_hash, mode, project_id, access)
     VALUES ($1, '1', 'test', $2, $3, $4, $5, $6)`,
    [spec.credentialId, tokenPrefix, tokenHash, spec.mode ?? 'act', PROJECT, spec.access],
  )
  return token
}

async function seedProject(): Promise<TestDb> {
  return makeTestDb({
    projects: [{ id: PROJECT, name: 'P', created_by: 99, org_id: null }],
    // Maintainer: the read-only refusals below must not be explainable by the
    // caller's role. Every one of them is the TOKEN's ceiling, not the human's.
    project_members: [{ project_id: PROJECT, user_id: 1, role_level: 600 }],
    cells: [
      {
        project_id: PROJECT, file_id: FILE, cell_id: 'cell-1', side: 'source',
        value: 'in the beginning', event_id: 'src-evt-1', last_edit_at: 1,
      },
    ],
    files: [{ id: FILE, project_id: PROJECT, name: 'Genesis', event_id: 'evt-file-1' }],
  })
}

function prepareReq(token: string, commands: unknown): Request {
  return new Request(`https://w/api/v1/external/projects/${PROJECT}/changesets`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ commands }),
  })
}

function commitReq(token: string, id: string): Request {
  return new Request(
    `https://w/api/v1/external/projects/${PROJECT}/changesets/${id}/commit`,
    { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
  )
}

const SET_TRANSLATION = [
  { kind: 'SetTranslation', fileId: FILE, cellId: 'cell-1', value: 'hello', valueHtml: '<p>hello</p>' },
]

let tdb: TestDb
beforeEach(async () => {
  tdb = await seedProject()
})

describe('read-only credential — write surfaces', () => {
  it('refuses to stage a changeset, and stages nothing', async () => {
    const env = makeEnv(tdb.db)
    const token = await credToken(tdb, { credentialId: CRED_READ, access: 'read' })

    const res = (await handleExternalChangesetsRequest(prepareReq(token, SET_TRANSLATION), env))!
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('scope_denied')
    // The message has to say WHY and what fixes it: this refusal is not
    // retryable and is not about the caller's role, so an agent that reads it as
    // a transient permission problem will loop on it forever.
    expect(body.error.message).toMatch(/read-only/)
    expect(body.error.message).toMatch(/read-write token/)

    expect(await tdb.rows('changesets')).toHaveLength(0)
  })

  it('refuses to commit a plan another token staged — the ceiling is the committer’s', async () => {
    const env = makeEnv(tdb.db)
    const writeToken = await credToken(tdb, { credentialId: CRED_WRITE, access: 'write' })
    const readToken = await credToken(tdb, { credentialId: CRED_READ, access: 'read' })

    const staged = (await handleExternalChangesetsRequest(prepareReq(writeToken, SET_TRANSLATION), env))!
    expect(staged.status).toBe(200)
    const { changeset } = (await staged.json()) as { changeset: { id: string } }

    const res = (await handleExternalChangesetsRequest(commitReq(readToken, changeset.id), env))!
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string; message: string } }
    // scope_denied, NOT "credential did not create this changeset": the access
    // ceiling is asserted before ownership, so the answer names the real reason
    // even for a plan this token could theoretically have owned.
    expect(body.error.code).toBe('scope_denied')
    expect(body.error.message).toMatch(/read-only/)

    // Nothing applied: the plan is still staged and no event landed.
    const rows = await tdb.rows<{ status: string }>('changesets')
    expect(rows.map((r) => r.status)).toEqual(['staged'])
    expect(await tdb.rows('events')).toHaveLength(0)
  })

  it('refuses an artifact upload', async () => {
    const env = { ...makeEnv(tdb.db), SNAPSHOTS: {} as R2Bucket }
    const token = await credToken(tdb, { credentialId: CRED_READ, access: 'read' })

    const res = (await handleExternalArtifactsRequest(
      new Request(`https://w/api/v1/external/projects/${PROJECT}/artifacts`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'x-artifact-name': 'gen.usfm' },
        body: '\\id GEN',
      }),
      env,
    ))!
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('scope_denied')
    expect(body.error.message).toMatch(/read-only/)
    expect(await tdb.rows('artifacts')).toHaveLength(0)
  })

  it('blocks the internal write-token funnel every event write must pass', async () => {
    // The backstop, tested directly: a future write route that forgets the
    // route-level check is still refused here, because it cannot get a token to
    // push events through the /events perimeter without passing this.
    const env = makeEnv(tdb.db)
    const readCred = await validateApiCredential(
      tdb.db,
      await credToken(tdb, { credentialId: CRED_READ, access: 'read' }),
    )
    expect(readCred?.access).toBe('read')

    await expect(
      mintInternalSyncToken(env, tdb.db, readCred!, PROJECT, FILE),
    ).rejects.toMatchObject({ code: 'scope_denied' })
    await expect(
      mintInternalSyncToken(env, tdb.db, readCred!, PROJECT, FILE),
    ).rejects.toBeInstanceOf(ExternalError)
  })
})

describe('read-only credential — read surfaces still work', () => {
  it('reports its own ceiling from /me so an agent learns it before it plans a write', async () => {
    const env = makeEnv(tdb.db)
    const token = await credToken(tdb, { credentialId: CRED_READ, access: 'read', mode: 'ask' })

    const res = (await handleExternalReadRequest(
      new Request('https://w/api/v1/external/me', { headers: { Authorization: `Bearer ${token}` } }),
      env,
    ))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as { access: string; hints: Record<string, string> }
    expect(body.access).toBe('read')
    expect(body.hints.access).toMatch(/read-only/)
    // The mode hint must not promise an approval flow that cannot happen.
    expect(body.hints.mode).toMatch(/not applicable/)
  })

  it('reads a project’s files and cells exactly like a read-write token', async () => {
    const env = makeEnv(tdb.db)
    const readToken = await credToken(tdb, { credentialId: CRED_READ, access: 'read' })
    const writeToken = await credToken(tdb, { credentialId: CRED_WRITE, access: 'write' })

    const read = async (token: string) => {
      const res = (await handleExternalReadRequest(
        new Request(
          `https://w/api/v1/external/projects/${PROJECT}/files/${FILE}/cells`,
          { headers: { Authorization: `Bearer ${token}` } },
        ),
        env,
      ))!
      expect(res.status).toBe(200)
      return (await res.json()) as { data: unknown[] }
    }

    // Same payload from both: "read-only" narrows writes, never reads.
    expect(await read(readToken)).toEqual(await read(writeToken))
  })
})

describe('read-write credential — unchanged (back-compat)', () => {
  it('stages and commits, landing a real event', async () => {
    const env = makeEnv(tdb.db)
    const token = await credToken(tdb, { credentialId: CRED_WRITE, access: 'write' })

    const staged = (await handleExternalChangesetsRequest(prepareReq(token, SET_TRANSLATION), env))!
    expect(staged.status).toBe(200)
    const { changeset } = (await staged.json()) as { changeset: { id: string } }

    const res = (await handleExternalChangesetsRequest(commitReq(token, changeset.id), env))!
    expect(res.status).toBe(200)

    const events = await tdb.rows<{ kind: string }>('events')
    expect(events.map((e) => e.kind)).toContain('target.cell.commit')
  })

  it('a credential row written without the column defaults to read-write', async () => {
    // What every token minted before 0112 is. If this ever came back 'read', the
    // migration would have locked partners out of their own agents overnight.
    const { token, tokenHash, tokenPrefix } = await mintApiToken()
    await tdb.pg.query(
      `INSERT INTO users (id, username, email, password_hash) VALUES (1, 'alice', 'a@x.com', 'h')
       ON CONFLICT (id) DO NOTHING`,
    )
    await tdb.pg.query(
      `INSERT INTO api_credentials (id, user_id, name, token_prefix, token_hash, mode, project_id)
       VALUES ($1, '1', 'legacy', $2, $3, 'act', $4)`,
      ['00000000-0000-0000-0000-0000000000c1', tokenPrefix, tokenHash, PROJECT],
    )

    expect((await validateApiCredential(tdb.db, token))?.access).toBe('write')
  })

  it('the in-app session principal is never read-only', async () => {
    // The shared prepare/commit cores take this principal too, so a read-only
    // default here would have silently broken the browser's own agent surface.
    expect(
      sessionPrincipal({ userId: 1, username: 'alice', projectId: PROJECT, fileId: '', role: 600, aud: 'sync', iat: 0, exp: 0 }).access,
    ).toBe('write')
  })
})

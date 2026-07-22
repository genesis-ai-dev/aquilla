// Cold-start / discoverability tests for the Agent API (adversarial-UX pass).
//
// An agent holding only an `aqk_` token must be able to converge on the API
// without prior knowledge: the unauthenticated discovery root describes the
// surface, /me and /projects bootstrap REST, unmatched external paths return a
// self-describing JSON 404 (never bare text), a GET on the MCP endpoint
// explains how to actually talk to it, and 401s teach the auth scheme.

import { describe, it, expect, beforeEach, vi } from 'vitest'

// mcp-route pulls in the changeset commit path, which reaches partyserver
// (cloudflare:*) — stub it exactly as external-mcp.test.ts does.
vi.mock('partyserver', () => ({
  getServerByName: vi.fn().mockResolvedValue({
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  }),
}))

import { handleExternalDiscoveryRequest } from '../external/discovery-route'
import { handleExternalMcpRequest } from '../external/mcp-route'
import { handleExternalReadRequest } from '../external/read-routes'
import { mintApiToken } from '../../../db/shared/api-credentials'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'

const SECRET = 'test-secret'
const PROJECT = 'proj-a'
const CRED_1 = '00000000-0000-0000-0000-000000000001'

function makeEnv(db: AquillaDb) {
  return { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET, BASE_URL: 'https://aquilla.app' }
}

async function credToken(tdb: TestDb): Promise<string> {
  await tdb.pg.query(
    `INSERT INTO users (id, username, email, password_hash) VALUES (1, 'alice', 'alice@x.com', 'h')
     ON CONFLICT (id) DO NOTHING`,
  )
  const { token, tokenHash, tokenPrefix } = await mintApiToken()
  await tdb.pg.query(
    `INSERT INTO api_credentials (id, user_id, name, token_prefix, token_hash, mode, org_id, project_id)
     VALUES ($1, '1', 'test', $2, $3, 'ask', NULL, NULL)`,
    [CRED_1, tokenPrefix, tokenHash],
  )
  return token
}

let tdb: TestDb
beforeEach(async () => {
  tdb = await makeTestDb({
    projects: [{ id: PROJECT, name: 'Project A', created_by: 99, org_id: null }],
    project_members: [{ project_id: PROJECT, user_id: 1, role_level: 400 }],
  })
})

describe('discovery root', () => {
  it('GET /api/v1/external returns the API map without auth', async () => {
    const res = handleExternalDiscoveryRequest(new Request('https://w/api/v1/external'))
    expect(res!.status).toBe(200)
    const body = (await res!.json()) as any
    expect(body.name).toBe('Aquilla Agent API')
    expect(body.auth.header).toContain('Bearer aqk_')
    expect(body.quickstart.length).toBeGreaterThan(0)
    expect(body.mcp.endpoint).toBe('/api/v1/external/mcp')
    expect(Object.keys(body.endpoints)).toContain('GET /api/v1/external/me')
    expect(body.errors.codes.confirmation_required).toBeDefined()
  })

  it('trailing slash also serves the map; non-GET is a JSON 405', async () => {
    const slash = handleExternalDiscoveryRequest(new Request('https://w/api/v1/external/'))
    expect(slash!.status).toBe(200)
    const post = handleExternalDiscoveryRequest(
      new Request('https://w/api/v1/external', { method: 'POST' }),
    )
    expect(post!.status).toBe(405)
    expect(((await post!.json()) as any).error.code).toBe('validation_failed')
  })

  it('unmatched /api/v1/external/* paths get a JSON 404 with a hint', async () => {
    const res = handleExternalDiscoveryRequest(
      new Request('https://w/api/v1/external/projects/proj-a/nope'),
    )
    expect(res!.status).toBe(404)
    const body = (await res!.json()) as any
    expect(body.error.code).toBe('not_found')
    expect(body.error.details.hint).toContain('GET /api/v1/external')
  })

  it('does not claim non-external paths', () => {
    expect(handleExternalDiscoveryRequest(new Request('https://w/api/v1/projects/x'))).toBeNull()
    expect(handleExternalDiscoveryRequest(new Request('https://w/events'))).toBeNull()
  })
})

describe('REST bootstrap: /me and /projects', () => {
  it('GET /me returns identity, mode, scope, and next-step hints', async () => {
    const env = makeEnv(tdb.db)
    const token = await credToken(tdb)
    const res = await handleExternalReadRequest(
      new Request('https://w/api/v1/external/me', {
        headers: { Authorization: `Bearer ${token}` },
      }),
      env,
    )
    expect(res!.status).toBe(200)
    const body = (await res!.json()) as any
    expect(body.username).toBe('alice')
    expect(body.mode).toBe('ask')
    expect(body.credentialId).toBe(CRED_1)
    expect(body.hints.mode).toContain('approvalUrl')
    expect(body.hints.next).toContain('/api/v1/external/projects')
  })

  it('GET /projects lists accessible projects', async () => {
    const env = makeEnv(tdb.db)
    const token = await credToken(tdb)
    const res = await handleExternalReadRequest(
      new Request('https://w/api/v1/external/projects', {
        headers: { Authorization: `Bearer ${token}` },
      }),
      env,
    )
    expect(res!.status).toBe(200)
    const body = (await res!.json()) as any
    expect(body.data).toEqual([
      { id: PROJECT, name: 'Project A', org_id: null, role_source: 'member' },
    ])
    expect(body.nextCursor).toBeNull()
  })

  it('401s teach the auth scheme and point at the discovery root', async () => {
    const env = makeEnv(tdb.db)
    const noAuth = await handleExternalReadRequest(
      new Request('https://w/api/v1/external/me'),
      env,
    )
    expect(noAuth!.status).toBe(401)
    const noAuthBody = (await noAuth!.json()) as any
    expect(noAuthBody.error.code).toBe('permission_denied')
    expect(noAuthBody.error.message).toContain('Bearer aqk_')
    expect(noAuthBody.error.message).toContain('GET /api/v1/external')

    const badKey = await handleExternalReadRequest(
      new Request('https://w/api/v1/external/projects', {
        headers: { Authorization: 'Bearer aqk_not-real' },
      }),
      env,
    )
    expect(badKey!.status).toBe(401)
    expect(((await badKey!.json()) as any).error.message).toContain('Bearer aqk_')
  })
})

describe('MCP endpoint teaches on wrong method', () => {
  it('GET /mcp is a JSON 405 explaining POST JSON-RPC and the REST fallback', async () => {
    const env = makeEnv(tdb.db)
    const res = await handleExternalMcpRequest(
      new Request('https://w/api/v1/external/mcp', { method: 'GET' }),
      env,
    )
    expect(res!.status).toBe(405)
    expect(res!.headers.get('Allow')).toBe('POST')
    const body = (await res!.json()) as any
    expect(body.error.message).toContain('JSON-RPC')
    expect(body.error.message).toContain('get_capabilities')
    expect(body.error.message).toContain('GET /api/v1/external')
  })
})

describe('get_capabilities quickstart', () => {
  it('publishes the numbered golden path', async () => {
    const env = makeEnv(tdb.db)
    const token = await credToken(tdb)
    const res = await handleExternalMcpRequest(
      new Request('https://w/api/v1/external/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'get_capabilities', arguments: {} },
        }),
      }),
      env,
    )
    const body = (await res!.json()) as any
    const payload = JSON.parse(body.result.content[0].text)
    expect(payload.quickstart).toHaveLength(5)
    expect(payload.quickstart[0]).toContain('get_identity_and_scope')
    expect(payload.quickstart[4]).toContain('confirm_changeset')
  })
})

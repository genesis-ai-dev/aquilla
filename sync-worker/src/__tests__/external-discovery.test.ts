// Cold-start / discoverability tests for the Agent API (adversarial-UX pass).
//
// An agent holding only an `aqk_` token must be able to converge on the API
// without prior knowledge: the unauthenticated discovery root describes the
// surface, /me and /projects bootstrap REST, unmatched external paths return a
// self-describing JSON 404 (never bare text), a GET on the MCP endpoint
// explains how to actually talk to it, and 401s teach the auth scheme.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

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
import { UI_ONLY_SURFACES } from '../external/ui-only'
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
    expect(body.endpoints['GET /api/v1/external/me']).toContain('credentialId')
    expect(body.endpoints['GET /api/v1/external/me']).not.toMatch(/userId, username/)
    expect(body.privacy.note).toContain('AQU-1180')
    expect(body.orgScopedReads.maxProjectsPerSearch).toBe(10)
    expect(body.errors.codes.confirmation_required).toBeDefined()
    // AQU-538: the map teaches the multi-target-language (lanes) workflow —
    // register targetLanes, write SetTranslation.laneId, read ?lane=.
    expect(body.multiLanguage.note).toContain('targetLanes')
    expect(body.multiLanguage.workflow.join(' ')).toContain('laneId')
    expect(body.multiLanguage.workflow.join(' ')).toContain('lane=es')
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
    // AQU-1180: /me answers "which token", not "which human". A default
    // credential must not carry the minting user's handle into an AI console.
    expect(body.username).toBeUndefined()
    expect(body.userId).toBeUndefined()
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
    expect(payload.quickstart).toHaveLength(6)
    expect(payload.quickstart[0]).toContain('get_identity_and_scope')
    expect(payload.quickstart[4]).toContain('confirm_changeset')
    // The path ends where the work ends: pulling the deliverable back out (AQU-858).
    expect(payload.quickstart[5]).toContain('export_file')
  })
})

// AQU-1178 — intentional exclusions. An agent must be able to learn that
// credential minting / project deletion / billing / self-approval are UI-only
// BY DESIGN, from the API map, from get_capabilities, and from the miss it hits
// when it probes for them — otherwise a `not_found` reads as "guess again".
describe('uiOnly — intentional exclusions', () => {
  const REQUIRED_IDS = ['credential-minting', 'project-deletion', 'billing', 'changeset-approval']

  it('the API map publishes the uiOnly list with reasons and human paths', async () => {
    const res = handleExternalDiscoveryRequest(new Request('https://w/api/v1/external'))
    const body = (await res!.json()) as any
    expect(body.uiOnly.note).toContain('always will be')
    expect(body.uiOnly.exclusions.map((e: { id: string }) => e.id)).toEqual(
      expect.arrayContaining(REQUIRED_IDS),
    )
    for (const exclusion of body.uiOnly.exclusions) {
      expect(exclusion.what.length).toBeGreaterThan(0)
      expect(exclusion.why.length).toBeGreaterThan(0)
      expect(exclusion.humanPath.length).toBeGreaterThan(0)
    }
  })

  it('get_capabilities publishes the SAME uiOnly payload as the API map', async () => {
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
    const caps = JSON.parse(((await res!.json()) as any).result.content[0].text)
    const map = await handleExternalDiscoveryRequest(
      new Request('https://w/api/v1/external'),
    )!.json()
    // Both adapters read one module — byte-identical, not merely overlapping.
    expect(caps.uiOnly).toEqual((map as any).uiOnly)
  })

  it('404s on those paths name the exclusion instead of the generic hint', async () => {
    for (const [path, id] of [
      ['/api/v1/external/credentials', 'credential-minting'],
      ['/api/v1/external/projects/proj-a/delete', 'project-deletion'],
      ['/api/v1/external/billing', 'billing'],
      ['/api/v1/external/projects/proj-a/changesets/cs-1/approve', 'changeset-approval'],
    ] as const) {
      const res = handleExternalDiscoveryRequest(new Request(`https://w${path}`))
      expect(res!.status).toBe(404)
      const body = (await res!.json()) as any
      expect(body.error.code).toBe('not_found')
      expect(body.error.details.uiOnly).toBe(id)
      expect(body.error.details.hint).toContain('intentionally UI-only')
      expect(body.error.details.hint).toContain('uiOnly section of the API map')
    }
  })

  it('an ordinary wrong path keeps the generic map hint (no false positives)', async () => {
    const res = handleExternalDiscoveryRequest(
      new Request('https://w/api/v1/external/projects/token-store-x/cells'),
    )
    const body = (await res!.json()) as any
    expect(body.error.details.uiOnly).toBeUndefined()
    expect(body.error.details.hint).toContain('GET /api/v1/external')
  })

  it('an invented tool name for a UI-only surface gets the same explanation', async () => {
    const env = makeEnv(tdb.db)
    const token = await credToken(tdb)
    const res = await handleExternalMcpRequest(
      new Request('https://w/api/v1/external/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 7,
          method: 'tools/call',
          params: { name: 'mint_credential', arguments: {} },
        }),
      }),
      env,
    )
    const body = (await res!.json()) as any
    expect(body.error.message).toContain('intentionally UI-only')
    expect(body.error.message).toContain('Preferences')
  })

  it('docs/AGENT-API.md documents exactly the shipped exclusion ids (no drift)', async () => {
    const doc = await readFile(resolve(import.meta.dirname, '../../../docs/AGENT-API.md'), 'utf8')
    for (const surface of UI_ONLY_SURFACES) {
      expect(doc).toContain(`\`${surface.id}\``)
    }
    // …and documents nothing extra: every id in the doc's uiOnly table ships.
    const documented = [...doc.matchAll(/^\| `([a-z-]+)` \| /gm)].map((m) => m[1])
    expect(documented.sort()).toEqual(UI_ONLY_SURFACES.map((s) => s.id).sort())
  })
})

// OAuth discovery + host metadata for the Agent API MCP server.
//
// Contract under test: an MCP host (ChatGPT, Claude, Codex) that connects
// without a token must be able to find the authorization server from the 401
// alone, and every tool must say whether it changes anything so the host can
// ask the user at the right moments. The identity worker's half of the flow is
// covered in auth-worker/src/__tests__/mcp-oauth.test.ts.

import { describe, it, expect, beforeAll, vi } from 'vitest'

// mcp-route -> mcp-handlers -> commit path -> partyserver (cloudflare:*), as
// in external-mcp.test.ts. Nothing here commits; the import just has to load.
vi.mock('partyserver', () => ({ getServerByName: vi.fn() }))

import { handleExternalMcpRequest } from '../external/mcp-route'
import { handleMcpProtectedResourceRequest, mcpWwwAuthenticate } from '../external/mcp-oauth-metadata'
import { MCP_TOOLS, TOOL_KINDS } from '../external/mcp-tools'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'

const ISSUER = 'https://api.aquilla.app/identity'
let tdb: TestDb

beforeAll(async () => {
  tdb = await makeTestDb({})
})

function env() {
  return { AQUILLA_PG: tdb.db, SYNC_SECRET_KEY: 's', BASE_URL: 'https://aquilla.app', AUTH_WORKER_URL: ISSUER }
}

/** POST to the MCP endpoint the way the deployed worker sees it: the `/sync`
 *  mount has already been stripped and is passed separately. */
async function postMcp(authorization: string | null): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (authorization) headers.Authorization = authorization
  const res = await handleExternalMcpRequest(
    new Request('https://api.aquilla.app/api/v1/external/mcp', {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    }),
    env(),
    undefined,
    '/sync',
  )
  return res!
}

describe('MCP 401 challenge', () => {
  it('names the protected-resource metadata under the public /sync mount', async () => {
    const res = await postMcp(null)
    expect(res.status).toBe(401)
    expect(res.headers.get('WWW-Authenticate')).toBe(
      'Bearer resource_metadata="https://api.aquilla.app/sync/.well-known/oauth-protected-resource/api/v1/external/mcp", scope="ask"',
    )
    // Browser-based MCP clients must be able to read the header cross-origin.
    expect(res.headers.get('Access-Control-Expose-Headers')).toContain('WWW-Authenticate')
    // The body keeps the stable errors.ts envelope for non-OAuth agents.
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('permission_denied')
  })

  it('marks a rejected token invalid_token so the host re-runs sign-in', async () => {
    const res = await postMcp('Bearer aqk_revoked-or-made-up')
    expect(res.status).toBe(401)
    const challenge = res.headers.get('WWW-Authenticate') ?? ''
    expect(challenge).toMatch(/^Bearer error="invalid_token", error_description="[^"]+", resource_metadata="/)
  })

  it('never lets a description break out of the quoted parameter', () => {
    const header = mcpWwwAuthenticate('https://h', { code: 'invalid_token', description: 'a "quoted" thing' })
    expect(header).toContain(`error_description="a 'quoted' thing"`)
  })
})

describe('protected-resource metadata (RFC 9728)', () => {
  function get(url: string, mountPrefix: string, method = 'GET') {
    return handleMcpProtectedResourceRequest(new Request(url, { method }), env(), mountPrefix)
  }

  it('serves the advertised URL under the /sync mount', async () => {
    const res = get('https://api.aquilla.app/.well-known/oauth-protected-resource/api/v1/external/mcp', '/sync')
    expect(res!.status).toBe(200)
    expect(await res!.json()).toEqual({
      resource: 'https://api.aquilla.app/sync/api/v1/external/mcp',
      authorization_servers: [ISSUER],
      scopes_supported: ['ask', 'act'],
      bearer_methods_supported: ['header'],
      resource_name: 'Aquilla',
    })
  })

  it('serves the RFC 9728 root location when the zone route sends it unprefixed', async () => {
    const res = get('https://api.aquilla.app/.well-known/oauth-protected-resource/sync/api/v1/external/mcp', '')
    expect(res!.status).toBe(200)
    expect(((await res!.json()) as { resource: string }).resource).toBe(
      'https://api.aquilla.app/sync/api/v1/external/mcp',
    )
  })

  it('resolves a direct worker URL (local dev, previews) to itself', async () => {
    const res = get('http://127.0.0.1:8787/.well-known/oauth-protected-resource/api/v1/external/mcp', '')
    expect(((await res!.json()) as { resource: string }).resource).toBe(
      'http://127.0.0.1:8787/api/v1/external/mcp',
    )
  })

  it('does not guess a resource for the bare well-known path at the shared API host', () => {
    expect(get('https://api.aquilla.app/.well-known/oauth-protected-resource', '')).toBeNull()
    // Under the mount the same bare path is unambiguous.
    expect(get('https://api.aquilla.app/.well-known/oauth-protected-resource', '/sync')!.status).toBe(200)
  })

  it('ignores unrelated paths and rejects writes', () => {
    expect(get('https://api.aquilla.app/.well-known/oauth-protected-resource/elsewhere', '/sync')).toBeNull()
    expect(get('https://api.aquilla.app/api/v1/external/mcp', '/sync')).toBeNull()
    expect(
      get('https://api.aquilla.app/.well-known/oauth-protected-resource/api/v1/external/mcp', '/sync', 'POST')!.status,
    ).toBe(405)
  })
})

describe('tool annotations', () => {
  it('classifies every tool deliberately — no tool falls through to the default', () => {
    expect(Object.keys(TOOL_KINDS).sort()).toEqual(MCP_TOOLS.map((t) => t.name).sort())
  })

  it('marks reads read-only and only confirm_changeset destructive', () => {
    const byName = Object.fromEntries(MCP_TOOLS.map((t) => [t.name, t.annotations]))
    for (const name of ['read_quality', 'list_projects', 'list_changesets', 'read_comments', 'export_file']) {
      expect(byName[name]).toMatchObject({ readOnlyHint: true, destructiveHint: false })
    }
    // Staging is a write (a host should be allowed to ask) but changes no project content.
    expect(byName.prepare_translations).toMatchObject({ readOnlyHint: false, destructiveHint: false })
    expect(byName.confirm_changeset).toMatchObject({ readOnlyHint: false, destructiveHint: true })
    expect(MCP_TOOLS.filter((t) => t.annotations.destructiveHint).map((t) => t.name)).toEqual(['confirm_changeset'])
    for (const tool of MCP_TOOLS) {
      expect(tool.annotations.openWorldHint).toBe(false)
      expect(tool.annotations.title.length).toBeGreaterThan(0)
    }
  })

  it('declares OAuth on every tool, in both the Apps SDK and _meta forms', () => {
    for (const tool of MCP_TOOLS) {
      expect(tool.securitySchemes).toEqual([{ type: 'oauth2', scopes: [] }])
      expect(tool._meta.securitySchemes).toEqual(tool.securitySchemes)
    }
  })
})

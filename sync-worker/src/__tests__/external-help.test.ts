// App help (AQU-2581): the get_help MCP tool, its REST mirror, and the
// discovery entries. The help site is not live yet, so fetch is mocked. The
// properties worth guarding: only index-listed pages are fetched, every
// accepted page form lands on the same page, outages are tool errors (never
// throws), and the tool is read-only and reachable like get_skill.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// mcp-route pulls in the changeset commit path, which reaches partyserver
// (cloudflare:*) — stub it exactly as external-skills.test.ts does.
vi.mock('partyserver', () => ({
  getServerByName: vi.fn().mockResolvedValue({
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  }),
}))

import { handleExternalHelpRequest } from '../external/help-route'
import { handleExternalDiscoveryRequest } from '../external/discovery-route'
import { handleExternalMcpRequest } from '../external/mcp-route'
import { MCP_TOOLS, TOOL_KINDS } from '../external/mcp-tools'
import { mintApiToken } from '../../../db/shared/api-credentials'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'

const SECRET = 'test-secret'
const PROJECT = 'proj-a'
const CRED_1 = '00000000-0000-0000-0000-000000000001'

const SITE = 'https://help.aquilla.app'
const INDEX_URL = `${SITE}/llms-index.json`
const EXPORT_MD = `${SITE}/export.md`
const EXPORT_MARKDOWN = '# Export a file\n\nOpen the file menu and choose Export.'

const INDEX = {
  generatedAt: '2026-11-13T00:00:00Z',
  site: 'Aquilla Help',
  pages: [
    {
      path: '/export/',
      title: 'Export a file',
      description: 'Download a file in its delivered format.',
      section: 'Files',
      url: `${SITE}/export/`,
      markdownUrl: EXPORT_MD,
    },
    {
      path: '/roles/',
      title: 'Roles',
      description: 'What each role can do.',
      section: 'Team',
      url: `${SITE}/roles/`,
      markdownUrl: `${SITE}/roles.md`,
    },
  ],
}

/** Routes the mocked help site. `overrides` replaces one URL's response. */
function mockHelpSite(overrides: Record<string, () => Response | Promise<Response>> = {}) {
  const routes: Record<string, () => Response | Promise<Response>> = {
    [INDEX_URL]: () => Response.json(INDEX),
    [EXPORT_MD]: () => new Response(EXPORT_MARKDOWN, { status: 200 }),
    ...overrides,
  }
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input)
    const route = routes[url]
    return route ? route() : new Response('not found', { status: 404 })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

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

async function callTool(tdb: TestDb, token: string, name: string, args: Record<string, unknown>) {
  const res = await handleExternalMcpRequest(
    new Request('https://w/api/v1/external/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    }),
    makeEnv(tdb.db),
  )
  const body = (await res!.json()) as { result: { content: { text: string }[]; isError?: boolean } }
  return { payload: JSON.parse(body.result.content[0].text), isError: body.result.isError === true }
}

let tdb: TestDb
beforeEach(async () => {
  tdb = await makeTestDb({
    projects: [{ id: PROJECT, name: 'Project A', created_by: 99, org_id: null }],
    project_members: [{ project_id: PROJECT, user_id: 1, role_level: 400 }],
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('MCP get_help: the index', () => {
  it('omits page and returns every indexed page without its markdownUrl', async () => {
    const fetchMock = mockHelpSite()
    const token = await credToken(tdb)
    const { payload, isError } = await callTool(tdb, token, 'get_help', {})
    expect(isError).toBe(false)
    expect(payload.site).toBe('Aquilla Help')
    expect(payload.pages).toEqual([
      { path: '/export/', title: 'Export a file', description: 'Download a file in its delivered format.', section: 'Files', url: `${SITE}/export/` },
      { path: '/roles/', title: 'Roles', description: 'What each role can do.', section: 'Team', url: `${SITE}/roles/` },
    ])
    expect(payload.pages[0]).not.toHaveProperty('markdownUrl')
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual([INDEX_URL])
  })

  it('reads with the Workers cache: five minutes, cache everything', async () => {
    const fetchMock = mockHelpSite()
    const token = await credToken(tdb)
    await callTool(tdb, token, 'get_help', {})
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ cf: { cacheTtl: 300, cacheEverything: true } })
  })
})

describe('MCP get_help: one page', () => {
  it.each([
    '/export/',
    'export',
    '/export',
    'export/',
    `${SITE}/export/`,
    `${SITE}/export/?from=search#top`,
  ])('accepts %s and returns the indexed page', async (page) => {
    mockHelpSite()
    const token = await credToken(tdb)
    const { payload, isError } = await callTool(tdb, token, 'get_help', { page })
    expect(isError).toBe(false)
    expect(payload).toEqual({ path: '/export/', title: 'Export a file', url: `${SITE}/export/`, markdown: EXPORT_MARKDOWN })
  })

  it('returns a not_found tool error that points back to the index', async () => {
    mockHelpSite()
    const token = await credToken(tdb)
    const { payload, isError } = await callTool(tdb, token, 'get_help', { page: 'nope' })
    expect(isError).toBe(true)
    expect(payload.error.code).toBe('not_found')
    expect(payload.error.message).toBe('unknown help page "nope"')
    expect(payload.error.details.hint).toContain('get_help with no page')
  })

  it('never fetches a page the index does not list, whatever the input', async () => {
    const fetchMock = mockHelpSite()
    const token = await credToken(tdb)
    for (const page of ['https://evil.example/export/', 'https://evil.example/export.md', '/../secret/', '//evil.example/x']) {
      const { isError, payload } = await callTool(tdb, token, 'get_help', { page })
      expect(isError, page).toBe(true)
      expect(payload.error.code, page).toBe('not_found')
    }
    const urls = fetchMock.mock.calls.map((c) => String(c[0]))
    expect(urls.every((u) => u === INDEX_URL || u.startsWith(`${SITE}/`))).toBe(true)
    expect(urls.some((u) => u.includes('evil.example') || u.includes('secret'))).toBe(false)
  })
})

describe('MCP get_help: upstream failures are tool errors', () => {
  const unavailable = `help site unavailable, try again later; the pages are also readable at ${SITE}`

  it('a non-200 index is job_failed, and the other tools still answer', async () => {
    mockHelpSite({ [INDEX_URL]: () => new Response('boom', { status: 500 }) })
    const token = await credToken(tdb)
    const help = await callTool(tdb, token, 'get_help', {})
    expect(help.isError).toBe(true)
    expect(help.payload.error.code).toBe('job_failed')
    expect(help.payload.error.message).toBe(unavailable)
    const other = await callTool(tdb, token, 'get_capabilities', {})
    expect(other.isError).toBe(false)
  })

  it('a bad JSON index is job_failed', async () => {
    mockHelpSite({ [INDEX_URL]: () => new Response('<html>not json</html>', { status: 200 }) })
    const token = await credToken(tdb)
    const { payload, isError } = await callTool(tdb, token, 'get_help', { page: 'export' })
    expect(isError).toBe(true)
    expect(payload.error.code).toBe('job_failed')
    expect(payload.error.message).toBe(unavailable)
  })

  it('a network error is job_failed and does not throw', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))
    const token = await credToken(tdb)
    const { payload, isError } = await callTool(tdb, token, 'get_help', {})
    expect(isError).toBe(true)
    expect(payload.error.code).toBe('job_failed')
  })

  it('a failing page is job_failed', async () => {
    mockHelpSite({ [EXPORT_MD]: () => new Response('gone', { status: 503 }) })
    const token = await credToken(tdb)
    const { payload, isError } = await callTool(tdb, token, 'get_help', { page: 'export' })
    expect(isError).toBe(true)
    expect(payload.error.code).toBe('job_failed')
  })
})

describe('get_help catalogue entries', () => {
  it('is a read-only tool with the same annotations as get_skill', () => {
    const help = MCP_TOOLS.find((t) => t.name === 'get_help')!
    const skill = MCP_TOOLS.find((t) => t.name === 'get_skill')!
    expect(TOOL_KINDS.get_help).toBe('read')
    expect(help.annotations).toEqual({ ...skill.annotations, title: 'Get help' })
    expect(help.annotations.readOnlyHint).toBe(true)
    expect(help.description).toContain('how to do something in Aquilla')
    expect(help.description).toContain('get_skill')
    expect(help.description).toContain('llms-full.txt')
  })

  it('get_capabilities publishes a help block that names the tool', async () => {
    const token = await credToken(tdb)
    const { payload, isError } = await callTool(tdb, token, 'get_capabilities', {})
    expect(isError).toBe(false)
    expect(payload.help.tool).toBe('get_help')
    expect(payload.help.note).toContain('https://help.aquilla.app')
  })

  it('the discovery document lists both REST routes and a help block', async () => {
    const res = handleExternalDiscoveryRequest(new Request('https://w/api/v1/external'))
    const body = (await res!.json()) as { endpoints: Record<string, string>; help: { tool: string; index: string } }
    expect(Object.keys(body.endpoints)).toEqual(expect.arrayContaining([
      'GET /api/v1/external/help',
      'GET /api/v1/external/help/:page',
    ]))
    expect(body.help).toMatchObject({ tool: 'get_help', index: 'GET /api/v1/external/help' })
  })
})

describe('GET /api/v1/external/help', () => {
  const env = {}

  it('serves the index and one page, unauthenticated', async () => {
    mockHelpSite()
    const index = await handleExternalHelpRequest(new Request('https://w/api/v1/external/help'), env)
    expect(index!.status).toBe(200)
    const indexBody = (await index!.json()) as { pages: { path: string }[] }
    expect(indexBody.pages.map((p) => p.path)).toEqual(['/export/', '/roles/'])

    const page = await handleExternalHelpRequest(new Request('https://w/api/v1/external/help/export/'), env)
    expect(page!.status).toBe(200)
    expect(await page!.json()).toEqual({ path: '/export/', title: 'Export a file', url: `${SITE}/export/`, markdown: EXPORT_MARKDOWN })

    const noSlash = await handleExternalHelpRequest(new Request('https://w/api/v1/external/help/export'), env)
    expect(noSlash!.status).toBe(200)
    const trailing = await handleExternalHelpRequest(new Request('https://w/api/v1/external/help/'), env)
    expect(trailing!.status).toBe(200)
  })

  it('404s an unlisted page as not_found, 500s an outage as job_failed', async () => {
    mockHelpSite()
    const missing = await handleExternalHelpRequest(new Request('https://w/api/v1/external/help/nope/'), env)
    expect(missing!.status).toBe(404)
    expect(((await missing!.json()) as { error: { code: string } }).error.code).toBe('not_found')

    mockHelpSite({ [INDEX_URL]: () => new Response('boom', { status: 502 }) })
    const down = await handleExternalHelpRequest(new Request('https://w/api/v1/external/help'), env)
    expect(down!.status).toBe(500)
    expect(((await down!.json()) as { error: { code: string } }).error.code).toBe('job_failed')
  })

  it('405s a non-GET and ignores unrelated paths', async () => {
    const posted = await handleExternalHelpRequest(new Request('https://w/api/v1/external/help', { method: 'POST' }), env)
    expect(posted!.status).toBe(405)
    expect(posted!.headers.get('Allow')).toBe('GET')
    expect(await handleExternalHelpRequest(new Request('https://w/api/v1/external/skills'), env)).toBeNull()
  })

  it('reads the site from HELP_SITE_URL when it is set', async () => {
    const fetchMock = mockHelpSite({ 'https://staging.example/llms-index.json': () => Response.json({ site: 'Staging', pages: [] }) })
    const res = await handleExternalHelpRequest(
      new Request('https://w/api/v1/external/help'),
      { HELP_SITE_URL: 'https://staging.example/' },
    )
    expect(await res!.json()).toMatchObject({ site: 'Staging', pages: [] })
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://staging.example/llms-index.json')
  })
})

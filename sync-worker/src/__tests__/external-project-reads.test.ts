// AQU-1222 — the read half of the settings/version + command-docs surface.
//
// Live verification on 2026-09-09 found three gaps that made PatchSettings
// (shipped by AQU-1176) effectively unusable for an external agent:
//   1. GET /projects/:id 404'd, so nothing published the settings `version`
//      that PatchSettings.ifMatchVersion must equal — callers had to guess it.
//   2. describe_command was reachable only from the in-app harness, even though
//      get_capabilities pointed external agents at it, so command shapes could
//      only be learned one validation_failed at a time.
//   3. The API map's docs link pointed into a private repo and 404'd for every
//      external caller.
//
// These tests guard the corrected behavior of all three.

import { describe, it, expect, beforeEach, vi } from 'vitest'

// mcp-handlers pulls in the changeset commit path, which reaches partyserver
// (cloudflare:*) — stub it exactly as external-mcp.test.ts does.
vi.mock('partyserver', () => ({
  getServerByName: vi.fn().mockResolvedValue({
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  }),
}))

import { handleExternalReadRequest } from '../external/read-routes'
import { handleExternalCommandsDocRequest } from '../external/commands-doc-route'
import { handleExternalDiscoveryRequest, DOCS_URL } from '../external/discovery-route'
import { callTool } from '../external/mcp-handlers'
import { COMMAND_CATALOG } from '../../../db/shared/command-catalog'
import { mintApiToken, validateApiCredential } from '../../../db/shared/api-credentials'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'

const SECRET = 'test-secret'
const PROJECT = 'proj-a'
const OTHER_PROJECT = 'proj-b'
const CRED_UNSCOPED = '00000000-0000-0000-0000-000000000001'
const CRED_OTHER_PROJECT = '00000000-0000-0000-0000-000000000002'

function makeEnv(db: AquillaDb) {
  return { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET, BASE_URL: 'https://aquilla.app' }
}

async function seedCredential(
  tdb: TestDb,
  id: string,
  opts: { projectId?: string | null } = {},
): Promise<string> {
  const { token, tokenHash, tokenPrefix } = await mintApiToken()
  await tdb.pg.query(
    `INSERT INTO api_credentials (id, user_id, name, token_prefix, token_hash, mode, org_id, project_id)
     VALUES ($1, '1', 'test', $2, $3, 'ask', NULL, $4)`,
    [id, tokenPrefix, tokenHash, opts.projectId ?? null],
  )
  return token
}

function get(path: string, token?: string): Request {
  const headers: Record<string, string> = {}
  if (token !== undefined) headers['Authorization'] = `Bearer ${token}`
  return new Request(`https://w${path}`, { headers })
}

let tdb: TestDb
beforeEach(async () => {
  tdb = await makeTestDb({
    projects: [
      { id: PROJECT, name: 'Project A', created_by: 99, org_id: null },
      { id: OTHER_PROJECT, name: 'Project B', created_by: 99, org_id: null },
    ],
    project_members: [
      { project_id: PROJECT, user_id: 1, role_level: 400 },
      { project_id: OTHER_PROJECT, user_id: 1, role_level: 400 },
    ],
  })
  await tdb.pg.query(
    `INSERT INTO users (id, username, email, password_hash) VALUES (1, 'alice', 'alice@x.com', 'h')
     ON CONFLICT (id) DO NOTHING`,
  )
})

/** Write a settings row so the project has a non-zero version to read back. */
async function seedSettings(version: number, settings: Record<string, unknown>) {
  await tdb.pg.query(
    `INSERT INTO project_settings (project_id, settings, version, updated_by)
     VALUES ($1, $2, $3, 1)`,
    [PROJECT, JSON.stringify(settings), version],
  )
}

describe('GET /api/v1/external/projects/:projectId', () => {
  it('returns the project plus its settings blob and live settings version', async () => {
    await seedSettings(7, { targetLanes: ['es', 'pt'] })
    const token = await seedCredential(tdb, CRED_UNSCOPED)

    const res = await handleExternalReadRequest(
      get(`/api/v1/external/projects/${PROJECT}`, token),
      makeEnv(tdb.db),
    )

    expect(res).not.toBeNull()
    expect(res!.status).toBe(200)
    const body = (await res!.json()) as Record<string, unknown>
    expect(body.id).toBe(PROJECT)
    expect(body.name).toBe('Project A')
    expect(body.archived).toBe(false)
    expect(body.role).toBe(400)
    // The number PatchSettings.ifMatchVersion has to match — the whole point.
    expect(body.settingsVersion).toBe(7)
    expect(body.settings).toMatchObject({ targetLanes: ['es', 'pt'] })
  })

  it('reports version 0 for a project that has never had settings written', async () => {
    const token = await seedCredential(tdb, CRED_UNSCOPED)
    const res = await handleExternalReadRequest(
      get(`/api/v1/external/projects/${PROJECT}`, token),
      makeEnv(tdb.db),
    )
    const body = (await res!.json()) as Record<string, unknown>
    expect(body.settingsVersion).toBe(0)
    expect(body.settings).toEqual({})
  })

  it('does not shadow the deeper project routes', async () => {
    const token = await seedCredential(tdb, CRED_UNSCOPED)
    const res = await handleExternalReadRequest(
      get(`/api/v1/external/projects/${PROJECT}/files`, token),
      makeEnv(tdb.db),
    )
    expect(res!.status).toBe(200)
    const body = (await res!.json()) as Record<string, unknown>
    // The files route's envelope, not the project-detail one.
    expect(body).toHaveProperty('data')
    expect(body).not.toHaveProperty('settingsVersion')
  })

  it('a wrong-project credential gets scope_denied, not the project', async () => {
    const token = await seedCredential(tdb, CRED_OTHER_PROJECT, { projectId: OTHER_PROJECT })
    const res = await handleExternalReadRequest(
      get(`/api/v1/external/projects/${PROJECT}`, token),
      makeEnv(tdb.db),
    )
    expect(res!.status).toBe(403)
    const body = (await res!.json()) as { error: { code: string } }
    expect(body.error.code).toBe('scope_denied')
  })

  it('an unknown project id is not_found, and a missing token is 401', async () => {
    const token = await seedCredential(tdb, CRED_UNSCOPED)
    const missing = await handleExternalReadRequest(
      get('/api/v1/external/projects/no-such-project', token),
      makeEnv(tdb.db),
    )
    expect(missing!.status).toBe(404)
    expect(((await missing!.json()) as { error: { code: string } }).error.code).toBe('not_found')

    const anon = await handleExternalReadRequest(
      get(`/api/v1/external/projects/${PROJECT}`),
      makeEnv(tdb.db),
    )
    expect(anon!.status).toBe(401)
  })
})

describe('MCP get_project', () => {
  it('carries the same settings/version fields as the REST route', async () => {
    await seedSettings(3, { targetLanes: ['fr'] })
    const token = await seedCredential(tdb, CRED_UNSCOPED)
    const env = makeEnv(tdb.db)
    const cred = await validateApiCredential(tdb.db, token)

    const result = await callTool('get_project', { projectId: PROJECT }, env, cred!, token)
    expect(result).not.toBe(Symbol.for('unknown-tool'))
    const mcpPayload = JSON.parse(
      (result as { content: { text: string }[] }).content[0].text,
    ) as Record<string, unknown>

    const restRes = await handleExternalReadRequest(
      get(`/api/v1/external/projects/${PROJECT}`, token),
      env,
    )
    const restPayload = (await restRes!.json()) as Record<string, unknown>

    expect(mcpPayload.settingsVersion).toBe(3)
    // The two adapters serve one shared read — they must not drift.
    expect(mcpPayload).toEqual(restPayload)
  })
})

describe('describe_command over MCP', () => {
  // One credential per test — several cases call the tool more than once, and
  // api_credentials.id is a primary key.
  let token: string
  beforeEach(async () => {
    token = await seedCredential(tdb, CRED_UNSCOPED)
  })

  async function describe_(args: Record<string, unknown>) {
    const cred = await validateApiCredential(tdb.db, token)
    const result = await callTool('describe_command', args, makeEnv(tdb.db), cred!, token)
    const tool = result as { content: { text: string }[]; isError?: boolean }
    return { payload: JSON.parse(tool.content[0].text) as Record<string, unknown>, isError: tool.isError === true }
  }

  it('is a registered tool that returns a command’s full params doc', async () => {
    const { payload, isError } = await describe_({ kind: 'PatchSettings' })
    expect(isError).toBe(false)
    expect(payload.kind).toBe('PatchSettings')
    expect(payload.minRoleLevel).toBe(500)
    expect(String(payload.paramsDoc)).toContain('ifMatchVersion')
  })

  it('returns the index when no kind is given', async () => {
    const { payload } = await describe_({})
    const kinds = (payload.commands as { kind: string }[]).map((c) => c.kind)
    expect(kinds).toEqual(COMMAND_CATALOG.filter((c) => c.agentReachable).map((c) => c.kind))
  })

  it('rejects an unknown kind with the valid ones', async () => {
    const { payload, isError } = await describe_({ kind: 'NoSuchCommand' })
    expect(isError).toBe(true)
    const error = payload.error as { code: string; details: { availableKinds: string[] } }
    expect(error.code).toBe('not_found')
    expect(error.details.availableKinds).toContain('SetTranslation')
  })

  it('describes every catalogued agent-reachable command', async () => {
    for (const entry of COMMAND_CATALOG.filter((c) => c.agentReachable)) {
      const { payload, isError } = await describe_({ kind: entry.kind })
      expect(isError).toBe(false)
      expect(payload.paramsDoc).toBe(entry.paramsDoc)
    }
  })
})

describe('describe_command over REST', () => {
  it('serves the index and one command’s doc without a credential', async () => {
    const index = handleExternalCommandsDocRequest(get('/api/v1/external/commands'))
    expect(index!.status).toBe(200)
    const indexBody = (await index!.json()) as { data: { kind: string }[] }
    expect(indexBody.data.map((c) => c.kind)).toContain('PatchSettings')

    const detail = handleExternalCommandsDocRequest(get('/api/v1/external/commands/PatchSettings'))
    expect(detail!.status).toBe(200)
    const detailBody = (await detail!.json()) as { kind: string; paramsDoc: string }
    expect(detailBody.kind).toBe('PatchSettings')
    expect(detailBody.paramsDoc).toContain('ifMatchVersion')
  })

  it('404s an unknown kind and 405s a non-GET; ignores unrelated paths', async () => {
    const unknown = handleExternalCommandsDocRequest(get('/api/v1/external/commands/Nope'))
    expect(unknown!.status).toBe(404)

    const posted = handleExternalCommandsDocRequest(
      new Request('https://w/api/v1/external/commands', { method: 'POST' }),
    )
    expect(posted!.status).toBe(405)

    expect(handleExternalCommandsDocRequest(get('/api/v1/external/projects'))).toBeNull()
  })
})

describe('the API map’s docs link', () => {
  it('no longer points at the private GitHub repo', () => {
    expect(DOCS_URL).not.toContain('github.com')
  })

  it('resolves, unauthenticated, to readable docs', async () => {
    const map = handleExternalDiscoveryRequest(get('/api/v1/external'))
    const body = (await map!.json()) as { docs: string }
    expect(body.docs).toBe(DOCS_URL)

    // Follow the link exactly as a logged-out external caller would.
    const docs = handleExternalDiscoveryRequest(get(body.docs))
    expect(docs).not.toBeNull()
    expect(docs!.status).toBe(200)
    expect(docs!.headers.get('Content-Type')).toContain('text/markdown')
    const text = await docs!.text()
    expect(text).toContain('# Aquilla Agent API')
    expect(text).toContain('/api/v1/external/projects/:projectId')
  })

  it('advertises the new read routes in the map', async () => {
    const map = handleExternalDiscoveryRequest(get('/api/v1/external'))
    const body = (await map!.json()) as { endpoints: Record<string, string> }
    expect(Object.keys(body.endpoints)).toContain('GET /api/v1/external/projects/:projectId')
    expect(Object.keys(body.endpoints)).toContain('GET /api/v1/external/commands/:kind')
  })
})

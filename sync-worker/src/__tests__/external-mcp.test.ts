// Tests for the Agent API remote MCP server (AQU-533 §4).
//
// Drives the JSON-RPC transport directly (handleExternalMcpRequest): initialize
// handshake, tools/list catalog, tools/call for a direct read
// (get_identity_and_scope), a search + read_content round trip through the
// delegated read tier, the prepare_translations -> confirm_changeset happy path
// (act mode) landing real events, ask-mode confirmation_required, and the
// transport-level failures (bad credential -> 401, unknown tool + unknown method
// -> JSON-RPC errors).

import { describe, it, expect, beforeEach, vi } from 'vitest'

// commit path: mcp-handlers -> changesets-route -> commit.ts -> events/route ->
// broadcast.ts -> partyserver (cloudflare:*). Stub it as the changeset suite does.
vi.mock('partyserver', () => ({
  getServerByName: vi.fn().mockResolvedValue({
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  }),
}))

import { handleExternalMcpRequest } from '../external/mcp-route'
import { MCP_TOOLS } from '../external/mcp-tools'
import { PLAN_IMPORT_MAX_CELLS } from '../external/commands'
import { MAX_ARTIFACT_BYTES } from '../external/artifacts-route'
import { mintApiToken } from '../../../db/shared/api-credentials'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'

const SECRET = 'test-secret'
const PROJECT = 'proj-a'
const FILE = 'file-x'
const CRED_1 = '00000000-0000-0000-0000-000000000001'

function makeEnv(db: AquillaDb) {
  return { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET, BASE_URL: 'https://aquilla.app' }
}

async function credToken(
  tdb: TestDb,
  opts: { userId: number; username: string; mode?: 'ask' | 'act'; projectId?: string | null } = {
    userId: 1,
    username: 'alice',
  },
): Promise<string> {
  await tdb.pg.query(
    `INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, 'h')
     ON CONFLICT (id) DO NOTHING`,
    [opts.userId, opts.username, `${opts.username}@x.com`],
  )
  const { token, tokenHash, tokenPrefix } = await mintApiToken()
  await tdb.pg.query(
    `INSERT INTO api_credentials (id, user_id, name, token_prefix, token_hash, mode, org_id, project_id)
     VALUES ($1, $2, 'test', $3, $4, $5, NULL, $6)`,
    [
      CRED_1,
      String(opts.userId),
      tokenPrefix,
      tokenHash,
      opts.mode ?? 'act',
      opts.projectId === undefined ? PROJECT : opts.projectId,
    ],
  )
  return token
}

async function seed(): Promise<TestDb> {
  const tdb = await makeTestDb({
    projects: [{ id: PROJECT, name: 'Project A', created_by: 99, org_id: null }],
    project_members: [{ project_id: PROJECT, user_id: 1, role_level: 400 }],
    files: [{ id: FILE, project_id: PROJECT, name: 'Genesis', event_id: 'evt-file-1' }],
    cells: [
      {
        project_id: PROJECT, file_id: FILE, cell_id: 'cell-1', side: 'source',
        value: 'In the beginning', event_id: 'src-evt-1', last_edit_at: 1, word_count: 3,
      },
    ],
  })
  return tdb
}

/** POST a JSON-RPC message to the MCP endpoint. */
async function rpc(
  env: ReturnType<typeof makeEnv>,
  token: string | null,
  message: unknown,
): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token !== null) headers['Authorization'] = `Bearer ${token}`
  const res = await handleExternalMcpRequest(
    new Request('https://w/api/v1/external/mcp', {
      method: 'POST',
      headers,
      body: JSON.stringify(message),
    }),
    env,
  )
  return res!
}

/** Parse a tools/call result's single text content block. */
function toolPayload(result: { content: { text: string }[]; isError?: boolean }): {
  payload: unknown
  isError: boolean
} {
  return { payload: JSON.parse(result.content[0].text), isError: result.isError === true }
}

let tdb: TestDb
beforeEach(async () => {
  tdb = await seed()
})

describe('MCP transport', () => {
  it('initialize returns protocol, capabilities, and serverInfo', async () => {
    const env = makeEnv(tdb.db)
    const token = await credToken(tdb)
    const res = await rpc(env, token, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '1' } },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.jsonrpc).toBe('2.0')
    expect(body.id).toBe(1)
    expect(body.result.protocolVersion).toBe('2025-06-18')
    expect(body.result.capabilities).toEqual({ tools: {} })
    expect(body.result.serverInfo).toEqual({ name: 'aquilla', version: '0.1.0' })
  })

  it('initialize pins the default protocol version for an unknown client version', async () => {
    const env = makeEnv(tdb.db)
    const token = await credToken(tdb)
    const res = await rpc(env, token, {
      jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' },
    })
    const body = (await res.json()) as any
    expect(body.result.protocolVersion).toBe('2025-06-18')
  })

  it('notifications/initialized acks with 202 and no body', async () => {
    const env = makeEnv(tdb.db)
    const token = await credToken(tdb)
    const res = await rpc(env, token, { jsonrpc: '2.0', method: 'notifications/initialized' })
    expect(res.status).toBe(202)
    expect(await res.text()).toBe('')
  })

  it('ping returns an empty result', async () => {
    const env = makeEnv(tdb.db)
    const token = await credToken(tdb)
    const res = await rpc(env, token, { jsonrpc: '2.0', id: 7, method: 'ping' })
    const body = (await res.json()) as any
    expect(body.result).toEqual({})
  })

  it('GET is 405', async () => {
    const env = makeEnv(tdb.db)
    const res = await handleExternalMcpRequest(
      new Request('https://w/api/v1/external/mcp', { method: 'GET' }),
      env,
    )
    expect(res!.status).toBe(405)
  })

  it('missing/invalid credential -> HTTP 401 with the errors.ts envelope', async () => {
    const env = makeEnv(tdb.db)
    const noAuth = await rpc(env, null, { jsonrpc: '2.0', id: 1, method: 'ping' })
    expect(noAuth.status).toBe(401)
    expect(((await noAuth.json()) as any).error.code).toBe('permission_denied')

    const badKey = await rpc(env, 'aqk_not-a-real-key', { jsonrpc: '2.0', id: 1, method: 'ping' })
    expect(badKey.status).toBe(401)
    expect(((await badKey.json()) as any).error.code).toBe('permission_denied')
  })

  it('unknown method -> JSON-RPC -32601', async () => {
    const env = makeEnv(tdb.db)
    const token = await credToken(tdb)
    const res = await rpc(env, token, { jsonrpc: '2.0', id: 3, method: 'does/not/exist' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.error.code).toBe(-32601)
    expect(body.id).toBe(3)
  })

  it('unknown tool -> JSON-RPC error', async () => {
    const env = makeEnv(tdb.db)
    const token = await credToken(tdb)
    const res = await rpc(env, token, {
      jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope', arguments: {} },
    })
    const body = (await res.json()) as any
    expect(body.error).toBeDefined()
    expect(body.error.code).toBe(-32602)
  })
})

describe('MCP tools/list', () => {
  it('returns all 28 tools each with an input schema', async () => {
    const env = makeEnv(tdb.db)
    const token = await credToken(tdb)
    const res = await rpc(env, token, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
    const body = (await res.json()) as any
    const names = body.result.tools.map((t: any) => t.name).sort()
    expect(names).toEqual(
      [
        'confirm_changeset', 'describe_command', 'discard_changeset', 'export_file',
        'find_similar_cells', 'get_capabilities', 'get_changeset', 'get_identity_and_scope',
        'get_project', 'get_project_settings', 'get_prompt_preview',
        // AQU-1294 skills.
        'get_skill',
        'list_changesets',
        'list_memory', 'list_orgs', 'list_projects', 'patch_settings', 'prepare_import',
        'prepare_translations', 'preview_import', 'read_cell_memory', 'read_comments',
        'read_content', 'read_history',
        // AQU-1231 quality reads.
        'read_quality', 'read_term_consistency',
        'search_project', 'search_projects', 'wait_for_changeset',
      ].sort(),
    )
    expect(body.result.tools).toHaveLength(28)
    for (const tool of body.result.tools) {
      expect(typeof tool.description).toBe('string')
      expect(tool.description.length).toBeGreaterThan(20)
      expect(tool.inputSchema.type).toBe('object')
    }
    // The catalog module and the wire list agree.
    expect(body.result.tools).toHaveLength(MCP_TOOLS.length)
  })
})

describe('MCP tools/call — reads', () => {
  it('get_identity_and_scope reflects the credential', async () => {
    const env = makeEnv(tdb.db)
    const token = await credToken(tdb)
    const res = await rpc(env, token, {
      jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { name: 'get_identity_and_scope', arguments: {} },
    })
    const { payload, isError } = toolPayload(((await res.json()) as any).result)
    expect(isError).toBe(false)
    // AQU-1180: the MCP adapter and REST /me must agree about what a token is
    // allowed to learn — scope and autonomy yes, the human behind it no.
    expect(payload).toMatchObject({
      mode: 'act', orgId: null, projectId: PROJECT, credentialId: CRED_1,
    })
    expect(payload).not.toHaveProperty('userId')
    expect(payload).not.toHaveProperty('username')
  })

  it('get_capabilities publishes real limits and error codes', async () => {
    const env = makeEnv(tdb.db)
    const token = await credToken(tdb)
    const res = await rpc(env, token, {
      jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { name: 'get_capabilities', arguments: {} },
    })
    const { payload } = toolPayload(((await res.json()) as any).result)
    const p = payload as any
    expect(p.credentialMode).toBe('act')
    // All six domain command kinds are now reported (Agent API v1.1 + AQU-1221).
    // This field is frozen — newer kinds land in commands.index and the
    // legacy five-kind list moved to commandKindsLegacy (see command-catalog.test).
    expect(p.commandKinds).toEqual(
      ['SetTranslation', 'PlanImport', 'CreateOrg', 'CreateProject', 'UpdateProjectSettings', 'LinkMedia'],
    )
    expect(p.limits.changesetExpirySeconds).toBe(3600) // CHANGESET_TTL_MS / 1000
    // Every number is imported from its owning module — no invented values.
    expect(p.limits.planImportMaxCells).toBe(PLAN_IMPORT_MAX_CELLS)
    expect(p.limits.maxArtifactBytes).toBe(MAX_ARTIFACT_BYTES)
    // PlanImport is truthfully reported as REST-only (no MCP staging tool yet).
    expect(p.planImport.stagingChannels).toEqual(['rest', 'mcp'])
    expect(p.planImport.mcpStagingTool).toBe('prepare_import')
    expect(p.planImport.maxCellsPerChangeset).toBe(PLAN_IMPORT_MAX_CELLS)
    // CreateProject/UpdateProjectSettings/LinkMedia stage via the SAME MCP
    // tools as SetTranslation — advertised, not a separate tool.
    expect(p.projectLifecycle.mcpStagingTool).toBe('prepare_translations')
    expect(p.projectLifecycle.commitTool).toBe('confirm_changeset')
    // AQU-538: multi-target-language lanes are self-described — an agent can
    // learn the register → write-per-lane → read-per-lane workflow from here.
    expect(p.multiLanguage.note).toContain('targetLanes')
    expect(p.multiLanguage.workflow.join(' ')).toContain('laneId')
    expect(p.linkMedia.mcpStagingTool).toBe('prepare_translations')
    expect(p.linkMedia.commitTool).toBe('confirm_changeset')
    expect(p.errorCodes).toContain('confirmation_required')
    expect(p.errorCodes).toContain('conflict')
  })

  it('list_projects returns accessible projects', async () => {
    const env = makeEnv(tdb.db)
    const token = await credToken(tdb)
    const res = await rpc(env, token, {
      jsonrpc: '2.0', id: 6, method: 'tools/call',
      params: { name: 'list_projects', arguments: {} },
    })
    const { payload } = toolPayload(((await res.json()) as any).result)
    const projects = (payload as any).projects
    expect(projects).toHaveLength(1)
    expect(projects[0]).toMatchObject({ id: PROJECT, name: 'Project A', role_source: 'member' })
  })

  // AQU-1229: the memory tools are thin MCP mirrors of the REST reads (whose
  // own behavior is covered in external-memory-reads.test.ts). What is only
  // testable here is that the two names actually dispatch — a tool listed in
  // the catalog but missing from the switch returns "unknown tool" at runtime
  // while looking perfectly documented in tools/list.
  it('list_memory and read_cell_memory dispatch through MCP', async () => {
    const env = makeEnv(tdb.db)
    const token = await credToken(tdb)
    await tdb.pg.query(
      `INSERT INTO agent_memories (id, project_id, path, content, status)
       VALUES ('99999999-9999-4999-8999-999999999999', $1, 'decisions/divine-name.md',
               'Render Lord as Господь.', 'approved')`,
      [PROJECT],
    )

    const listRes = await rpc(env, token, {
      jsonrpc: '2.0', id: 40, method: 'tools/call',
      params: { name: 'list_memory', arguments: { projectId: PROJECT } },
    })
    const list = toolPayload(((await listRes.json()) as any).result)
    expect(list.isError).toBe(false)
    expect((list.payload as any).data[0]).toMatchObject({
      path: 'decisions/divine-name.md',
      kind: 'decision',
      status: 'approved',
      inRetrieval: true,
    })

    const cellRes = await rpc(env, token, {
      jsonrpc: '2.0', id: 41, method: 'tools/call',
      params: { name: 'read_cell_memory', arguments: { projectId: PROJECT, fileId: FILE, cellId: 'cell-1' } },
    })
    const cell = toolPayload(((await cellRes.json()) as any).result)
    expect(cell.isError).toBe(false)
    expect((cell.payload as any).retrieval.scope).toBe('project')
    expect((cell.payload as any).entries.map((e: { path: string }) => e.path)).toEqual([
      'decisions/divine-name.md',
    ])
  })

  it('read_cell_memory requires fileId', async () => {
    const env = makeEnv(tdb.db)
    const token = await credToken(tdb)
    const res = await rpc(env, token, {
      jsonrpc: '2.0', id: 42, method: 'tools/call',
      params: { name: 'read_cell_memory', arguments: { projectId: PROJECT, cellId: 'cell-1' } },
    })
    const { payload, isError } = toolPayload(((await res.json()) as any).result)
    expect(isError).toBe(true)
    expect(JSON.stringify(payload)).toContain('fileId is required')
  })

  // AQU-1232: the tool is pure argument marshalling over the REST route, so
  // what needs proving here is that the delegation actually reaches it — a
  // typo'd path would surface as a not_found tool error, not a compile failure.
  it('find_similar_cells delegates to the similarity route', async () => {
    const env = makeEnv(tdb.db)
    const token = await credToken(tdb)
    // Give cell-1 a target and add a near-duplicate so there is a precedent.
    await tdb.pg.query(
      `INSERT INTO cells (project_id, file_id, cell_id, side, value, event_id, last_edit_at, word_count)
       VALUES ($1, $2, 'cell-2', 'source', 'In the beginning God', 'src-evt-2', 1, 4),
              ($1, $2, 'cell-2', 'target', 'Au commencement Dieu', 'tgt-evt-2', 1, 3)`,
      [PROJECT, FILE],
    )

    const res = await rpc(env, token, {
      jsonrpc: '2.0', id: 20, method: 'tools/call',
      params: { name: 'find_similar_cells', arguments: { projectId: PROJECT, cellId: 'cell-1' } },
    })
    const { payload, isError } = toolPayload(((await res.json()) as any).result)
    expect(isError).toBe(false)
    expect((payload as any).data).toHaveLength(1)
    expect((payload as any).data[0]).toMatchObject({
      cellId: 'cell-2',
      targetValue: 'Au commencement Dieu',
    })

    // Argument validation happens in the tool, before any delegation.
    const bad = await rpc(env, token, {
      jsonrpc: '2.0', id: 21, method: 'tools/call',
      params: { name: 'find_similar_cells', arguments: { projectId: PROJECT } },
    })
    expect(toolPayload(((await bad.json()) as any).result).isError).toBe(true)
  })

  it('search_project + read_content round trip', async () => {
    const env = makeEnv(tdb.db)
    const token = await credToken(tdb)

    const searchRes = await rpc(env, token, {
      jsonrpc: '2.0', id: 8, method: 'tools/call',
      params: { name: 'search_project', arguments: { projectId: PROJECT, q: 'beginning' } },
    })
    const search = toolPayload(((await searchRes.json()) as any).result)
    expect(search.isError).toBe(false)
    expect((search.payload as any).data.length).toBeGreaterThan(0)

    // read_content with no fileId -> list files.
    const filesRes = await rpc(env, token, {
      jsonrpc: '2.0', id: 9, method: 'tools/call',
      params: { name: 'read_content', arguments: { projectId: PROJECT } },
    })
    const files = toolPayload(((await filesRes.json()) as any).result)
    expect((files.payload as any).data).toHaveLength(1)
    expect((files.payload as any).data[0].fileId).toBe(FILE)

    // read_content with fileId -> read cells.
    const cellsRes = await rpc(env, token, {
      jsonrpc: '2.0', id: 10, method: 'tools/call',
      params: { name: 'read_content', arguments: { projectId: PROJECT, fileId: FILE } },
    })
    const cells = toolPayload(((await cellsRes.json()) as any).result)
    expect((cells.payload as any).data.length).toBeGreaterThan(0)
    expect((cells.payload as any).data[0].cellId).toBe('cell-1')
  })

  it('read_quality and read_term_consistency reach the quality router (AQU-1231)', async () => {
    const env = makeEnv(tdb.db)
    const token = await credToken(tdb)

    const qualityRes = await rpc(env, token, {
      jsonrpc: '2.0', id: 20, method: 'tools/call',
      params: { name: 'read_quality', arguments: { projectId: PROJECT, fileId: FILE } },
    })
    const quality = toolPayload(((await qualityRes.json()) as any).result)
    expect(quality.isError).toBe(false)
    expect((quality.payload as any).projectId).toBe(PROJECT)
    expect((quality.payload as any).data[0].fileId).toBe(FILE)
    expect(typeof (quality.payload as any).data[0].coverage.totalCells).toBe('number')

    const termsRes = await rpc(env, token, {
      jsonrpc: '2.0', id: 21, method: 'tools/call',
      params: { name: 'read_term_consistency', arguments: { projectId: PROJECT, onlyDrift: true } },
    })
    const terms = toolPayload(((await termsRes.json()) as any).result)
    expect(terms.isError).toBe(false)
    expect((terms.payload as any).onlyDrift).toBe(true)
    // No termbase seeded in this suite — the scan runs and finds nothing.
    expect((terms.payload as any).data).toEqual([])
  })

  it('a tool argument error is an isError tool result, not a transport error', async () => {
    const env = makeEnv(tdb.db)
    const token = await credToken(tdb)
    const res = await rpc(env, token, {
      jsonrpc: '2.0', id: 11, method: 'tools/call',
      params: { name: 'search_project', arguments: { projectId: PROJECT } }, // missing q
    })
    const body = (await res.json()) as any
    expect(body.error).toBeUndefined() // NOT a JSON-RPC error
    const { payload, isError } = toolPayload(body.result)
    expect(isError).toBe(true)
    expect((payload as any).error.code).toBe('validation_failed')
  })
})

// AQU-1176: settings became readable over MCP, PatchSettings got a real tool,
// and describe_command stopped being a capabilities promise with no
// implementation behind it.
describe('MCP tools/call — settings + command discovery', () => {
  /** Give the seeded user MAINTAINER (600) — the floor PatchSettings needs for
   *  a non-terminology key. */
  async function promoteToMaintainer() {
    await tdb.pg.query(`UPDATE project_members SET role_level = 600 WHERE project_id = $1 AND user_id = 1`, [
      PROJECT,
    ])
  }

  async function seedSettings(settings: Record<string, unknown>, version: number) {
    await tdb.pg.query(
      `INSERT INTO project_settings (project_id, settings, version, updated_by, updated_at)
       VALUES ($1, $2, $3, 1, '2026-01-01T00:00:00.000Z')`,
      [PROJECT, JSON.stringify(settings), version],
    )
  }

  it('get_project_settings returns the blob and its live version', async () => {
    await seedSettings({ targetLanguage: 'fr', brief: 'Keep it plain.' }, 4)
    const env = makeEnv(tdb.db)
    const token = await credToken(tdb)
    const res = await rpc(env, token, {
      jsonrpc: '2.0', id: 40, method: 'tools/call',
      params: { name: 'get_project_settings', arguments: { projectId: PROJECT } },
    })
    const { payload, isError } = toolPayload(((await res.json()) as any).result)
    expect(isError).toBe(false)
    expect((payload as any).version).toBe(4)
    expect((payload as any).settings.targetLanguage).toBe('fr')
  })

  it('get_project_settings on a project outside the credential scope is denied', async () => {
    const env = makeEnv(tdb.db)
    const token = await credToken(tdb)
    const res = await rpc(env, token, {
      jsonrpc: '2.0', id: 41, method: 'tools/call',
      params: { name: 'get_project_settings', arguments: { projectId: 'some-other-project' } },
    })
    const { payload, isError } = toolPayload(((await res.json()) as any).result)
    expect(isError).toBe(true)
    expect(['scope_denied', 'not_found']).toContain((payload as any).error.code)
  })

  it('describe_command returns a real parameter doc for PatchSettings, SetTranslation and LinkMedia', async () => {
    const env = makeEnv(tdb.db)
    const token = await credToken(tdb)
    for (const kind of ['PatchSettings', 'SetTranslation', 'LinkMedia']) {
      const res = await rpc(env, token, {
        jsonrpc: '2.0', id: 42, method: 'tools/call',
        params: { name: 'describe_command', arguments: { kind } },
      })
      const { payload, isError } = toolPayload(((await res.json()) as any).result)
      expect(isError, kind).toBe(false)
      expect((payload as any).kind).toBe(kind)
      expect((payload as any).paramsDoc, kind).toContain('Params:')
      expect(typeof (payload as any).minRoleLevel).toBe('number')
    }
  })

  it('describe_command omits kind and returns the index of every command', async () => {
    const env = makeEnv(tdb.db)
    const token = await credToken(tdb)
    const res = await rpc(env, token, {
      jsonrpc: '2.0', id: 43, method: 'tools/call',
      params: { name: 'describe_command', arguments: {} },
    })
    const { payload, isError } = toolPayload(((await res.json()) as any).result)
    expect(isError).toBe(false)
    expect(Array.isArray((payload as any).commands)).toBe(true)
    expect((payload as any).commands.length).toBeGreaterThan(0)
    expect((payload as any).commands[0]).toHaveProperty('kind')
  })

  it('describe_command names the valid kinds for an unknown one', async () => {
    const env = makeEnv(tdb.db)
    const token = await credToken(tdb)
    const res = await rpc(env, token, {
      jsonrpc: '2.0', id: 43, method: 'tools/call',
      params: { name: 'describe_command', arguments: { kind: 'MakeCoffee' } },
    })
    const { payload, isError } = toolPayload(((await res.json()) as any).result)
    expect(isError).toBe(true)
    expect((payload as any).error.code).toBe('not_found')
    expect((payload as any).error.details.availableKinds).toContain('PatchSettings')
  })

  it('every command get_capabilities advertises is describable (no dangling promises)', async () => {
    const env = makeEnv(tdb.db)
    const token = await credToken(tdb)
    const capRes = await rpc(env, token, {
      jsonrpc: '2.0', id: 44, method: 'tools/call',
      params: { name: 'get_capabilities', arguments: {} },
    })
    const caps = toolPayload(((await capRes.json()) as any).result).payload as any
    expect(caps.commands.index.length).toBeGreaterThan(0)
    for (const entry of caps.commands.index) {
      const res = await rpc(env, token, {
        jsonrpc: '2.0', id: 45, method: 'tools/call',
        params: { name: 'describe_command', arguments: { kind: entry.kind } },
      })
      const { isError } = toolPayload(((await res.json()) as any).result)
      expect(isError, entry.kind).toBe(false)
    }
  })

  it('patch_settings stages a single-key change and commit leaves the other keys byte-identical', async () => {
    await promoteToMaintainer()
    await seedSettings({ targetLanguage: 'fr', targetLanes: ['fr'], systemPrompt: 'old' }, 1)
    const env = makeEnv(tdb.db)
    const token = await credToken(tdb)

    const stageRes = await rpc(env, token, {
      jsonrpc: '2.0', id: 46, method: 'tools/call',
      params: {
        name: 'patch_settings',
        arguments: {
          projectId: PROJECT,
          ops: [{ key: 'systemPrompt', value: 'new' }],
          ifMatchVersion: 1,
        },
      },
    })
    const staged = toolPayload(((await stageRes.json()) as any).result)
    expect(staged.isError).toBe(false)
    const { changesetId, digest } = staged.payload as { changesetId: string; digest: string }

    const commitRes = await rpc(env, token, {
      jsonrpc: '2.0', id: 47, method: 'tools/call',
      params: { name: 'confirm_changeset', arguments: { projectId: PROJECT, changesetId, digest } },
    })
    expect(toolPayload(((await commitRes.json()) as any).result).isError).toBe(false)

    const rows = await tdb.rows<{ settings: string; version: number }>('project_settings')
    const stored = JSON.parse(rows[0].settings)
    expect(stored.systemPrompt).toBe('new')
    expect(stored.targetLanguage).toBe('fr')
    expect(stored.targetLanes).toEqual(['fr'])
    expect(rows[0].version).toBe(2)
  })

  it('patch_settings with a stale ifMatchVersion is rejected and applies nothing', async () => {
    await promoteToMaintainer()
    await seedSettings({ systemPrompt: 'old' }, 1)
    const env = makeEnv(tdb.db)
    const token = await credToken(tdb)
    const res = await rpc(env, token, {
      jsonrpc: '2.0', id: 48, method: 'tools/call',
      params: {
        name: 'patch_settings',
        arguments: { projectId: PROJECT, ops: [{ key: 'systemPrompt', value: 'new' }], ifMatchVersion: 99 },
      },
    })
    const { payload, isError } = toolPayload(((await res.json()) as any).result)
    expect(isError).toBe(true)
    expect((payload as any).error.code).toBe('plan_stale')
    const rows = await tdb.rows<{ settings: string }>('project_settings')
    expect(JSON.parse(rows[0].settings).systemPrompt).toBe('old')
  })

  it('patch_settings rejects a LOOSENING policy write at prepare (agent cannot loosen its own gates)', async () => {
    await promoteToMaintainer()
    await seedSettings({ systemPrompt: 'old', validationCount: 3 }, 1)
    const env = makeEnv(tdb.db)
    const token = await credToken(tdb)
    const res = await rpc(env, token, {
      jsonrpc: '2.0', id: 49, method: 'tools/call',
      params: {
        name: 'patch_settings',
        arguments: {
          projectId: PROJECT,
          ops: [{ key: 'validationCount', value: 1 }],
          ifMatchVersion: 1,
        },
      },
    })
    const { payload, isError } = toolPayload(((await res.json()) as any).result)
    expect(isError).toBe(true)
    expect((payload as any).error.code).toBe('permission_denied')
    expect((payload as any).error.details.loosening[0].key).toBe('validationCount')
  })

  it('patch_settings accepts a TIGHTENING policy write and confirm lands it (AQU-1282 §1)', async () => {
    await promoteToMaintainer()
    await seedSettings({ systemPrompt: 'old', validationCount: 3 }, 1)
    const env = makeEnv(tdb.db)
    const token = await credToken(tdb)
    const stageRes = await rpc(env, token, {
      jsonrpc: '2.0', id: 52, method: 'tools/call',
      params: {
        name: 'patch_settings',
        arguments: {
          projectId: PROJECT,
          ops: [{ key: 'validationCount', value: 5 }],
          ifMatchVersion: 1,
        },
      },
    })
    const staged = toolPayload(((await stageRes.json()) as any).result)
    expect(staged.isError, JSON.stringify(staged.payload)).toBe(false)
    const { changesetId, digest } = staged.payload as { changesetId: string; digest: string }

    const commitRes = await rpc(env, token, {
      jsonrpc: '2.0', id: 53, method: 'tools/call',
      params: { name: 'confirm_changeset', arguments: { projectId: PROJECT, changesetId, digest } },
    })
    expect(toolPayload(((await commitRes.json()) as any).result).isError).toBe(false)

    const rows = await tdb.rows<{ settings: string; version: number }>('project_settings')
    expect(JSON.parse(rows[0].settings).validationCount).toBe(5)
    expect(rows[0].version).toBe(2)
  })

  it('patch_settings requires ops and a numeric ifMatchVersion', async () => {
    const env = makeEnv(tdb.db)
    const token = await credToken(tdb)
    const noOps = await rpc(env, token, {
      jsonrpc: '2.0', id: 50, method: 'tools/call',
      params: { name: 'patch_settings', arguments: { projectId: PROJECT, ops: [], ifMatchVersion: 1 } },
    })
    expect(toolPayload(((await noOps.json()) as any).result).isError).toBe(true)

    const noVersion = await rpc(env, token, {
      jsonrpc: '2.0', id: 51, method: 'tools/call',
      params: { name: 'patch_settings', arguments: { projectId: PROJECT, ops: [{ key: 'systemPrompt', value: 'x' }] } },
    })
    const { payload, isError } = toolPayload(((await noVersion.json()) as any).result)
    expect(isError).toBe(true)
    expect((payload as any).error.message).toContain('get_project_settings')
  })
})

describe('MCP tools/call — changesets', () => {
  it('prepare_translations -> confirm_changeset (act mode) lands events', async () => {
    const env = makeEnv(tdb.db)
    const token = await credToken(tdb)

    const prepRes = await rpc(env, token, {
      jsonrpc: '2.0', id: 12, method: 'tools/call',
      params: {
        name: 'prepare_translations',
        arguments: {
          projectId: PROJECT,
          translations: [{ cellId: 'cell-1', fileId: FILE, value: 'Au commencement' }],
        },
      },
    })
    const prep = toolPayload(((await prepRes.json()) as any).result)
    expect(prep.isError).toBe(false)
    const prepPayload = prep.payload as any
    expect(prepPayload.mode).toBe('act')
    expect(prepPayload.digest).toMatch(/^[0-9a-f]{64}$/)
    expect((prepPayload.summary as any).translationsAdded).toBe(1)

    const confirmRes = await rpc(env, token, {
      jsonrpc: '2.0', id: 13, method: 'tools/call',
      params: {
        name: 'confirm_changeset',
        arguments: { projectId: PROJECT, changesetId: prepPayload.changesetId, digest: prepPayload.digest },
      },
    })
    const confirm = toolPayload(((await confirmRes.json()) as any).result)
    expect(confirm.isError).toBe(false)
    expect((confirm.payload as any).receipt.appliedCount).toBe(1)

    // A real target.cell.commit event landed with the credential owner as author.
    const events = await tdb.rows<{ kind: string; author: string }>('events')
    const commit = events.find((e) => e.kind === 'target.cell.commit')
    expect(commit).toBeDefined()
    expect(commit!.author).toBe('alice')

    // Projection updated.
    const target = (await tdb.rows<{ side: string; value: string }>('cells')).find((c) => c.side === 'target')
    expect(target?.value).toBe('Au commencement')
  })

  it('confirm with a mismatched digest -> plan_stale (never commits)', async () => {
    const env = makeEnv(tdb.db)
    const token = await credToken(tdb)
    const prepRes = await rpc(env, token, {
      jsonrpc: '2.0', id: 14, method: 'tools/call',
      params: {
        name: 'prepare_translations',
        arguments: { projectId: PROJECT, translations: [{ cellId: 'cell-1', fileId: FILE, value: 'x' }] },
      },
    })
    const prepPayload = toolPayload(((await prepRes.json()) as any).result).payload as any

    const confirmRes = await rpc(env, token, {
      jsonrpc: '2.0', id: 15, method: 'tools/call',
      params: {
        name: 'confirm_changeset',
        arguments: { projectId: PROJECT, changesetId: prepPayload.changesetId, digest: 'deadbeef' },
      },
    })
    const confirm = toolPayload(((await confirmRes.json()) as any).result)
    expect(confirm.isError).toBe(true)
    expect((confirm.payload as any).error.code).toBe('plan_stale')
  })

  it('ask-mode confirm without approval -> confirmation_required with approvalUrl', async () => {
    const env = makeEnv(tdb.db)
    const token = await credToken(tdb, { userId: 1, username: 'alice', mode: 'ask' })

    const prepRes = await rpc(env, token, {
      jsonrpc: '2.0', id: 16, method: 'tools/call',
      params: {
        name: 'prepare_translations',
        arguments: { projectId: PROJECT, translations: [{ cellId: 'cell-1', fileId: FILE, value: 'x' }] },
      },
    })
    const prepPayload = toolPayload(((await prepRes.json()) as any).result).payload as any
    expect(prepPayload.mode).toBe('ask')
    expect(prepPayload.approvalUrl).toBe(`https://aquilla.app/approve/${prepPayload.changesetId}`)

    const confirmRes = await rpc(env, token, {
      jsonrpc: '2.0', id: 17, method: 'tools/call',
      params: {
        name: 'confirm_changeset',
        arguments: { projectId: PROJECT, changesetId: prepPayload.changesetId, digest: prepPayload.digest },
      },
    })
    const confirm = toolPayload(((await confirmRes.json()) as any).result)
    expect(confirm.isError).toBe(true)
    const err = (confirm.payload as any).error
    expect(err.code).toBe('confirmation_required')
    expect(err.approvalUrl).toBe(`https://aquilla.app/approve/${prepPayload.changesetId}`)

    // Nothing applied.
    const commits = (await tdb.rows('events')).filter((e: any) => e.kind === 'target.cell.commit')
    expect(commits).toHaveLength(0)
  })

  it('get_changeset then discard_changeset', async () => {
    const env = makeEnv(tdb.db)
    const token = await credToken(tdb)
    const prepRes = await rpc(env, token, {
      jsonrpc: '2.0', id: 18, method: 'tools/call',
      params: {
        name: 'prepare_translations',
        arguments: { projectId: PROJECT, translations: [{ cellId: 'cell-1', fileId: FILE, value: 'x' }] },
      },
    })
    const prepPayload = toolPayload(((await prepRes.json()) as any).result).payload as any

    const getRes = await rpc(env, token, {
      jsonrpc: '2.0', id: 19, method: 'tools/call',
      params: { name: 'get_changeset', arguments: { projectId: PROJECT, changesetId: prepPayload.changesetId } },
    })
    const got = toolPayload(((await getRes.json()) as any).result).payload as any
    expect(got.status).toBe('staged')
    expect(got.digest).toBe(prepPayload.digest)

    const discardRes = await rpc(env, token, {
      jsonrpc: '2.0', id: 20, method: 'tools/call',
      params: { name: 'discard_changeset', arguments: { projectId: PROJECT, changesetId: prepPayload.changesetId } },
    })
    const discarded = toolPayload(((await discardRes.json()) as any).result).payload as any
    expect(discarded.status).toBe('discarded')
  })

  // AQU-1177: the changeset lifecycle is reachable over MCP, not only REST.
  // The rules themselves (credential scoping, status filtering, the two-armed
  // settle predicate) are covered at the REST layer in
  // external-changeset-lifecycle.test.ts — these assert the MCP dispatch.
  it('list_changesets pages this credential\'s plans with a status filter', async () => {
    const env = makeEnv(tdb.db)
    const token = await credToken(tdb)

    const ids: string[] = []
    for (const value of ['one', 'two']) {
      const res = await rpc(env, token, {
        jsonrpc: '2.0', id: 21, method: 'tools/call',
        params: {
          name: 'prepare_translations',
          arguments: { projectId: PROJECT, translations: [{ cellId: 'cell-1', fileId: FILE, value }] },
        },
      })
      ids.push((toolPayload(((await res.json()) as any).result).payload as any).changesetId)
    }

    const listRes = await rpc(env, token, {
      jsonrpc: '2.0', id: 22, method: 'tools/call',
      params: { name: 'list_changesets', arguments: { projectId: PROJECT, status: 'staged', limit: 1 } },
    })
    const listed = toolPayload(((await listRes.json()) as any).result)
    expect(listed.isError).toBe(false)
    const page = listed.payload as any
    expect(page.changesets).toHaveLength(1)
    expect(page.changesets[0].changesetId).toBe(ids[1]) // newest first
    expect(page.changesets[0].status).toBe('staged')
    expect(page.changesets[0].approvalUrl).toBe(`https://aquilla.app/approve/${ids[1]}`)
    expect(page.nextCursor).toBeTruthy()

    const page2 = toolPayload(
      ((await (
        await rpc(env, token, {
          jsonrpc: '2.0', id: 23, method: 'tools/call',
          params: {
            name: 'list_changesets',
            arguments: { projectId: PROJECT, status: 'staged', limit: 1, cursor: page.nextCursor },
          },
        })
      ).json()) as any).result,
    ).payload as any
    expect(page2.changesets[0].changesetId).toBe(ids[0])
    expect(page2.nextCursor).toBeNull()
  })

  it('wait_for_changeset reports a pending plan as timedOut rather than an error', async () => {
    const env = makeEnv(tdb.db)
    const token = await credToken(tdb, { userId: 1, username: 'alice', mode: 'ask' })
    const prepRes = await rpc(env, token, {
      jsonrpc: '2.0', id: 24, method: 'tools/call',
      params: {
        name: 'prepare_translations',
        arguments: { projectId: PROJECT, translations: [{ cellId: 'cell-1', fileId: FILE, value: 'x' }] },
      },
    })
    const prepPayload = toolPayload(((await prepRes.json()) as any).result).payload as any

    const waitRes = await rpc(env, token, {
      jsonrpc: '2.0', id: 25, method: 'tools/call',
      params: {
        name: 'wait_for_changeset',
        arguments: { projectId: PROJECT, changesetId: prepPayload.changesetId, timeoutMs: 0 },
      },
    })
    const waited = toolPayload(((await waitRes.json()) as any).result)
    // Nobody approved yet — a normal outcome, so NOT an MCP error result.
    expect(waited.isError).toBe(false)
    const payload = waited.payload as any
    expect(payload.timedOut).toBe(true)
    expect(payload.approved).toBe(false)
    expect(payload.status).toBe('staged')
  })
})

// Agent API v1.1: CreateProject / UpdateProjectSettings / LinkMedia stage via
// the SAME prepare_translations / confirm_changeset tools as SetTranslation,
// through a generic `commands` argument (mcp-handlers.ts passes it through
// as-is; REST-level coverage of the commands themselves lives in
// external-project-commands.test.ts / external-link-media.test.ts — these
// tests are about the MCP dispatch plumbing, not re-deriving that coverage).
describe('MCP tools/call — v1.1 commands via the generic `commands` argument', () => {
  it('prepare_translations requires translations or commands to be non-empty', async () => {
    const env = makeEnv(tdb.db)
    const token = await credToken(tdb)
    const res = await rpc(env, token, {
      jsonrpc: '2.0', id: 30, method: 'tools/call',
      params: { name: 'prepare_translations', arguments: { projectId: PROJECT } },
    })
    const { payload, isError } = toolPayload(((await res.json()) as any).result)
    expect(isError).toBe(true)
    expect((payload as any).error.code).toBe('validation_failed')
  })

  it('UpdateProjectSettings via `commands` stages and commits with a receipt-only receipt, channel "mcp"', async () => {
    const env = makeEnv(tdb.db)
    const CRED_2 = '00000000-0000-0000-0000-000000000002'
    await tdb.pg.query(
      `INSERT INTO users (id, username, email, password_hash) VALUES (2, 'maintainer', 'maintainer@x.com', 'h')
       ON CONFLICT (id) DO NOTHING`,
    )
    await tdb.pg.query(
      `INSERT INTO project_members (project_id, user_id, role_level) VALUES ($1, 2, 600)`,
      [PROJECT],
    )
    const { token: rawToken, tokenHash, tokenPrefix } = await mintApiToken()
    await tdb.pg.query(
      `INSERT INTO api_credentials (id, user_id, name, token_prefix, token_hash, mode, org_id, project_id)
       VALUES ($1, '2', 'test', $2, $3, 'act', NULL, $4)`,
      [CRED_2, tokenPrefix, tokenHash, PROJECT],
    )

    const prepRes = await rpc(env, rawToken, {
      jsonrpc: '2.0', id: 31, method: 'tools/call',
      params: {
        name: 'prepare_translations',
        arguments: {
          projectId: PROJECT,
          commands: [
            { kind: 'UpdateProjectSettings', projectId: PROJECT, settings: { validationThreshold: 2 }, ifMatchVersion: 0 },
          ],
        },
      },
    })
    const prep = toolPayload(((await prepRes.json()) as any).result)
    expect(prep.isError).toBe(false)
    const prepPayload = prep.payload as any
    expect(prepPayload.mode).toBe('act')

    const confirmRes = await rpc(env, rawToken, {
      jsonrpc: '2.0', id: 32, method: 'tools/call',
      params: {
        name: 'confirm_changeset',
        arguments: { projectId: PROJECT, changesetId: prepPayload.changesetId, digest: prepPayload.digest },
      },
    })
    const confirm = toolPayload(((await confirmRes.json()) as any).result)
    expect(confirm.isError).toBe(false)
    const receipt = (confirm.payload as any).receipt
    expect(receipt.command).toBe('UpdateProjectSettings')
    // channel is stamped 'mcp' because the tool dispatch marks its synthetic
    // request with x-aquilla-channel, not the REST default.
    expect(receipt.channel).toBe('mcp')
    expect(receipt.version).toBe(1)
    expect(receipt.projectId).toBe(PROJECT)
  })

  it('CreateProject mixed with SetTranslation -> validation_failed (server-enforced sole-command rule)', async () => {
    const env = makeEnv(tdb.db)
    const token = await credToken(tdb)
    const res = await rpc(env, token, {
      jsonrpc: '2.0', id: 33, method: 'tools/call',
      params: {
        name: 'prepare_translations',
        arguments: {
          projectId: PROJECT,
          translations: [{ cellId: 'cell-1', fileId: FILE, value: 'x' }],
          commands: [{ kind: 'CreateProject', name: 'Nested project' }],
        },
      },
    })
    const { payload, isError } = toolPayload(((await res.json()) as any).result)
    expect(isError).toBe(true)
    expect((payload as any).error.code).toBe('validation_failed')
  })
})

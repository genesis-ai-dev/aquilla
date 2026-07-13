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
  it('returns all 11 tools each with an input schema', async () => {
    const env = makeEnv(tdb.db)
    const token = await credToken(tdb)
    const res = await rpc(env, token, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
    const body = (await res.json()) as any
    const names = body.result.tools.map((t: any) => t.name).sort()
    expect(names).toEqual(
      [
        'confirm_changeset', 'discard_changeset', 'get_capabilities', 'get_changeset',
        'get_identity_and_scope', 'get_project', 'list_projects', 'prepare_translations',
        'read_content', 'read_history', 'search_project',
      ].sort(),
    )
    expect(body.result.tools).toHaveLength(11)
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
    expect(payload).toMatchObject({
      userId: '1', username: 'alice', mode: 'act', orgId: null, projectId: PROJECT, credentialId: CRED_1,
    })
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
    expect(p.commandKinds).toEqual(['SetTranslation'])
    expect(p.limits.changesetExpirySeconds).toBe(3600) // CHANGESET_TTL_MS / 1000
    expect(p.errorCodes).toContain('confirmation_required')
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
})

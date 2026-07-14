// Cold-start gate test for the Agent API (AQU-533 §6 gate 10).
//
// Simulates a STRANGER'S AGENT: it knows nothing about Aquilla except the MCP
// endpoint and a bearer token. Everything it does is driven by what the MCP
// protocol itself reveals — the tool catalog (names, descriptions, inputSchema)
// returned by tools/list — plus inspection of the JSON payloads tools return.
// No hardcoded REST paths, no imports from external/* internals: the harness
// touches only the MCP route entry point, the test-db/seed helpers,
// mintApiToken, and raw SQL for seeding + final assertions.
//
// If a tool's inputSchema is wrong (missing a required field, lying about a
// property name) the agent's own schema-driven validation fails this test —
// that is the point of the gate.

import { describe, it, expect, beforeEach, vi } from 'vitest'

// commit path: mcp-handlers -> changesets-route -> commit.ts -> events/route ->
// broadcast.ts -> partyserver (cloudflare:*). Stub it as the changeset suite does.
vi.mock('partyserver', () => ({
  getServerByName: vi.fn().mockResolvedValue({
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  }),
}))

import { handleExternalMcpRequest } from '../external/mcp-route'
import { mintApiToken } from '../../../db/shared/api-credentials'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'

const SECRET = 'test-secret'
const PROJECT = 'proj-vendor'
const OTHER_PROJECT = 'proj-outside-scope'
const FILE = 'file-genesis'
const CRED_ACT = '00000000-0000-0000-0000-00000000000a'
const CRED_ASK = '00000000-0000-0000-0000-00000000000b'
const USER_ID = 1

function makeEnv(db: AquillaDb) {
  return { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET, BASE_URL: 'https://aquilla.app' }
}

// ── vendor-side setup (out-of-band; the agent never sees any of this) ────────

async function seedVendor(): Promise<TestDb> {
  return makeTestDb({
    projects: [
      { id: PROJECT, name: 'Vendor Project', created_by: 99, org_id: null },
      { id: OTHER_PROJECT, name: 'Someone Elses Project', created_by: 98, org_id: null },
    ],
    // PROJECT_LEAD (500) on the in-scope project only.
    project_members: [{ project_id: PROJECT, user_id: USER_ID, role_level: 500 }],
    files: [{ id: FILE, project_id: PROJECT, name: 'Genesis', event_id: 'evt-file-1' }],
    cells: [
      {
        project_id: PROJECT, file_id: FILE, cell_id: 'GEN 1:1', side: 'source',
        value: 'In the beginning God created', event_id: 'src-evt-1', last_edit_at: 1, word_count: 5,
      },
      {
        project_id: PROJECT, file_id: FILE, cell_id: 'GEN 1:2', side: 'source',
        value: 'And the earth was without form', event_id: 'src-evt-2', last_edit_at: 2, word_count: 6,
      },
      {
        project_id: PROJECT, file_id: FILE, cell_id: 'GEN 1:3', side: 'source',
        value: 'And God said let there be light', event_id: 'src-evt-3', last_edit_at: 3, word_count: 7,
      },
    ],
  })
}

async function mintCred(tdb: TestDb, credentialId: string, mode: 'ask' | 'act'): Promise<string> {
  await tdb.pg.query(
    `INSERT INTO users (id, username, email, password_hash) VALUES ($1, 'lea', 'lea@x.com', 'h')
     ON CONFLICT (id) DO NOTHING`,
    [USER_ID],
  )
  const { token, tokenHash, tokenPrefix } = await mintApiToken()
  await tdb.pg.query(
    `INSERT INTO api_credentials (id, user_id, name, token_prefix, token_hash, mode, org_id, project_id)
     VALUES ($1, $2, 'coldstart', $3, $4, $5, NULL, $6)`,
    [credentialId, String(USER_ID), tokenPrefix, tokenHash, mode, PROJECT],
  )
  return token
}

// ── the simulated cold-start agent ───────────────────────────────────────────
//
// It may use ONLY: the JSON-RPC transport, the tool catalog from tools/list,
// and the payloads tools return. Before every call it validates its own
// arguments against the catalog's inputSchema (required fields present, no
// properties the schema doesn't declare when additionalProperties is false,
// and the same check one level down for array items). If the catalog is
// missing a tool it needs, or a schema disagrees with what the server actually
// accepts, the run fails.

interface CatalogTool {
  name: string
  description: string
  inputSchema: {
    type: string
    properties: Record<string, { type?: string; items?: CatalogTool['inputSchema'] } & Record<string, unknown>>
    required?: string[]
    additionalProperties?: boolean
  }
}

interface ToolOutcome {
  payload: Record<string, unknown>
  isError: boolean
}

class ColdStartAgent {
  private catalog: CatalogTool[] = []
  private rpcId = 0

  constructor(
    private readonly env: ReturnType<typeof makeEnv>,
    private readonly token: string,
  ) {}

  /** Raw JSON-RPC POST — the only wire the agent has. */
  async rpc(method: string, params?: unknown): Promise<Record<string, unknown>> {
    const res = await handleExternalMcpRequest(
      new Request('https://w/api/v1/external/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++this.rpcId, method, ...(params !== undefined ? { params } : {}) }),
      }),
      this.env,
    )
    if (!res) throw new Error(`cold-start: MCP endpoint did not answer ${method}`)
    if (res.status === 202) return {}
    if (!res.ok) throw new Error(`cold-start: HTTP ${res.status} on ${method}: ${await res.text()}`)
    return (await res.json()) as Record<string, unknown>
  }

  /** MCP handshake + catalog fetch. Everything downstream depends only on this. */
  async boot(): Promise<void> {
    const init = await this.rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'cold-start-agent', version: '0.0.1' },
    })
    const initResult = init.result as { capabilities?: { tools?: unknown } } | undefined
    if (!initResult?.capabilities || !('tools' in initResult.capabilities)) {
      throw new Error('cold-start: server did not advertise tools capability')
    }
    await this.rpc('notifications/initialized')
    const list = await this.rpc('tools/list')
    const tools = (list.result as { tools?: CatalogTool[] } | undefined)?.tools
    if (!Array.isArray(tools) || tools.length === 0) {
      throw new Error('cold-start: tools/list returned no catalog')
    }
    this.catalog = tools
  }

  /** Look a tool up in the fetched catalog — the agent has no other knowledge. */
  tool(name: string): CatalogTool {
    const t = this.catalog.find((x) => x.name === name)
    if (!t) {
      throw new Error(
        `cold-start: needed tool "${name}" but the catalog only has: ${this.catalog.map((x) => x.name).join(', ')}`,
      )
    }
    return t
  }

  /** Does the catalog contain a tool by this name? (discovery, not assumption) */
  has(name: string): boolean {
    return this.catalog.some((x) => x.name === name)
  }

  /** Lightweight schema check: required fields present, no undeclared props
   *  when additionalProperties is false; one level of the same for array items. */
  private validateAgainst(schema: CatalogTool['inputSchema'], args: Record<string, unknown>, ctx: string): void {
    for (const req of schema.required ?? []) {
      if (!(req in args) || args[req] === undefined) {
        throw new Error(`cold-start: ${ctx} — schema requires "${req}" and the agent could not derive it`)
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(args)) {
        if (!(key in schema.properties)) {
          throw new Error(`cold-start: ${ctx} — agent invented undeclared argument "${key}"`)
        }
      }
    }
    for (const [key, value] of Object.entries(args)) {
      const prop = schema.properties[key]
      const itemSchema = prop?.items as CatalogTool['inputSchema'] | undefined
      if (prop?.type === 'array' && itemSchema && Array.isArray(value)) {
        for (const item of value) {
          this.validateAgainst(itemSchema, item as Record<string, unknown>, `${ctx}.${key}[]`)
        }
      }
    }
  }

  /** tools/call with the agent's own catalog-driven argument validation. */
  async call(name: string, args: Record<string, unknown> = {}): Promise<ToolOutcome> {
    const tool = this.tool(name)
    this.validateAgainst(tool.inputSchema, args, name)
    const body = await this.rpc('tools/call', { name, arguments: args })
    if (body.error) throw new Error(`cold-start: ${name} raised a transport error: ${JSON.stringify(body.error)}`)
    const result = body.result as { content: { text: string }[]; isError?: boolean }
    return { payload: JSON.parse(result.content[0].text) as Record<string, unknown>, isError: result.isError === true }
  }

  /** Like call(), but a tool error is a failed journey. */
  async callOk(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const out = await this.call(name, args)
    if (out.isError) throw new Error(`cold-start: ${name} failed: ${JSON.stringify(out.payload)}`)
    return out.payload
  }
}

// ── shared journey steps (discovery is identical in both modes) ─────────────

interface DiscoveredCell {
  cellId: string
  fileId: string
  value: string
}

/** Steps 1–4 of the cold start: discover capabilities, identity, the project,
 *  its files, and its source cells — using nothing but catalog + payloads. */
async function discover(agent: ColdStartAgent): Promise<{ projectId: string; cells: DiscoveredCell[] }> {
  // get_capabilities describes itself as "the recommended first call".
  const caps = await agent.callOk('get_capabilities')
  expect(typeof caps.credentialMode).toBe('string')
  expect(Array.isArray(caps.errorCodes)).toBe(true)

  const identity = await agent.callOk('get_identity_and_scope')
  expect(typeof identity.userId).toBe('string')

  // list_projects description: "Each item has { id, name, org_id, role_source }".
  const projectsOut = await agent.callOk('list_projects')
  const projects = projectsOut.projects as { id: string }[]
  expect(projects).toHaveLength(1) // scoped credential -> exactly one choice
  const projectId = projects[0].id

  // read_content description: "Omit fileId to LIST the project's files".
  const filesOut = await agent.callOk('read_content', { projectId })
  const files = filesOut.data as Record<string, unknown>[]
  expect(files.length).toBeGreaterThan(0)
  // The schema names the property "fileId" — the agent looks for that key in
  // what came back rather than assuming a shape.
  const fileId = files[0].fileId
  if (typeof fileId !== 'string') {
    throw new Error(`cold-start: file listing items carry no "fileId" key (got keys: ${Object.keys(files[0]).join(', ')})`)
  }

  // "provide fileId to READ that file's cells (source + target)".
  const cellsOut = await agent.callOk('read_content', { projectId, fileId })
  const rows = cellsOut.data as Record<string, unknown>[]
  expect(rows.length).toBeGreaterThan(0)
  // prepare_translations' item schema requires cellId + fileId + value; the
  // side vocabulary ("source"|"target") comes from search_project's schema enum.
  const cells = rows
    .filter((r) => r.side === 'source' && typeof r.cellId === 'string' && typeof r.value === 'string')
    .map((r) => ({ cellId: r.cellId as string, fileId, value: r.value as string }))
  if (cells.length < 2) throw new Error('cold-start: could not discover 2 source cells to translate')
  return { projectId, cells }
}

/** Derive translation values from what was read (never invented out-of-band). */
function draft(cells: DiscoveredCell[]): { cellId: string; fileId: string; value: string }[] {
  return cells.slice(0, 2).map((c) => ({ cellId: c.cellId, fileId: c.fileId, value: `[fr] ${c.value}` }))
}

// ── tests ────────────────────────────────────────────────────────────────────

let tdb: TestDb
beforeEach(async () => {
  tdb = await seedVendor()
})

describe('cold start — act mode (gate 10)', () => {
  it('a stranger agent completes read -> stage -> commit -> verify from the catalog alone', async () => {
    const env = makeEnv(tdb.db)
    const agent = new ColdStartAgent(env, await mintCred(tdb, CRED_ACT, 'act'))
    await agent.boot()

    const { projectId, cells } = await discover(agent)
    const translations = draft(cells)

    // prepare_translations description: "Returns { changesetId, summary,
    // digest, mode, approvalUrl? } ... If mode is 'act', call confirm_changeset".
    const prep = await agent.callOk('prepare_translations', { projectId, translations })
    expect(prep.mode).toBe('act')
    expect(typeof prep.digest).toBe('string')
    expect(typeof prep.changesetId).toBe('string')
    const summary = prep.summary as { translationsAdded: number }
    expect(summary.translationsAdded).toBe(2)

    // confirm_changeset schema: projectId + changesetId + digest, all of which
    // prepare handed back under exactly those names.
    const confirmed = await agent.callOk('confirm_changeset', {
      projectId,
      changesetId: prep.changesetId,
      digest: prep.digest,
    })
    const receipt = confirmed.receipt as { appliedCount: number; eventIds: string[] }
    expect(receipt.appliedCount).toBe(2)

    // Re-read: the translations are now visible through the same read tool.
    const after = await agent.callOk('read_content', { projectId, fileId: translations[0].fileId })
    const targets = (after.data as Record<string, unknown>[]).filter((r) => r.side === 'target')
    for (const t of translations) {
      expect(targets.some((r) => r.cellId === t.cellId && r.value === t.value)).toBe(true)
    }

    // read_history on one cell shows the commit event with the agent's author.
    const history = await agent.callOk('read_history', { projectId, cellId: translations[0].cellId })
    const historyEvents = history.data as { kind: string; author: string; id: string }[]
    const commitEvt = historyEvents.find((e) => e.kind === 'target.cell.commit')
    expect(commitEvt).toBeDefined()
    expect(commitEvt!.author).toBe('lea')
    expect(receipt.eventIds).toContain(commitEvt!.id)

    // ── vendor-side SQL assertions (outside the agent's world) ──────────────
    // Provenance envelope is server-stamped with agent origin + the credential.
    const events = await tdb.rows<{ kind: string; cell_id: string; provenance: unknown }>('events')
    const commits = events.filter((e) => e.kind === 'target.cell.commit')
    expect(commits).toHaveLength(2)
    for (const e of commits) {
      const prov = (typeof e.provenance === 'string' ? JSON.parse(e.provenance) : e.provenance) as Record<string, unknown>
      expect(prov.origin).toBe('agent')
      expect(prov.autonomy_mode).toBe('act')
      expect(prov.changeset_id).toBe(prep.changesetId)
      expect(prov.human_authority).toEqual({ user_id: String(USER_ID), credential_id: CRED_ACT })
      // This commit was driven over MCP (confirm_changeset), so the provenance
      // channel must reflect that — not the REST default.
      expect(prov.channel).toBe('mcp')
    }
  })
})

describe('cold start — ask mode (gate 10 + gate 6)', () => {
  it('the agent hits confirmation_required, a human approves out-of-band, then commit applies', async () => {
    const env = makeEnv(tdb.db)
    const agent = new ColdStartAgent(env, await mintCred(tdb, CRED_ASK, 'ask'))
    await agent.boot()

    const { projectId, cells } = await discover(agent)
    const translations = draft(cells)

    const prep = await agent.callOk('prepare_translations', { projectId, translations })
    expect(prep.mode).toBe('ask')
    // prepare's description promises approvalUrl in ask mode.
    expect(typeof prep.approvalUrl).toBe('string')
    expect((prep.approvalUrl as string).length).toBeGreaterThan(0)

    // The agent tries to commit anyway — the server must refuse with a
    // structured confirmation_required carrying the approvalUrl.
    const refused = await agent.call('confirm_changeset', {
      projectId,
      changesetId: prep.changesetId,
      digest: prep.digest,
    })
    expect(refused.isError).toBe(true)
    const refusedErr = refused.payload.error as { code: string; approvalUrl?: string }
    expect(refusedErr.code).toBe('confirmation_required')
    expect(refusedErr.approvalUrl).toBe(prep.approvalUrl)

    // Nothing applied yet.
    expect((await tdb.rows<{ kind: string }>('events')).filter((e) => e.kind === 'target.cell.commit')).toHaveLength(0)

    // ── human approval, out-of-band ─────────────────────────────────────────
    // Mirrors exactly the row auth-worker/src/routes/changeset-approvals.ts
    // POST /:id/approve writes: (id, changeset_id, user_id, credential_id,
    // digest, expires_at), consumed_at defaulting NULL.
    await tdb.pg.query(
      `INSERT INTO changeset_confirmations (id, changeset_id, user_id, credential_id, digest, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        crypto.randomUUID(),
        prep.changesetId,
        String(USER_ID),
        CRED_ASK,
        prep.digest,
        new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      ],
    )

    // The agent retries confirm — now it commits.
    const confirmed = await agent.callOk('confirm_changeset', {
      projectId,
      changesetId: prep.changesetId,
      digest: prep.digest,
    })
    expect((confirmed.receipt as { appliedCount: number }).appliedCount).toBe(2)

    // Applied for real, with ask-mode provenance carrying the confirmation.
    const events = await tdb.rows<{ kind: string; provenance: unknown }>('events')
    const commits = events.filter((e) => e.kind === 'target.cell.commit')
    expect(commits).toHaveLength(2)
    for (const e of commits) {
      const prov = (typeof e.provenance === 'string' ? JSON.parse(e.provenance) : e.provenance) as Record<string, unknown>
      expect(prov.origin).toBe('agent')
      expect(prov.autonomy_mode).toBe('ask')
      expect(prov.human_authority).toEqual({ user_id: String(USER_ID), credential_id: CRED_ASK })
      expect(typeof prov.confirmation_id).toBe('string')
    }
    // The confirmation was consumed exactly once.
    const confs = await tdb.rows<{ consumed_at: unknown }>('changeset_confirmations')
    expect(confs).toHaveLength(1)
    expect(confs[0].consumed_at).not.toBeNull()
  })
})

describe('cold start — negative paths', () => {
  it("the agent's own schema validation refuses a call missing a required arg", async () => {
    const env = makeEnv(tdb.db)
    const agent = new ColdStartAgent(env, await mintCred(tdb, CRED_ACT, 'act'))
    await agent.boot()
    // search_project requires q — a schema-honest agent refuses locally.
    await expect(agent.call('search_project', { projectId: PROJECT })).rejects.toThrow(/requires "q"/)
  })

  it('the server answers a missing required arg with a structured tool error, not a crash', async () => {
    const env = makeEnv(tdb.db)
    const agent = new ColdStartAgent(env, await mintCred(tdb, CRED_ACT, 'act'))
    await agent.boot()
    // Bypass the agent's local validation: a sloppy host sends the call anyway.
    const body = await agent.rpc('tools/call', { name: 'search_project', arguments: { projectId: PROJECT } })
    expect(body.error).toBeUndefined() // NOT a JSON-RPC transport error
    const result = body.result as { content: { text: string }[]; isError?: boolean }
    expect(result.isError).toBe(true)
    const payload = JSON.parse(result.content[0].text) as { error: { code: string; message: string } }
    expect(payload.error.code).toBe('validation_failed')
    expect(payload.error.message.length).toBeGreaterThan(0)
  })

  it('get_project outside the credential scope -> scope_denied in the isError payload', async () => {
    const env = makeEnv(tdb.db)
    const agent = new ColdStartAgent(env, await mintCred(tdb, CRED_ACT, 'act'))
    await agent.boot()
    const out = await agent.call('get_project', { projectId: OTHER_PROJECT })
    expect(out.isError).toBe(true)
    expect((out.payload.error as { code: string }).code).toBe('scope_denied')
  })
})

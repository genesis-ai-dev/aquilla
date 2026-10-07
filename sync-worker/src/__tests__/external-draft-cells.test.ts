// Tests for DraftCells (AQU-1186) — the external Agent API command that asks
// the project's OWN copilot to draft named cells and stages the result as one
// changeset for human approval.
//
// Covers the issue's acceptance criteria:
//   - cap enforcement: a request over the project's configured completion batch
//     size is rejected NAMING the cap, and never reaches the drafting backend;
//   - wildcards ("*", "all") are rejected at validation;
//   - credit metering: an exhausted org comes back as a clean named error and
//     NOTHING is staged (no changeset row, no drafting spend attributed here);
//   - staged-not-committed: a successful prepare stages a changeset whose cells
//     are untouched until commit, and the committed cells land as ai_drafted=1
//     with ai_draft provenance readable from the cells projection;
//   - the caller can never self-assert AI provenance on a hand-written
//     SetTranslation.
//
// The drafting model itself lives in auth-worker; the bridge is a plain fetch,
// so it is stubbed here. That boundary is exactly what makes the cost rails
// testable: everything asserted below is sync-worker's own behaviour.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// commit.ts → events/route.ts → broadcast.ts → partyserver (cloudflare:*).
vi.mock('partyserver', () => ({
  getServerByName: vi.fn().mockResolvedValue({
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  }),
}))

import { handleExternalChangesetsRequest } from '../external/changesets-route'
import { validateCommands } from '../external/commands'
import { mintApiToken } from '../../../db/shared/api-credentials'
import { DEFAULT_COMPLETION_BATCH_SIZE } from '../../../db/shared/completion-batch'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'

const SECRET = 'test-secret'
const AUTH_URL = 'https://identity.test'
const PROJECT = 'proj-d'
const FILE = 'file-d'

function makeEnv(db: AquillaDb) {
  return {
    AQUILLA_PG: db,
    SYNC_SECRET_KEY: SECRET,
    AUTH_WORKER_URL: AUTH_URL,
    BASE_URL: 'https://aquilla.app',
  }
}

let nextUserId = 900
let nextCred = 0

async function memberToken(tdb: TestDb, level: number): Promise<{ token: string; userId: number }> {
  const userId = nextUserId++
  await tdb.pg.query(
    `INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, 'h')`,
    [userId, `u${userId}`, `u${userId}@x.com`],
  )
  await tdb.pg.query(
    `INSERT INTO project_members (project_id, user_id, role_level) VALUES ($1, $2, $3)`,
    [PROJECT, userId, level],
  )
  const { token, tokenHash, tokenPrefix } = await mintApiToken()
  await tdb.pg.query(
    `INSERT INTO api_credentials (id, user_id, name, token_prefix, token_hash, mode, org_id, project_id)
     VALUES ($1, $2, 'test', $3, $4, 'act', NULL, $5)`,
    [`00000000-0000-0000-0000-${String(++nextCred).padStart(12, '0')}`, String(userId), tokenPrefix, tokenHash, PROJECT],
  )
  return { token, userId }
}

interface JsonBody {
  changeset?: { id: string; status: string }
  summary?: { translationsAdded?: number; translationsModified?: number }
  error?: { code: string; message: string; details?: Record<string, unknown> }
  applied?: unknown
}

async function prepare(env: ReturnType<typeof makeEnv>, token: string, commands: unknown) {
  const res = (await handleExternalChangesetsRequest(
    new Request(`https://w/api/v1/external/projects/${PROJECT}/changesets`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands }),
    }),
    env,
  ))!
  return { res, body: (await res.json()) as JsonBody }
}

async function commit(env: ReturnType<typeof makeEnv>, token: string, id: string) {
  const res = (await handleExternalChangesetsRequest(
    new Request(`https://w/api/v1/external/projects/${PROJECT}/changesets/${id}/commit`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    }),
    env,
  ))!
  return { res, body: (await res.json()) as JsonBody }
}

function draftCmd(cellIds: string[], extra: Record<string, unknown> = {}) {
  return [{ kind: 'DraftCells', fileId: FILE, cellIds, ...extra }]
}

function provenance(model = 'test/model') {
  return {
    model,
    provider: 'platform',
    promptVersion: 'agent-draft-v3-staged-research',
    exampleIds: [],
    generatedAt: 1_700_000_000_000,
    mode: 'agent',
    projectState: { sourceLanguage: 'en', targetLanguage: 'fr', approvedExampleCount: 0 },
  }
}

/** Stub the auth-worker drafting bridge. Returns the recorded calls. */
function stubBridge(reply: (body: Record<string, unknown>) => Response) {
  const calls: { url: string; body: Record<string, unknown>; auth: string | null }[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const parsed = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    const headers = new Headers(init?.headers)
    calls.push({ url, body: parsed, auth: headers.get('Authorization') })
    return reply(parsed)
  }))
  return calls
}

/** Bridge that drafts every requested cell as "draft:<cellId>". */
function draftEverything(model = 'test/model') {
  return stubBridge((body) => {
    const cellIds = (body.cellIds ?? []) as string[]
    return Response.json({
      fileId: body.fileId,
      model,
      drafts: cellIds.map((cellId) => ({ cellId, value: `draft:${cellId}`, aiDraft: provenance(model) })),
      missed: [],
      remaining: 0,
    })
  })
}

let tdb: TestDb

async function seed(cellCount: number, settings: Record<string, unknown> | null) {
  const cells = Array.from({ length: cellCount }, (_, i) => ({
    project_id: PROJECT,
    file_id: FILE,
    cell_id: `c${i + 1}`,
    side: 'source' as const,
    value: `source ${i + 1}`,
    event_id: `src-evt-${i + 1}`,
    last_edit_at: 1,
  }))
  return makeTestDb({
    projects: [{ id: PROJECT, name: 'P', created_by: 99, org_id: null }],
    files: [{ project_id: PROJECT, id: FILE, name: 'f.usfm', created_at: 1, updated_at: 1 }],
    cells,
    ...(settings
      ? {
          project_settings: [{
            project_id: PROJECT,
            settings: JSON.stringify(settings),
            version: 1,
            updated_by: 99,
            updated_at: new Date().toISOString(),
          }],
        }
      : {}),
  })
}

beforeEach(() => {
  nextUserId = 900
  nextCred = 0
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ── validation: explicit cell ids only ───────────────────────────────────────

describe('DraftCells — validation', () => {
  it('rejects a wildcard cell id, naming the rule', () => {
    for (const wildcard of ['*', 'all', '**', '%']) {
      const result = validateCommands([{ kind: 'DraftCells', fileId: FILE, cellIds: [wildcard] }])
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('unreachable')
      expect(result.issues[0].message).toMatch(/wildcard/i)
      expect(result.issues[0].message).toMatch(/explicit cell ids/i)
    }
  })

  it('rejects an empty or missing cellIds list', () => {
    for (const cellIds of [[], undefined]) {
      const result = validateCommands([{ kind: 'DraftCells', fileId: FILE, cellIds }])
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('unreachable')
      expect(result.issues[0].message).toMatch(/non-empty array/)
    }
  })

  it('de-duplicates repeated cell ids rather than drafting one cell twice', () => {
    const result = validateCommands([{ kind: 'DraftCells', fileId: FILE, cellIds: ['c1', 'c1', 'c2'] }])
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.commands[0]).toMatchObject({ kind: 'DraftCells', cellIds: ['c1', 'c2'] })
  })

  it('never lets a caller self-assert AI provenance on a SetTranslation', () => {
    const result = validateCommands([
      { kind: 'SetTranslation', fileId: FILE, cellId: 'c1', value: 'mine', aiDraft: provenance() },
    ])
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.commands[0]).not.toHaveProperty('aiDraft')
  })
})

// ── cost rail: the per-changeset cap ─────────────────────────────────────────

describe('DraftCells — batch-size cap', () => {
  it('rejects a request over the project default cap, naming it, without calling the copilot', async () => {
    tdb = await seed(DEFAULT_COMPLETION_BATCH_SIZE + 1, null)
    const env = makeEnv(tdb.db)
    const { token } = await memberToken(tdb, 400)
    const calls = draftEverything()

    const cellIds = Array.from({ length: DEFAULT_COMPLETION_BATCH_SIZE + 1 }, (_, i) => `c${i + 1}`)
    const { res, body } = await prepare(env, token, draftCmd(cellIds))

    expect(res.status).toBe(400)
    expect(body.error?.code).toBe('validation_failed')
    expect(body.error?.message).toContain(String(DEFAULT_COMPLETION_BATCH_SIZE))
    expect(body.error?.details).toMatchObject({
      requested: DEFAULT_COMPLETION_BATCH_SIZE + 1,
      maxCells: DEFAULT_COMPLETION_BATCH_SIZE,
    })
    // The expensive call is never made, and nothing is staged.
    expect(calls).toHaveLength(0)
    expect(await tdb.rows('changesets')).toHaveLength(0)
  })

  it("honours the project's configured batch size over the default", async () => {
    tdb = await seed(20, { completionSettings: { completionBatchSize: 20 } })
    const env = makeEnv(tdb.db)
    const { token } = await memberToken(tdb, 400)
    const calls = draftEverything()

    const cellIds = Array.from({ length: 20 }, (_, i) => `c${i + 1}`)
    const { res, body } = await prepare(env, token, draftCmd(cellIds))

    expect(res.status).toBe(200)
    expect(body.summary?.translationsAdded).toBe(20)
    expect(calls).toHaveLength(1)
    expect(calls[0].body.cellIds).toHaveLength(20)
  })
})

// ── cost rail: credit exhaustion stages nothing ──────────────────────────────

describe('DraftCells — credit metering', () => {
  it('surfaces an exhausted credit cap as a named error and stages nothing', async () => {
    tdb = await seed(3, null)
    const env = makeEnv(tdb.db)
    const { token } = await memberToken(tdb, 400)
    stubBridge(() =>
      Response.json(
        { error: 'credit_cap_exceeded', reason: 'agentDaily', message: 'Agent credit cap reached.' },
        { status: 429 },
      ),
    )

    const { res, body } = await prepare(env, token, draftCmd(['c1', 'c2', 'c3']))

    expect(res.status).toBe(429)
    expect(body.error?.code).toBe('rate_limited')
    expect(body.error?.message).toMatch(/credit cap/i)
    expect(body.error?.message).toMatch(/nothing was staged/i)
    expect(await tdb.rows('changesets')).toHaveLength(0)
    // No target cell was written either.
    const targets = await tdb.rows("cells")
    expect(targets.filter((r) => (r as { side: string }).side === 'target')).toHaveLength(0)
  })

  it('reaches the drafting backend with the shared secret and the acting user', async () => {
    tdb = await seed(2, null)
    const env = makeEnv(tdb.db)
    const { token, userId } = await memberToken(tdb, 400)
    const calls = draftEverything()

    await prepare(env, token, draftCmd(['c1', 'c2']))

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(`${AUTH_URL}/api/v1/ai/agent/internal/draft-cells`)
    expect(calls[0].auth).toBe(`Bearer ${SECRET}`)
    expect(calls[0].body).toMatchObject({ projectId: PROJECT, fileId: FILE, userId: String(userId) })
  })
})

// ── staged, not committed ────────────────────────────────────────────────────

describe('DraftCells — staged, never auto-committed', () => {
  it('stages the copilot output without touching any cell until commit', async () => {
    tdb = await seed(2, null)
    const env = makeEnv(tdb.db)
    const { token } = await memberToken(tdb, 400)
    draftEverything()

    const { res, body } = await prepare(env, token, draftCmd(['c1', 'c2']))
    expect(res.status).toBe(200)
    expect(body.changeset?.status).toBe('staged')
    expect(body.summary?.translationsAdded).toBe(2)

    // Staged only: no target cells, no events.
    const cells = await tdb.rows<{ side: string }>('cells')
    expect(cells.every((c) => c.side === 'source')).toBe(true)
    expect(await tdb.rows('events')).toHaveLength(0)
  })

  it('commits the drafts as ai_drafted cells carrying the copilot provenance', async () => {
    tdb = await seed(2, null)
    const env = makeEnv(tdb.db)
    const { token } = await memberToken(tdb, 400)
    draftEverything('anthropic/test-drafter')

    const prep = await prepare(env, token, draftCmd(['c1', 'c2']))
    const changesetId = prep.body.changeset!.id
    const { res } = await commit(env, token, changesetId)
    expect(res.status).toBe(200)

    const targets = await tdb.rows<{
      cell_id: string
      side: string
      value: string
      ai_drafted: number
      ai_draft: unknown
    }>('cells')
    const drafted = targets.filter((c) => c.side === 'target').sort((a, b) => a.cell_id.localeCompare(b.cell_id))
    expect(drafted.map((c) => c.cell_id)).toEqual(['c1', 'c2'])
    expect(drafted.map((c) => c.value)).toEqual(['draft:c1', 'draft:c2'])
    // Marked as an AI draft awaiting review — identical to an in-app draft.
    expect(drafted.every((c) => c.ai_drafted === 1)).toBe(true)
    const stored = typeof drafted[0].ai_draft === 'string'
      ? (JSON.parse(drafted[0].ai_draft) as { model: string })
      : (drafted[0].ai_draft as { model: string })
    expect(stored.model).toBe('anthropic/test-drafter')
  })

  it('rejects mixing DraftCells with another command in one changeset', async () => {
    tdb = await seed(2, null)
    const env = makeEnv(tdb.db)
    const { token } = await memberToken(tdb, 400)
    const calls = draftEverything()

    const { res, body } = await prepare(env, token, [
      { kind: 'DraftCells', fileId: FILE, cellIds: ['c1'] },
      { kind: 'SetTranslation', fileId: FILE, cellId: 'c2', value: 'mine' },
    ])

    expect(res.status).toBe(400)
    expect(body.error?.message).toMatch(/only command/)
    expect(calls).toHaveLength(0)
  })

  it('is denied below the contributor floor, before any drafting spend', async () => {
    tdb = await seed(2, null)
    const env = makeEnv(tdb.db)
    const { token } = await memberToken(tdb, 100) // viewer
    const calls = draftEverything()

    const { res, body } = await prepare(env, token, draftCmd(['c1']))

    expect(res.status).toBe(403)
    expect(body.error?.code).toBe('permission_denied')
    expect(calls).toHaveLength(0)
  })

  it('fails cleanly (staging nothing) when the copilot returns no usable draft', async () => {
    tdb = await seed(2, null)
    const env = makeEnv(tdb.db)
    const { token } = await memberToken(tdb, 400)
    stubBridge(() => Response.json({ drafts: [], missed: ['c1'], remaining: 0 }))

    const { res, body } = await prepare(env, token, draftCmd(['c1']))

    expect(res.status).toBe(500)
    expect(body.error?.code).toBe('job_failed')
    expect(body.error?.message).toMatch(/nothing was staged/)
    expect(await tdb.rows('changesets')).toHaveLength(0)
  })
})

// Tests for RegenerateBriefSummary (AQU-1282 §2): re-rendering the brief's L1
// summary through the changeset engine so an agent-written brief reaches the
// copilot with no in-app step.
//
// The acceptance this suite encodes: after a commit, prompt-preview's
// `parts.brief` is non-empty and carries the rendered summary; a failed render
// (backend down, credit cap, not configured) answers with a named code and
// leaves the changeset committable — the approval is never burned on a model
// failure; the MAINTAINER floor and the settings version pin match SetBrief.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// commit.ts → events/route.ts → broadcast.ts → partyserver (cloudflare:*).
vi.mock('partyserver', () => ({
  getServerByName: vi.fn().mockResolvedValue({
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  }),
}))

import { handleExternalChangesetsRequest } from '../external/changesets-route'
import { buildPromptPreview } from '../external/prompt-preview'
import { BRIEF_SETTINGS_KEY, type TranslationBriefRecord } from '../../../db/shared/brief'
import { mintApiToken } from '../../../db/shared/api-credentials'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'

const SECRET = 'test-secret'
const AUTH_URL = 'https://identity.test'
const PROJECT = 'proj-regen-brief'
const FILE = 'file-1'
const ORG_ID = 88

function makeEnv(db: AquillaDb, opts: { configured?: boolean } = {}) {
  return {
    AQUILLA_PG: db,
    SYNC_SECRET_KEY: SECRET,
    BASE_URL: 'https://aquilla.app',
    ...(opts.configured === false ? {} : { AUTH_WORKER_URL: AUTH_URL }),
  }
}

let nextUserId = 900
let nextCred = 0

async function memberToken(tdb: TestDb, level: number): Promise<{ token: string; userId: number }> {
  const userId = nextUserId++
  const username = `u${userId}`
  await tdb.pg.query(
    `INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, 'h')`,
    [userId, username, `${username}@x.com`],
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

async function prepare(env: ReturnType<typeof makeEnv>, token: string, commands: unknown) {
  const res = (await handleExternalChangesetsRequest(
    new Request(`https://w/api/v1/external/projects/${PROJECT}/changesets`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands }),
    }),
    env,
  ))!
  return { res, body: (await res.json()) as any }
}

async function commit(env: ReturnType<typeof makeEnv>, token: string, id: string) {
  const res = (await handleExternalChangesetsRequest(
    new Request(`https://w/api/v1/external/projects/${PROJECT}/changesets/${id}/commit`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` },
    }), env,
  ))!
  return { res, body: (await res.json()) as any }
}

function regen(ifMatchVersion = 1) {
  return [{ kind: 'RegenerateBriefSummary', projectId: PROJECT, ifMatchVersion }]
}

/** Stub the auth-worker bridge; records every call it receives. */
function stubBridge(reply: (body: Record<string, unknown>) => Response) {
  const calls: { url: string; body: Record<string, unknown>; auth: string | null }[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const parsed = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    calls.push({ url, body: parsed, auth: new Headers(init?.headers).get('Authorization') })
    return reply(parsed)
  }))
  return calls
}

function renderOk(summary: string, model = 'test/brief-model') {
  return stubBridge(() => Response.json({ summary, model }))
}

async function storedBrief(tdb: TestDb): Promise<TranslationBriefRecord | undefined> {
  const rows = await tdb.rows<{ settings: string }>('project_settings')
  return JSON.parse(rows[0].settings)[BRIEF_SETTINGS_KEY]
}

async function settingsVersion(tdb: TestDb): Promise<number> {
  const rows = await tdb.rows<{ version: number }>('project_settings')
  return rows[0].version
}

/** A brief with two filled sections and a STALE L1 (sections edited after it). */
function staleBrief(): TranslationBriefRecord {
  return {
    version: 3,
    updatedAt: '2026-09-02T00:00:00.000Z',
    updatedBy: 'human',
    parameters: { purpose: 'Liturgical reading', audience: 'Rural youth, 15–25' },
    freeformNotes: '',
    l2Markdown: '',
    l1Summary: 'old summary',
    l1GeneratedAt: '2026-09-01T00:00:00.000Z',
    l1ModelId: 'old-model',
  }
}

async function seedSettings(tdb: TestDb, settings: Record<string, unknown>) {
  await tdb.db
    .prepare(`UPDATE project_settings SET settings = ? WHERE project_id = ?`)
    .bind(JSON.stringify(settings), PROJECT)
    .run()
}

let tdb: TestDb
beforeEach(async () => {
  nextUserId = 900
  tdb = await makeTestDb({
    organizations: [{ id: ORG_ID, name: 'Org', owner_user_id: 1 }],
    projects: [{ id: PROJECT, name: 'P', created_by: 99, org_id: ORG_ID }],
    files: [{ project_id: PROJECT, id: FILE, name: 'f.usfm', created_at: 1, updated_at: 1 }],
    cells: [{
      project_id: PROJECT, file_id: FILE, cell_id: 'c1', side: 'source',
      value: 'In the beginning', event_id: 'src-evt-1', last_edit_at: 1,
    }],
    project_settings: [{
      project_id: PROJECT,
      settings: JSON.stringify({ targetLanguage: 'fr' }),
      version: 1,
      updated_by: 99,
      updated_at: new Date().toISOString(),
    }],
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('RegenerateBriefSummary — rendering the L1', () => {
  it('renders the summary from the live sections and the copilot prompt picks it up', async () => {
    const env = makeEnv(tdb.db)
    const maintainer = await memberToken(tdb, 600)
    await seedSettings(tdb, { targetLanguage: 'fr', [BRIEF_SETTINGS_KEY]: staleBrief() })
    const calls = renderOk('Translate for rural youth aged 15–25 in a liturgical register.')

    // Before: the prompt carries the OLD (stale) summary.
    const before = await buildPromptPreview(tdb.db, { projectId: PROJECT, cellId: 'c1', targetLang: '' })
    expect(before.ok && before.body.parts.brief).toContain('old summary')

    const { res, body } = await prepare(env, maintainer.token, regen())
    expect(res.status).toBe(200)
    expect(body.summary.command).toBe('RegenerateBriefSummary')
    // The approval page sees what is being rewritten and from how much.
    expect(body.summary.settingsChanges['translationBrief.l1Summary']).toBe('(regenerated from 2 sections)')
    // Prepare stages only — no model call yet.
    expect(calls).toHaveLength(0)

    const { res: commitRes, body: committed } = await commit(env, maintainer.token, body.changeset.id)
    expect(commitRes.status).toBe(200)
    expect(committed.receipt.command).toBe('RegenerateBriefSummary')
    expect(committed.receipt.version).toBe(2)
    expect(committed.receipt.briefSummaryChars).toBe(
      'Translate for rural youth aged 15–25 in a liturgical register.'.length,
    )
    expect(committed.receipt.l1ModelId).toBe('test/brief-model')

    // One server-to-server render, with the shared secret, summarizing the
    // brief's L2 (assembled from the live sections when none is stored).
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(`${AUTH_URL}/api/v1/ai/agent/internal/brief-summary`)
    expect(calls[0].auth).toBe(`Bearer ${SECRET}`)
    expect(calls[0].body.projectId).toBe(PROJECT)
    expect(String(calls[0].body.userId)).toBe(String(maintainer.userId))
    expect(calls[0].body.l2Markdown).toContain('### Purpose / skopos\nLiturgical reading')
    expect(calls[0].body.l2Markdown).toContain('Rural youth, 15–25')

    const brief = (await storedBrief(tdb))!
    expect(brief.l1Summary).toBe('Translate for rural youth aged 15–25 in a liturgical register.')
    expect(brief.l1ModelId).toBe('test/brief-model')
    // Fresh, not stale: the render timestamp is at or after the last section edit.
    expect(brief.l1GeneratedAt! >= brief.updatedAt).toBe(true)
    // The sections and the brief's own version are untouched — only the L1 moved.
    expect(brief.parameters).toEqual(staleBrief().parameters)
    expect(brief.version).toBe(3)
    expect(brief.updatedAt).toBe(staleBrief().updatedAt)

    // ACCEPTANCE: the copilot's prompt now carries the new summary, no in-app step.
    const after = await buildPromptPreview(tdb.db, { projectId: PROJECT, cellId: 'c1', targetLang: '' })
    expect(after.ok).toBe(true)
    if (after.ok) {
      expect(after.body.parts.brief).not.toBe('')
      expect(after.body.parts.brief).toContain('Translate for rural youth aged 15–25')
      expect(after.body.parts.brief).not.toContain('old summary')
    }
  })

  it('a brief with only freeformNotes is still summarizable', async () => {
    const env = makeEnv(tdb.db)
    const maintainer = await memberToken(tdb, 600)
    const notesOnly = { ...staleBrief(), parameters: {}, freeformNotes: 'Keep verse numbers.', l1Summary: null }
    await seedSettings(tdb, { targetLanguage: 'fr', [BRIEF_SETTINGS_KEY]: notesOnly })
    const calls = renderOk('Keep verse numbers.')

    const { res, body } = await prepare(env, maintainer.token, regen())
    expect(res.status).toBe(200)
    expect(body.summary.settingsChanges['translationBrief.l1Summary']).toBe('(regenerated from 0 sections)')
    const { res: commitRes } = await commit(env, maintainer.token, body.changeset.id)
    expect(commitRes.status).toBe(200)
    expect(calls[0].body.l2Markdown).toContain('## Additional notes\nKeep verse numbers.')
    expect((await storedBrief(tdb))!.l1Summary).toBe('Keep verse numbers.')
  })
})

describe('RegenerateBriefSummary — a failed render never burns the approval', () => {
  it('credit cap → rate_limited, changeset stays committable, nothing written; a retry then succeeds', async () => {
    const env = makeEnv(tdb.db)
    const maintainer = await memberToken(tdb, 600)
    await seedSettings(tdb, { targetLanguage: 'fr', [BRIEF_SETTINGS_KEY]: staleBrief() })
    stubBridge(() =>
      Response.json(
        { error: 'credit_cap_exceeded', reason: 'agentDaily', message: 'Agent credit cap reached.' },
        { status: 429 },
      ),
    )

    const { body: prep } = await prepare(env, maintainer.token, regen())
    const { res, body } = await commit(env, maintainer.token, prep.changeset.id)
    expect(res.status).toBe(429)
    expect(body.error.code).toBe('rate_limited')
    expect(body.error.message).toMatch(/not consumed/i)

    // Not consumed: still staged, L1 untouched, settings version unchanged.
    const cs = await tdb.rows<{ status: string }>('changesets')
    expect(cs[0].status).toBe('staged')
    expect((await storedBrief(tdb))!.l1Summary).toBe('old summary')
    expect(await settingsVersion(tdb)).toBe(1)

    // The org tops up; the SAME changeset commits.
    vi.unstubAllGlobals()
    renderOk('Fresh summary.')
    const { res: retryRes } = await commit(env, maintainer.token, prep.changeset.id)
    expect(retryRes.status).toBe(200)
    expect((await storedBrief(tdb))!.l1Summary).toBe('Fresh summary.')
    expect(await settingsVersion(tdb)).toBe(2)
  })

  it('backend down → job_failed, changeset stays committable', async () => {
    const env = makeEnv(tdb.db)
    const maintainer = await memberToken(tdb, 600)
    await seedSettings(tdb, { targetLanguage: 'fr', [BRIEF_SETTINGS_KEY]: staleBrief() })
    stubBridge(() => new Response('upstream exploded', { status: 500 }))

    const { body: prep } = await prepare(env, maintainer.token, regen())
    const { res, body } = await commit(env, maintainer.token, prep.changeset.id)
    expect(res.status).toBe(500)
    expect(body.error.code).toBe('job_failed')
    const cs = await tdb.rows<{ status: string }>('changesets')
    expect(cs[0].status).toBe('staged')
    expect((await storedBrief(tdb))!.l1Summary).toBe('old summary')
  })

  it('backend not configured in this environment → job_failed (never a throw)', async () => {
    const env = makeEnv(tdb.db, { configured: false })
    const maintainer = await memberToken(tdb, 600)
    await seedSettings(tdb, { targetLanguage: 'fr', [BRIEF_SETTINGS_KEY]: staleBrief() })
    const calls = stubBridge(() => Response.json({ summary: 'never' }))

    const { body: prep } = await prepare(env, maintainer.token, regen())
    const { res, body } = await commit(env, maintainer.token, prep.changeset.id)
    expect(res.status).toBe(500)
    expect(body.error.code).toBe('job_failed')
    expect(body.error.message).toMatch(/not configured/i)
    expect(calls).toHaveLength(0)
    const cs = await tdb.rows<{ status: string }>('changesets')
    expect(cs[0].status).toBe('staged')
  })
})

describe('RegenerateBriefSummary — guards', () => {
  it('nothing to summarize: no brief, or an empty one → validation_failed, nothing staged', async () => {
    const env = makeEnv(tdb.db)
    const maintainer = await memberToken(tdb, 600)
    const calls = renderOk('never')

    const { res, body } = await prepare(env, maintainer.token, regen())
    expect(res.status).toBe(400)
    expect(body.error.code).toBe('validation_failed')
    expect(body.error.message).toMatch(/nothing to summarize/i)

    await seedSettings(tdb, {
      targetLanguage: 'fr',
      [BRIEF_SETTINGS_KEY]: { ...staleBrief(), parameters: { purpose: '   ' }, freeformNotes: '' },
    })
    const { res: emptyRes } = await prepare(env, maintainer.token, regen())
    expect(emptyRes.status).toBe(400)
    expect(await tdb.rows('changesets')).toHaveLength(0)
    expect(calls).toHaveLength(0)
  })

  it('requires MAINTAINER: project_lead denied, maintainer allowed', async () => {
    const env = makeEnv(tdb.db)
    await seedSettings(tdb, { targetLanguage: 'fr', [BRIEF_SETTINGS_KEY]: staleBrief() })
    const lead = await memberToken(tdb, 500)
    const { res, body } = await prepare(env, lead.token, regen())
    expect(res.status).toBe(403)
    expect(body.error.code).toBe('permission_denied')
    expect(await tdb.rows('changesets')).toHaveLength(0)

    const maintainer = await memberToken(tdb, 600)
    const { res: okRes } = await prepare(env, maintainer.token, regen())
    expect(okRes.status).toBe(200)
  })

  it('version drift at prepare → plan_stale; drift before commit → plan_stale with no model call', async () => {
    const env = makeEnv(tdb.db)
    const maintainer = await memberToken(tdb, 600)
    await seedSettings(tdb, { targetLanguage: 'fr', [BRIEF_SETTINGS_KEY]: staleBrief() })
    const calls = renderOk('never')

    const { res } = await prepare(env, maintainer.token, regen(9))
    expect(res.status).toBe(409)

    const { body: prep } = await prepare(env, maintainer.token, regen())
    await tdb.db
      .prepare(`UPDATE project_settings SET version = 2, updated_by = 99 WHERE project_id = ?`)
      .bind(PROJECT)
      .run()
    const { res: commitRes, body } = await commit(env, maintainer.token, prep.changeset.id)
    expect(commitRes.status).toBe(409)
    expect(body.error.code).toBe('plan_stale')
    expect(body.error.details.status).toBe('stale')
    // Money is not spent on a write that could never land.
    expect(calls).toHaveLength(0)
  })

  it('sole-command rule and shape validation', async () => {
    const env = makeEnv(tdb.db)
    const maintainer = await memberToken(tdb, 600)
    await seedSettings(tdb, { targetLanguage: 'fr', [BRIEF_SETTINGS_KEY]: staleBrief() })

    const { res, body } = await prepare(env, maintainer.token, [
      ...regen(),
      { kind: 'SetTranslation', fileId: FILE, cellId: 'c1', value: 'v' },
    ])
    expect(res.status).toBe(400)
    expect(body.error.code).toBe('validation_failed')

    const { res: badRes } = await prepare(env, maintainer.token, [
      { kind: 'RegenerateBriefSummary', projectId: PROJECT, ifMatchVersion: -1 },
    ])
    expect(badRes.status).toBe(400)
    expect(await tdb.rows('changesets')).toHaveLength(0)
  })
})

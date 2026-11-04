// Tests for SetBrief (AQU-1227): writing a project's translation brief through
// the changeset engine. Covers the partial-section merge (unnamed sections and
// the generated L1 survive), the MAINTAINER floor, validation of unknown
// section ids at prepare (nothing staged), the settings version pin, and the
// supersede path when a human filled the same sections first.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// commit.ts → events/route.ts → broadcast.ts → partyserver (cloudflare:*).
vi.mock('partyserver', () => ({
  getServerByName: vi.fn().mockResolvedValue({
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  }),
}))

import { handleExternalChangesetsRequest } from '../external/changesets-route'
import { buildPromptPreview } from '../external/prompt-preview'
import { BRIEF_FIELD_MAX_CHARS, BRIEF_NOTES_MAX_CHARS } from '../external/commands-set-brief'
import {
  BRIEF_BY_LANE_SETTINGS_KEY,
  BRIEF_SETTINGS_KEY,
  type TranslationBriefRecord,
} from '../../../db/shared/brief'
import { mintApiToken } from '../../../db/shared/api-credentials'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'

const SECRET = 'test-secret'
const AUTH_URL = 'https://identity.test'
const PROJECT = 'proj-brief'
const ORG_ID = 88

/** No AUTH_WORKER_URL by default: the L1 auto-render (AQU-1282) reports
 *  not_configured and the sections write behaves exactly as before. */
function makeEnv(db: AquillaDb, opts: { configured?: boolean } = {}) {
  return {
    AQUILLA_PG: db,
    SYNC_SECRET_KEY: SECRET,
    BASE_URL: 'https://aquilla.app',
    ...(opts.configured ? { AUTH_WORKER_URL: AUTH_URL } : {}),
  }
}

/** Stub the auth-worker brief-summary bridge; records every call. */
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

afterEach(() => {
  vi.unstubAllGlobals()
})

let nextUserId = 800
let nextCred = 0

async function memberToken(tdb: TestDb, level: number): Promise<{ token: string; userId: number; username: string }> {
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
  return { token, userId, username }
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

function setBrief(patch: Record<string, unknown>, ifMatchVersion = 1) {
  return [{ kind: 'SetBrief', projectId: PROJECT, ...patch, ifMatchVersion }]
}

/** Read the brief back out of the stored settings row. */
async function storedBrief(tdb: TestDb): Promise<TranslationBriefRecord | undefined> {
  const rows = await tdb.rows<{ settings: string }>('project_settings')
  return JSON.parse(rows[0].settings)[BRIEF_SETTINGS_KEY]
}

/** Read ONE LANE's stored brief out of the settings row (AQU-2348). */
async function storedLaneBrief(
  tdb: TestDb,
  laneId: string,
): Promise<TranslationBriefRecord | undefined> {
  const rows = await tdb.rows<{ settings: string }>('project_settings')
  return (JSON.parse(rows[0].settings)[BRIEF_BY_LANE_SETTINGS_KEY] ?? {})[laneId]
}

/** A brief already holding two sections plus a generated L1, as if a human had
 *  filled it in the in-app builder. */
function seededBrief(): TranslationBriefRecord {
  return {
    version: 3,
    updatedAt: '2026-09-01T00:00:00.000Z',
    updatedBy: 'human',
    parameters: { purpose: 'Liturgical reading', literalness: 'Meaning-based' },
    freeformNotes: 'Keep verse numbers.',
    l2Markdown: '# Translation Brief\n\n## Purpose & audience\n\n### Purpose / skopos\nLiturgical reading',
    l1Summary: 'A meaning-based liturgical translation.',
    l1GeneratedAt: '2026-09-01T00:00:00.000Z',
    l1ModelId: 'model-x',
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
  nextUserId = 800
  tdb = await makeTestDb({
    organizations: [{ id: ORG_ID, name: 'Org', owner_user_id: 1 }],
    projects: [{ id: PROJECT, name: 'P', created_by: 99, org_id: ORG_ID }],
    files: [{ project_id: PROJECT, id: 'file-1', name: 'f.usfm', created_at: 1, updated_at: 1 }],
    cells: [{
      project_id: PROJECT, file_id: 'file-1', cell_id: 'c1', side: 'source',
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

describe('SetBrief — writing the brief', () => {
  it('stages and commits a brief onto a project that had none', async () => {
    const env = makeEnv(tdb.db)
    const maintainer = await memberToken(tdb, 600)

    const { res, body } = await prepare(env, maintainer.token, setBrief({
      parameters: { purpose: 'Church planting', audience: 'Rural youth, 15–25' },
      freeformNotes: 'Sponsor prefers a warm register.',
    }))
    expect(res.status).toBe(200)
    expect(body.summary.command).toBe('SetBrief')
    // The approval page gets one legible line per section being written.
    expect(body.summary.settingsChanges['translationBrief.purpose']).toBe('Church planting')
    expect(body.summary.settingsChanges['translationBrief.audience']).toContain('Rural youth')
    expect(body.summary.settingsChanges['translationBrief.freeformNotes']).toContain('warm register')

    const { res: commitRes, body: committed } = await commit(env, maintainer.token, body.changeset.id)
    expect(commitRes.status).toBe(200)
    expect(committed.receipt.command).toBe('SetBrief')
    expect(committed.receipt.version).toBe(2)
    // No drafting backend in this env: the receipt SAYS the L1 did not render
    // rather than leaving the caller to discover an invisible brief later.
    expect(committed.receipt.briefSummary).toEqual({
      rendered: false,
      reason: expect.stringContaining('not_configured'),
    })

    const brief = (await storedBrief(tdb))!
    expect(brief.parameters).toEqual({ purpose: 'Church planting', audience: 'Rural youth, 15–25' })
    expect(brief.freeformNotes).toBe('Sponsor prefers a warm register.')
    expect(brief.updatedBy).toBe(maintainer.username)
    expect(brief.version).toBe(1)
    // L2 is reassembled server-side from the filled sections, so the in-app
    // builder and the agent's docs read the same rendered document.
    expect(brief.l2Markdown).toContain('### Purpose / skopos\nChurch planting')
    expect(brief.l2Markdown).toContain('### Audience / addressees\nRural youth, 15–25')
    expect(brief.l2Markdown).toContain('## Additional notes\nSponsor prefers a warm register.')
    // An unfilled section is omitted, not stubbed.
    expect(brief.l2Markdown).not.toContain('Quality bar')
  })

  it('partial update: one section changes, the others and the generated L1 survive', async () => {
    const env = makeEnv(tdb.db)
    const maintainer = await memberToken(tdb, 600)
    await seedSettings(tdb, { targetLanguage: 'fr', [BRIEF_SETTINGS_KEY]: seededBrief() })

    const { body } = await prepare(env, maintainer.token, setBrief({
      parameters: { audience: 'Diaspora readers' },
    }))
    const { res: commitRes } = await commit(env, maintainer.token, body.changeset.id)
    expect(commitRes.status).toBe(200)

    const brief = (await storedBrief(tdb))!
    expect(brief.parameters).toEqual({
      purpose: 'Liturgical reading',
      literalness: 'Meaning-based',
      audience: 'Diaspora readers',
    })
    // freeformNotes was not named — it is untouched, not cleared.
    expect(brief.freeformNotes).toBe('Keep verse numbers.')
    // The L1 summary is carried over (never silently erased) but now reads as
    // stale, because updatedAt has moved past l1GeneratedAt — exactly what an
    // in-app section edit does.
    expect(brief.l1Summary).toBe('A meaning-based liturgical translation.')
    expect(brief.l1GeneratedAt).toBe('2026-09-01T00:00:00.000Z')
    expect(brief.updatedAt > brief.l1GeneratedAt!).toBe(true)
    // The brief's own version advances independently of the settings version.
    expect(brief.version).toBe(4)
  })

  it('writes the same settings key the in-app builder reads, leaving other keys alone', async () => {
    const env = makeEnv(tdb.db)
    const maintainer = await memberToken(tdb, 600)
    await seedSettings(tdb, { targetLanguage: 'fr', validationCount: 3 })

    const { body } = await prepare(env, maintainer.token, setBrief({ parameters: { qualityBar: 'Team review' } }))
    await commit(env, maintainer.token, body.changeset.id)

    const rows = await tdb.rows<{ settings: string; version: number }>('project_settings')
    const stored = JSON.parse(rows[0].settings)
    expect(stored[BRIEF_SETTINGS_KEY].parameters.qualityBar).toBe('Team review')
    expect(stored.targetLanguage).toBe('fr')
    expect(stored.validationCount).toBe(3)
    expect(rows[0].version).toBe(2)
  })

  it('freeformNotes alone is a valid write', async () => {
    const env = makeEnv(tdb.db)
    const maintainer = await memberToken(tdb, 600)
    const { res, body } = await prepare(env, maintainer.token, setBrief({ freeformNotes: 'Notes only.' }))
    expect(res.status).toBe(200)
    const { res: commitRes } = await commit(env, maintainer.token, body.changeset.id)
    expect(commitRes.status).toBe(200)
    expect((await storedBrief(tdb))!.freeformNotes).toBe('Notes only.')
  })
})

describe('SetBrief — L1 auto-render on commit (AQU-1282)', () => {
  it('renders the L1 after the sections land, so the brief reaches the copilot with no in-app step', async () => {
    const env = makeEnv(tdb.db, { configured: true })
    const maintainer = await memberToken(tdb, 600)
    const calls = stubBridge(() => Response.json({ summary: 'Translate for rural youth; warm register.', model: 'test/brief-model' }))

    const { body } = await prepare(env, maintainer.token, setBrief({
      parameters: { purpose: 'Church planting', audience: 'Rural youth, 15–25' },
    }))
    // Prepare stages only — no render yet.
    expect(calls).toHaveLength(0)

    const { res: commitRes, body: committed } = await commit(env, maintainer.token, body.changeset.id)
    expect(commitRes.status).toBe(200)
    expect(committed.receipt.briefSummary).toEqual({ rendered: true, chars: 41, model: 'test/brief-model' })
    // Two guarded writes (sections, then L1): the receipt reports the version
    // to pin NEXT, not the intermediate one.
    expect(committed.receipt.version).toBe(3)

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(`${AUTH_URL}/api/v1/ai/agent/internal/brief-summary`)
    expect(calls[0].auth).toBe(`Bearer ${SECRET}`)
    expect(calls[0].body.l2Markdown).toContain('### Purpose / skopos\nChurch planting')

    const brief = (await storedBrief(tdb))!
    expect(brief.parameters).toEqual({ purpose: 'Church planting', audience: 'Rural youth, 15–25' })
    expect(brief.l1Summary).toBe('Translate for rural youth; warm register.')
    expect(brief.l1ModelId).toBe('test/brief-model')
    expect(brief.l1GeneratedAt! >= brief.updatedAt).toBe(true)

    // ACCEPTANCE: prompt-preview's brief part is non-empty straight after the commit.
    const preview = await buildPromptPreview(tdb.db, { projectId: PROJECT, cellId: 'c1', targetLang: '' })
    expect(preview.ok && preview.body.parts.brief).toContain('Translate for rural youth; warm register.')
  })

  it('a failed render never fails the commit — the sections land and the receipt says why', async () => {
    const env = makeEnv(tdb.db, { configured: true })
    const maintainer = await memberToken(tdb, 600)
    await seedSettings(tdb, { targetLanguage: 'fr', [BRIEF_SETTINGS_KEY]: seededBrief() })
    stubBridge(() =>
      Response.json({ error: 'credit_cap_exceeded', reason: 'agentDaily', message: 'cap' }, { status: 429 }),
    )

    const { body } = await prepare(env, maintainer.token, setBrief({ parameters: { audience: 'Diaspora readers' } }))
    const { res: commitRes, body: committed } = await commit(env, maintainer.token, body.changeset.id)
    expect(commitRes.status).toBe(200)
    expect(committed.receipt.version).toBe(2)
    expect(committed.receipt.briefSummary.rendered).toBe(false)
    expect(committed.receipt.briefSummary.reason).toMatch(/rate_limited/)

    const brief = (await storedBrief(tdb))!
    expect(brief.parameters.audience).toBe('Diaspora readers')
    // The old L1 is carried over (stale), not cleared.
    expect(brief.l1Summary).toBe('A meaning-based liturgical translation.')
    expect(brief.l1GeneratedAt).toBe('2026-09-01T00:00:00.000Z')
  })

  // PR 667's QA walk ran against an identity worker a deploy behind, so every
  // auto-render 404'd. The sections must still land, and the receipt must say
  // WHICH worker is behind rather than "render failed (404)" — the operator's
  // next move is a deploy, not a retry.
  it('an identity worker without the renderer (404) still commits the sections and names the deploy', async () => {
    const env = makeEnv(tdb.db, { configured: true })
    const maintainer = await memberToken(tdb, 600)
    await seedSettings(tdb, { targetLanguage: 'fr', [BRIEF_SETTINGS_KEY]: seededBrief() })
    stubBridge(() => Response.json({ error: 'Not found' }, { status: 404 }))

    const { body } = await prepare(env, maintainer.token, setBrief({ parameters: { audience: 'Diaspora readers' } }))
    const { res: commitRes, body: committed } = await commit(env, maintainer.token, body.changeset.id)
    expect(commitRes.status).toBe(200)
    expect(committed.receipt.briefSummary.rendered).toBe(false)
    expect(committed.receipt.briefSummary.reason).toMatch(/auth-worker is behind sync-worker/i)

    const brief = (await storedBrief(tdb))!
    expect(brief.parameters.audience).toBe('Diaspora readers')
    expect(brief.l1Summary).toBe('A meaning-based liturgical translation.')
  })
})

describe('SetBrief — role floor', () => {
  it('requires MAINTAINER: project_lead denied, maintainer allowed', async () => {
    const env = makeEnv(tdb.db)
    const lead = await memberToken(tdb, 500)
    const { res, body } = await prepare(env, lead.token, setBrief({ parameters: { purpose: 'x' } }))
    expect(res.status).toBe(403)
    expect(body.error.code).toBe('permission_denied')
    expect(await tdb.rows('changesets')).toHaveLength(0)

    const maintainer = await memberToken(tdb, 600)
    const { res: okRes } = await prepare(env, maintainer.token, setBrief({ parameters: { purpose: 'x' } }))
    expect(okRes.status).toBe(200)
  })
})

describe('SetBrief — validation (rejected at prepare, never staged)', () => {
  it('an unknown section id is validation_failed and names the known fields', async () => {
    const env = makeEnv(tdb.db)
    const maintainer = await memberToken(tdb, 600)
    const { res, body } = await prepare(env, maintainer.token, setBrief({
      parameters: { purpose: 'ok', tone: 'friendly' },
    }))
    expect(res.status).toBe(400)
    expect(body.error.code).toBe('validation_failed')
    expect(JSON.stringify(body.error.details)).toContain('tone')
    expect(JSON.stringify(body.error.details)).toContain('qualityBar')
    // Nothing partially applied: the valid section did not sneak through.
    expect(await tdb.rows('changesets')).toHaveLength(0)
    expect(await storedBrief(tdb)).toBeUndefined()
  })

  it('a non-string section value is validation_failed', async () => {
    const env = makeEnv(tdb.db)
    const maintainer = await memberToken(tdb, 600)
    const { res, body } = await prepare(env, maintainer.token, setBrief({ parameters: { purpose: 42 } }))
    expect(res.status).toBe(400)
    expect(body.error.code).toBe('validation_failed')
    expect(await tdb.rows('changesets')).toHaveLength(0)
  })

  it('oversized section text and notes are rejected', async () => {
    const env = makeEnv(tdb.db)
    const maintainer = await memberToken(tdb, 600)
    const { res: fieldRes } = await prepare(env, maintainer.token, setBrief({
      parameters: { purpose: 'x'.repeat(BRIEF_FIELD_MAX_CHARS + 1) },
    }))
    expect(fieldRes.status).toBe(400)
    const { res: notesRes } = await prepare(env, maintainer.token, setBrief({
      freeformNotes: 'x'.repeat(BRIEF_NOTES_MAX_CHARS + 1),
    }))
    expect(notesRes.status).toBe(400)
    expect(await tdb.rows('changesets')).toHaveLength(0)
  })

  it('a SetBrief naming nothing to write is rejected', async () => {
    const env = makeEnv(tdb.db)
    const maintainer = await memberToken(tdb, 600)
    const { res, body } = await prepare(env, maintainer.token, setBrief({}))
    expect(res.status).toBe(400)
    expect(body.error.code).toBe('validation_failed')
  })

  it('sole-command rule: SetBrief cannot ride with another command', async () => {
    const env = makeEnv(tdb.db)
    const maintainer = await memberToken(tdb, 600)
    const { res, body } = await prepare(env, maintainer.token, [
      ...setBrief({ parameters: { purpose: 'x' } }),
      { kind: 'SetTranslation', fileId: 'f', cellId: 'c', laneId: 'deflane1', value: 'v' },
    ])
    expect(res.status).toBe(400)
    expect(body.error.code).toBe('validation_failed')
  })
})

describe('SetBrief — settings version guard', () => {
  it('version drift at prepare → plan_stale, nothing staged', async () => {
    const env = makeEnv(tdb.db)
    const maintainer = await memberToken(tdb, 600)
    const { res, body } = await prepare(env, maintainer.token, setBrief({ parameters: { purpose: 'x' } }, 9))
    expect(res.status).toBe(409)
    expect(body.error.code).toBe('plan_stale')
    expect(await tdb.rows('changesets')).toHaveLength(0)
  })

  it('drift between prepare and commit → plan_stale + status stale', async () => {
    const env = makeEnv(tdb.db)
    const maintainer = await memberToken(tdb, 600)
    const { body: prep } = await prepare(env, maintainer.token, setBrief({ parameters: { purpose: 'agent text' } }))

    // Someone else moves the settings version with an unrelated edit.
    await tdb.db
      .prepare(`UPDATE project_settings SET version = 2, updated_by = 99 WHERE project_id = ?`)
      .bind(PROJECT)
      .run()

    const { res, body } = await commit(env, maintainer.token, prep.changeset.id)
    expect(res.status).toBe(409)
    expect(body.error.code).toBe('plan_stale')
    expect(body.error.details.status).toBe('stale')
    const cs = await tdb.rows<{ status: string }>('changesets')
    expect(cs[0].status).toBe('stale')
  })

  it('a human writing the SAME sections first → superseded, not stale', async () => {
    const env = makeEnv(tdb.db)
    const maintainer = await memberToken(tdb, 600)
    const { body: prep } = await prepare(env, maintainer.token, setBrief({ parameters: { purpose: 'agent text' } }))

    // The human lands the identical section text and bumps the version.
    const human = seededBrief()
    human.parameters = { ...human.parameters, purpose: 'agent text' }
    await tdb.db
      .prepare(`UPDATE project_settings SET version = 2, updated_by = 99, settings = ? WHERE project_id = ?`)
      .bind(JSON.stringify({ targetLanguage: 'fr', [BRIEF_SETTINGS_KEY]: human }), PROJECT)
      .run()

    const { res, body } = await commit(env, maintainer.token, prep.changeset.id)
    expect(res.status).toBe(409)
    expect(body.error.code).toBe('plan_stale')
    expect(body.error.details.status).toBe('superseded')
    const cs = await tdb.rows<{ status: string }>('changesets')
    expect(cs[0].status).toBe('superseded')
  })
})

// AQU-2348: SetBrief writes ONE TARGET LANE's brief when it names one. The
// project's brief stays the default for every lane that has none, so a project
// nobody customized — and every single-lane project — behaves exactly as it
// did before `laneId` existed.
describe('SetBrief — per-lane briefs (AQU-2348)', () => {
  const ES_LANE = '0f0f0f0f'
  const FR_LANE = 'a1a1a1a1'

  /**
   * Two target lanes, as a two-audience project has. The source lane is the
   * one the harness's lane-fill trigger already minted for the seeded source
   * cell — inserting another would break `uq_lanes_project_source`.
   */
  async function seedLanes(): Promise<{ sourceLaneId: string }> {
    await tdb.pg.query(
      `INSERT INTO lanes (id, project_id, role, language, legacy_tag, position) VALUES
         ($1, $3, 'target', 'Spanish', 'es', 1),
         ($2, $3, 'target', 'French',  'fr', 2)`,
      [ES_LANE, FR_LANE, PROJECT],
    )
    const existing = await tdb.pg.query<{ id: string }>(
      `SELECT id FROM lanes WHERE project_id = $1 AND role = 'source'`,
      [PROJECT],
    )
    if (existing.rows.length > 0) return { sourceLaneId: existing.rows[0].id }
    await tdb.pg.query(
      `INSERT INTO lanes (id, project_id, role, language, legacy_tag, position)
       VALUES ('b2b2b2b2', $1, 'source', 'English', '', 0)`,
      [PROJECT],
    )
    return { sourceLaneId: 'b2b2b2b2' }
  }

  it('writes the lane brief and leaves the project brief alone', async () => {
    const env = makeEnv(tdb.db)
    const maintainer = await memberToken(tdb, 600)
    await seedLanes()
    await seedSettings(tdb, { targetLanguage: 'fr', [BRIEF_SETTINGS_KEY]: seededBrief() })

    const { res, body } = await prepare(env, maintainer.token, setBrief({
      laneId: ES_LANE,
      parameters: { registerNaturalness: 'Formal liturgical register' },
    }))
    expect(res.status).toBe(200)
    // The approval page must name the LANE, or a human cannot tell a one-lane
    // write from a project-wide one.
    expect(body.summary.laneId).toBe(ES_LANE)
    expect(
      body.summary.settingsChanges[`${BRIEF_BY_LANE_SETTINGS_KEY}.${ES_LANE}.registerNaturalness`],
    ).toContain('Formal liturgical')
    expect(body.summary.settingsChanges['translationBrief.registerNaturalness']).toBeUndefined()

    const { res: commitRes } = await commit(env, maintainer.token, body.changeset.id)
    expect(commitRes.status).toBe(200)

    // The project's brief is byte-for-byte what the human left.
    expect(await storedBrief(tdb)).toEqual(seededBrief())

    // The lane's own copy carries the project's answers PLUS the new section:
    // customizing a lane copies, it does not blank the unnamed sections.
    const lane = (await storedLaneBrief(tdb, ES_LANE))!
    expect(lane.parameters).toEqual({
      purpose: 'Liturgical reading',
      literalness: 'Meaning-based',
      registerNaturalness: 'Formal liturgical register',
    })
    expect(lane.freeformNotes).toBe('Keep verse numbers.')
    expect(lane.updatedBy).toBe(maintainer.username)
  })

  it('leaves every other lane inheriting the project brief', async () => {
    const env = makeEnv(tdb.db)
    const maintainer = await memberToken(tdb, 600)
    await seedLanes()
    await seedSettings(tdb, { targetLanguage: 'fr', [BRIEF_SETTINGS_KEY]: seededBrief() })

    const { body } = await prepare(env, maintainer.token, setBrief({
      laneId: ES_LANE,
      parameters: { purpose: 'Spanish-only purpose' },
    }))
    await commit(env, maintainer.token, body.changeset.id)

    expect(await storedLaneBrief(tdb, FR_LANE)).toBeUndefined()
    expect((await storedBrief(tdb))!.parameters.purpose).toBe('Liturgical reading')
  })

  it('a second lane write keeps the first lane’s brief', async () => {
    const env = makeEnv(tdb.db)
    const maintainer = await memberToken(tdb, 600)
    await seedLanes()

    const { body: first } = await prepare(env, maintainer.token, setBrief({
      laneId: ES_LANE,
      parameters: { purpose: 'Spanish purpose' },
    }))
    const { body: firstReceipt } = await commit(env, maintainer.token, first.changeset.id)

    // The per-lane map is ONE settings key, so a second lane's write resends
    // the whole map — this is the regression guard that it carries the first
    // lane across instead of replacing it.
    const { body: second } = await prepare(env, maintainer.token, setBrief({
      laneId: FR_LANE,
      parameters: { purpose: 'French purpose' },
    }, firstReceipt.receipt.version))
    const { res } = await commit(env, maintainer.token, second.changeset.id)
    expect(res.status).toBe(200)

    expect((await storedLaneBrief(tdb, ES_LANE))!.parameters.purpose).toBe('Spanish purpose')
    expect((await storedLaneBrief(tdb, FR_LANE))!.parameters.purpose).toBe('French purpose')
  })

  it('without laneId the write still lands on the project brief', async () => {
    const env = makeEnv(tdb.db)
    const maintainer = await memberToken(tdb, 600)
    await seedLanes()

    const { body } = await prepare(env, maintainer.token, setBrief({
      parameters: { purpose: 'Project purpose' },
    }))
    expect(body.summary.laneId).toBeUndefined()
    expect(body.summary.settingsChanges['translationBrief.purpose']).toBe('Project purpose')
    await commit(env, maintainer.token, body.changeset.id)

    expect((await storedBrief(tdb))!.parameters.purpose).toBe('Project purpose')
    expect(await storedLaneBrief(tdb, ES_LANE)).toBeUndefined()
  })

  it('refuses a language, a legacy tag, a source lane and an unknown id', async () => {
    const env = makeEnv(tdb.db)
    const maintainer = await memberToken(tdb, 600)
    const { sourceLaneId } = await seedLanes()

    for (const laneId of ['es', 'Spanish', 'c3c3c3c3']) {
      const { res, body } = await prepare(env, maintainer.token, setBrief({
        laneId,
        parameters: { purpose: 'x' },
      }))
      expect(res.status, `laneId ${laneId}`).toBe(400)
      expect(body.error.code).toBe('validation_failed')
    }

    // A source lane is visible but is not a target — say so rather than
    // claiming it does not exist.
    const { res, body } = await prepare(env, maintainer.token, setBrief({
      laneId: sourceLaneId,
      parameters: { purpose: 'x' },
    }))
    expect(res.status).toBe(400)
    expect(body.error.message).toContain('must name a target lane')

    // Nothing was staged by any of them.
    expect(await tdb.rows('changesets')).toHaveLength(0)
  })

  it('refuses an archived lane', async () => {
    const env = makeEnv(tdb.db)
    const maintainer = await memberToken(tdb, 600)
    await seedLanes()
    await tdb.pg.query(`UPDATE lanes SET archived_at = now() WHERE id = $1`, [ES_LANE])

    const { res, body } = await prepare(env, maintainer.token, setBrief({
      laneId: ES_LANE,
      parameters: { purpose: 'x' },
    }))
    expect(res.status).toBe(400)
    expect(body.error.message).toContain('archived')
  })

  it('a project write does NOT supersede a pending lane write for the same text', async () => {
    const env = makeEnv(tdb.db)
    const maintainer = await memberToken(tdb, 600)
    await seedLanes()

    const { body: prep } = await prepare(env, maintainer.token, setBrief({
      laneId: ES_LANE,
      parameters: { purpose: 'agent text' },
    }))

    // A human lands the identical text on the PROJECT brief. The lane still
    // has no copy, so the plan's work is not done — reading the project's
    // brief here would wrongly report it satisfied and drop the write.
    const human = seededBrief()
    human.parameters = { ...human.parameters, purpose: 'agent text' }
    await tdb.db
      .prepare(`UPDATE project_settings SET version = 2, updated_by = 99, settings = ? WHERE project_id = ?`)
      .bind(JSON.stringify({ targetLanguage: 'fr', [BRIEF_SETTINGS_KEY]: human }), PROJECT)
      .run()

    const { res, body } = await commit(env, maintainer.token, prep.changeset.id)
    expect(res.status).toBe(409)
    expect(body.error.details.status).toBe('stale')
  })
})

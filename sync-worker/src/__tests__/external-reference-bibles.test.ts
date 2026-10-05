// AQU-1573: choosing a reference Bible per target language through the Agent
// API, and discovering which Bibles exist.
//
// The registry checks only the SHAPE of `referenceBibleVersions`; prepare must
// also refuse a Bible this server does not have and a lane the project does
// not have, judged against the settings as the same write leaves them —
// otherwise an agent's typo parks a setting that silently does nothing in a
// human's approval queue. The discovery read (REST + MCP) is how the agent
// learns the ids instead of guessing.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// commit.ts → events/route.ts → broadcast.ts → partyserver (cloudflare:*).
vi.mock('partyserver', () => ({
  getServerByName: vi.fn().mockResolvedValue({
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  }),
}))

import { handleExternalChangesetsRequest } from '../external/changesets-route'
import { handleExternalReadRequest } from '../external/read-routes'
import { handleExternalMcpRequest } from '../external/mcp-route'
import { mintApiToken } from '../../../db/shared/api-credentials'
import { describeCommand } from '../../../db/shared/command-catalog'
import { installFixtureReferenceBibles } from '../../../db/shared/reference-bible-fixtures'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'

const SECRET = 'test-secret'
const PROJECT = 'proj-sermons'

function makeEnv(db: AquillaDb) {
  return { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET, BASE_URL: 'https://aquilla.app' }
}

let tdb: TestDb
let nextUserId = 700
let nextCred = 0

async function memberToken(level: number): Promise<{ token: string; userId: number }> {
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

/** An ordinary unscoped token for a user who is not a member of PROJECT. */
async function outsiderToken(): Promise<string> {
  const userId = nextUserId++
  await tdb.pg.query(
    `INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, 'h')`,
    [userId, `u${userId}`, `u${userId}@x.com`],
  )
  const { token, tokenHash, tokenPrefix } = await mintApiToken()
  await tdb.pg.query(
    `INSERT INTO api_credentials (id, user_id, name, token_prefix, token_hash, mode, org_id, project_id)
     VALUES ($1, $2, 'test', $3, $4, 'act', NULL, NULL)`,
    [`00000000-0000-0000-0000-${String(++nextCred).padStart(12, '0')}`, String(userId), tokenPrefix, tokenHash],
  )
  return token
}

async function prepare(token: string, command: Record<string, unknown>) {
  const res = (await handleExternalChangesetsRequest(
    new Request(`https://w/api/v1/external/projects/${PROJECT}/changesets`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands: [command] }),
    }),
    makeEnv(tdb.db),
  ))!
  return { res, body: (await res.json()) as any }
}

async function commit(token: string, id: string) {
  const res = (await handleExternalChangesetsRequest(
    new Request(`https://w/api/v1/external/projects/${PROJECT}/changesets/${id}/commit`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` },
    }),
    makeEnv(tdb.db),
  ))!
  return { res, body: (await res.json()) as any }
}

function patch(ops: { key: string; value: unknown }[]) {
  return { kind: 'PatchSettings', projectId: PROJECT, ops, ifMatchVersion: 1 }
}

async function storedSettings(): Promise<Record<string, unknown>> {
  const rows = await tdb.rows<{ settings: string }>('project_settings')
  return JSON.parse(rows[0].settings) as Record<string, unknown>
}

beforeEach(async () => {
  nextUserId = 700
  nextCred = 0
  tdb = await makeTestDb({
    projects: [{ id: PROJECT, name: 'Sermons', created_by: 99, org_id: null }],
    project_settings: [{
      project_id: PROJECT,
      // LOTE's shape: Arabic is the default lane, with an extra English lane.
      settings: JSON.stringify({ sourceLanguage: 'English', targetLanguage: 'Arabic', targetLanes: ['Arabic', 'en'] }),
      version: 1,
      updated_by: 99,
      updated_at: new Date().toISOString(),
    }],
  })
  await installFixtureReferenceBibles(tdb.db)
})

describe('PatchSettings referenceBibleVersions', () => {
  it('a lane map naming installed Bibles prepares and lands as written', async () => {
    const maintainer = await memberToken(600)
    const value = { '': 'arb-vandyck', en: 'eng-kjv' }
    const { res, body } = await prepare(maintainer.token, patch([{ key: 'referenceBibleVersions', value }]))
    expect(res.status).toBe(200)
    expect(body.summary.settingsChanges.referenceBibleVersions).toContain('arb-vandyck')
    const { res: committed } = await commit(maintainer.token, body.changeset.id)
    expect(committed.status).toBe(200)
    const stored = await storedSettings()
    expect(stored.referenceBibleVersions).toEqual(value)
    // Untouched keys survive the field-scoped write.
    expect(stored.targetLanes).toEqual(['Arabic', 'en'])
  })

  it("accepts the ticket's one-item array form", async () => {
    const maintainer = await memberToken(600)
    const { res } = await prepare(maintainer.token, patch([{ key: 'referenceBibleVersions', value: ['arb-vandyck'] }]))
    expect(res.status).toBe(200)
  })

  it('accepts the primary language named as a lane key (it means the default lane)', async () => {
    const maintainer = await memberToken(600)
    const { res } = await prepare(maintainer.token, patch([{ key: 'referenceBibleVersions', value: { Arabic: 'arb-vandyck' } }]))
    expect(res.status).toBe(200)
  })

  it('accepts {} and null (clear every lane)', async () => {
    const maintainer = await memberToken(600)
    expect((await prepare(maintainer.token, patch([{ key: 'referenceBibleVersions', value: {} }]))).res.status).toBe(200)
    expect((await prepare(maintainer.token, patch([{ key: 'referenceBibleVersions', value: null }]))).res.status).toBe(200)
  })

  it('refuses a Bible that is not installed, listing the installed ids and how to discover them', async () => {
    const maintainer = await memberToken(600)
    const { res, body } = await prepare(maintainer.token, patch([{ key: 'referenceBibleVersions', value: ['arb-nav'] }]))
    expect(res.status).toBe(400)
    expect(body.error.code).toBe('validation_failed')
    expect(body.error.message).toContain('"arb-nav"')
    expect(body.error.message).toContain('arb-vandyck')
    expect(body.error.message).toContain('eng-kjv')
    expect(body.error.message).toContain('list_reference_bibles')
    expect(await tdb.rows('changesets')).toHaveLength(0)
  })

  it('refuses a key that is not a lane of the project, naming the lanes it has', async () => {
    const maintainer = await memberToken(600)
    const { res, body } = await prepare(maintainer.token, patch([{ key: 'referenceBibleVersions', value: { fr: 'arb-vandyck' } }]))
    expect(res.status).toBe(400)
    expect(body.error.code).toBe('validation_failed')
    expect(body.error.message).toContain('"fr" is not a lane')
    expect(body.error.message).toContain('"en"')
    expect(await tdb.rows('changesets')).toHaveLength(0)
  })

  it('refuses two keys for the same lane', async () => {
    const maintainer = await memberToken(600)
    const { res, body } = await prepare(
      maintainer.token,
      patch([{ key: 'referenceBibleVersions', value: { '': 'arb-vandyck', Arabic: 'eng-kjv' } }]),
    )
    expect(res.status).toBe(400)
    expect(body.error.message).toContain('same lane')
  })

  it('a lane registered in the same write may be given a Bible', async () => {
    const maintainer = await memberToken(600)
    const { res } = await prepare(maintainer.token, patch([
      { key: 'targetLanes', value: ['Arabic', 'en', 'fr'] },
      { key: 'referenceBibleVersions', value: { fr: 'eng-kjv' } },
    ]))
    expect(res.status).toBe(200)
  })

  it('refuses a second Bible in the array form at shape validation', async () => {
    const maintainer = await memberToken(600)
    const { res, body } = await prepare(
      maintainer.token,
      patch([{ key: 'referenceBibleVersions', value: ['arb-vandyck', 'eng-kjv'] }]),
    )
    expect(res.status).toBe(400)
    expect(body.error.code).toBe('validation_failed')
    expect(JSON.stringify(body.error)).toContain('one Bible per lane')
  })

  it('needs MAINTAINER like every other non-language key', async () => {
    const lead = await memberToken(500)
    const { res } = await prepare(lead.token, patch([{ key: 'referenceBibleVersions', value: ['arb-vandyck'] }]))
    expect(res.status).toBe(403)
  })

  it('works whatever bibleResourcesEnabled says (independent switch)', async () => {
    await tdb.pg.query(
      `UPDATE project_settings SET settings = $1 WHERE project_id = $2`,
      [JSON.stringify({ targetLanguage: 'Arabic', targetLanes: ['Arabic'], bibleResourcesEnabled: false }), PROJECT],
    )
    const maintainer = await memberToken(600)
    const { res } = await prepare(maintainer.token, patch([{ key: 'referenceBibleVersions', value: ['arb-vandyck'] }]))
    expect(res.status).toBe(200)
  })

  it('describe_command("PatchSettings") documents the key, its shape and the discovery read', () => {
    const doc = describeCommand('PatchSettings')!.paramsDoc
    expect(doc).toContain('`referenceBibleVersions: { [laneTag]: versionId } | [versionId]`')
    expect(doc).toContain('list_reference_bibles')
    expect(doc).toContain('GET /api/v1/external/reference-bibles')
  })
})

describe('ProjectSetup settings.referenceBibleVersions', () => {
  it('names the field when the Bible is not installed', async () => {
    const owner = await memberToken(700)
    const { res, body } = await prepare(owner.token, {
      kind: 'ProjectSetup',
      projectId: PROJECT,
      settings: { referenceBibleVersions: { '': 'arb-svd' } },
    })
    expect(res.status).toBe(400)
    expect(body.error.code).toBe('validation_failed')
    expect(body.error.details.field).toBe('settings.referenceBibleVersions')
    expect(body.error.message).toContain('"arb-svd"')
  })

  it('names the field when the lane does not exist after the plan', async () => {
    const owner = await memberToken(700)
    const { res, body } = await prepare(owner.token, {
      kind: 'ProjectSetup',
      projectId: PROJECT,
      settings: { referenceBibleVersions: { es: 'eng-kjv' } },
    })
    expect(res.status).toBe(400)
    expect(body.error.details.field).toBe('settings.referenceBibleVersions')
  })

  // Review 2026-10-02: the lane check's error names the target language and
  // every lane, so it must not run before the role floor.
  it('a caller without the role gets permission_denied, not the lane list', async () => {
    const callers = [await outsiderToken(), (await memberToken(400)).token]
    for (const token of callers) {
      const { res, body } = await prepare(token, {
        kind: 'ProjectSetup',
        projectId: PROJECT,
        settings: { referenceBibleVersions: { zz: 'arb-vandyck' } },
      })
      expect(res.status).toBe(403)
      expect(body.error.code).toBe('permission_denied')
      const text = JSON.stringify(body)
      expect(text).not.toContain('Arabic')
      expect(text).not.toContain('Lanes')
    }
  })

  it('a caller without the role is not shown the current policy values either', async () => {
    await tdb.pg.query(`UPDATE project_settings SET settings = $1 WHERE project_id = $2`, [
      JSON.stringify({ sourceLanguage: 'English', targetLanguage: 'Arabic', targetLanes: ['Arabic', 'en'], validationCount: 3 }),
      PROJECT,
    ])
    const { res, body } = await prepare(await outsiderToken(), {
      kind: 'ProjectSetup',
      projectId: PROJECT,
      settings: { validationCount: 1 },
    })
    expect(res.status).toBe(403)
    expect(body.error.message).toBe('insufficient project role to stage this project setup')
    expect(JSON.stringify(body)).not.toContain('loosening')
  })

  it('stages a valid choice, including one for a lane the same plan registers', async () => {
    const owner = await memberToken(700)
    const { res, body } = await prepare(owner.token, {
      kind: 'ProjectSetup',
      projectId: PROJECT,
      settings: { targetLanes: ['Arabic', 'en', 'es'], referenceBibleVersions: { '': 'arb-vandyck', es: 'eng-kjv' } },
    })
    expect(res.status).toBe(200)
    expect(body.summary.settingsChanges.referenceBibleVersions).toContain('arb-vandyck')
  })
})

describe('GET /api/v1/external/reference-bibles', () => {
  async function read(token: string | null) {
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {}
    const res = (await handleExternalReadRequest(
      new Request('https://w/api/v1/external/reference-bibles', { headers }),
      makeEnv(tdb.db),
    ))!
    return { res, body: (await res.json()) as any }
  }

  it('401 without a credential', async () => {
    const { res, body } = await read(null)
    expect(res.status).toBe(401)
    expect(body.error.code).toBe('permission_denied')
  })

  it('lists every installed Bible for any valid credential, no project role needed', async () => {
    const viewer = await memberToken(100)
    const { res, body } = await read(viewer.token)
    expect(res.status).toBe(200)
    expect(body.nextCursor).toBeNull()
    const ids = body.data.map((v: { id: string }) => v.id)
    expect(ids).toEqual(['arb-vandyck', 'eng-kjv'])
    const vd = body.data[0]
    expect(vd).toMatchObject({ name: 'Van Dyck', languageCode: 'ar', languageName: 'Arabic', direction: 'rtl' })
    expect(vd.verseCount).toBeGreaterThan(0)
  })

  it('lists nothing when no Bible is loaded', async () => {
    await tdb.pg.query('DELETE FROM reference_bible_versions')
    const viewer = await memberToken(100)
    const { body } = await read(viewer.token)
    expect(body.data).toEqual([])
  })
})

describe('MCP list_reference_bibles', () => {
  it('returns the same list as REST and points at the setting', async () => {
    const viewer = await memberToken(100)
    const env = makeEnv(tdb.db)
    const call = async (message: unknown) =>
      (await (await handleExternalMcpRequest(
        new Request('https://w/api/v1/external/mcp', {
          method: 'POST',
          headers: { Authorization: `Bearer ${viewer.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(message),
        }),
        env,
      ))!.json()) as any

    const list = await call({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    const tool = list.result.tools.find((t: { name: string }) => t.name === 'list_reference_bibles')
    expect(tool.annotations.readOnlyHint).toBe(true)
    expect(tool.description).toContain('referenceBibleVersions')

    const res = await call({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'list_reference_bibles', arguments: {} },
    })
    expect(res.result.isError).not.toBe(true)
    const payload = JSON.parse(res.result.content[0].text)
    expect(payload.versions.map((v: { id: string }) => v.id)).toEqual(['arb-vandyck', 'eng-kjv'])
  })
})

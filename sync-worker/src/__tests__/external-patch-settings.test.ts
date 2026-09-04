// Tests for PatchSettings (AQU-926, command registry §2): field-scoped
// settings writes through the changeset engine — per-key role floors (incl.
// the org termbaseEditMinRole floor for `terminology`), the hard policy-key
// denial, version pinning (plan_stale on drift at prepare AND commit), and the
// top-level-key replace merge (untouched keys survive; the shared module's
// version bump semantics hold).

import { describe, it, expect, vi, beforeEach } from 'vitest'

// commit.ts → events/route.ts → broadcast.ts → partyserver (cloudflare:*).
vi.mock('partyserver', () => ({
  getServerByName: vi.fn().mockResolvedValue({
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  }),
}))

import { handleExternalChangesetsRequest } from '../external/changesets-route'
import { handleExternalReadRequest } from '../external/read-routes'
import { POLICY_SETTINGS_KEYS } from '../external/commands-patch-settings'
import { mintApiToken } from '../../../db/shared/api-credentials'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'

const SECRET = 'test-secret'
const PROJECT = 'proj-p'
const ORG_ID = 77

function makeEnv(db: AquillaDb) {
  return { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET, BASE_URL: 'https://aquilla.app' }
}

let nextUserId = 500
let nextCred = 0

/** Seed a user + project membership at `level` and mint an act-mode credential
 *  scoped to PROJECT. */
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

function prepareReq(token: string, body: unknown): Request {
  return new Request(`https://w/api/v1/external/projects/${PROJECT}/changesets`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function prepare(env: ReturnType<typeof makeEnv>, token: string, commands: unknown) {
  const res = (await handleExternalChangesetsRequest(prepareReq(token, { commands }), env))!
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

function patchCmd(ops: { key: string; value: unknown }[], ifMatchVersion = 1) {
  return [{ kind: 'PatchSettings', projectId: PROJECT, ops, ifMatchVersion }]
}

let tdb: TestDb
beforeEach(async () => {
  nextUserId = 500
  tdb = await makeTestDb({
    organizations: [{ id: ORG_ID, name: 'Org', owner_user_id: 1 }],
    projects: [{ id: PROJECT, name: 'P', created_by: 99, org_id: ORG_ID }],
    project_settings: [{
      project_id: PROJECT,
      settings: JSON.stringify({ targetLanguage: 'fr', terminology: { concepts: [] }, validationCount: 3 }),
      version: 1,
      updated_by: 99,
      updated_at: new Date().toISOString(),
    }],
  })
})

describe('PatchSettings — per-key floors', () => {
  it('a non-terminology key requires MAINTAINER (600): project_lead denied, maintainer allowed', async () => {
    const env = makeEnv(tdb.db)
    const lead = await memberToken(tdb, 500)
    const { res: deniedRes, body: denied } = await prepare(env, lead.token, patchCmd([
      { key: 'targetLanes', value: ['es', 'pt'] },
    ]))
    expect(deniedRes.status).toBe(403)
    expect(denied.error.code).toBe('permission_denied')

    const maintainer = await memberToken(tdb, 600)
    const { res, body } = await prepare(env, maintainer.token, patchCmd([
      { key: 'targetLanes', value: ['es', 'pt'] },
    ]))
    expect(res.status).toBe(200)
    expect(body.summary.command).toBe('PatchSettings')
    expect(body.summary.settingsChanges.targetLanes).toContain('es')

    const { res: commitRes, body: committed } = await commit(env, maintainer.token, body.changeset.id)
    expect(commitRes.status).toBe(200)
    expect(committed.receipt.command).toBe('PatchSettings')
    expect(committed.receipt.version).toBe(2)

    // Merge semantics: patched key replaced, untouched keys survive.
    const rows = await tdb.rows<{ settings: string; version: number }>('project_settings')
    const stored = JSON.parse(rows[0].settings)
    expect(stored.targetLanes).toEqual(['es', 'pt'])
    expect(stored.targetLanguage).toBe('fr')
    expect(stored.validationCount).toBe(3)
    expect(rows[0].version).toBe(2)
  })

  it('terminology uses the org default floor 500: project_lead allowed, contributor denied', async () => {
    const env = makeEnv(tdb.db)
    const contributor = await memberToken(tdb, 400)
    const { res: deniedRes } = await prepare(env, contributor.token, patchCmd([
      { key: 'terminology', value: { concepts: [{ term: 'grace' }] } },
    ]))
    expect(deniedRes.status).toBe(403)

    const lead = await memberToken(tdb, 500)
    const { res, body } = await prepare(env, lead.token, patchCmd([
      { key: 'terminology', value: { concepts: [{ term: 'grace' }] } },
    ]))
    expect(res.status).toBe(200)
    const { res: commitRes } = await commit(env, lead.token, body.changeset.id)
    expect(commitRes.status).toBe(200)
  })

  it('an org termbaseEditMinRole override lowers the terminology floor', async () => {
    const env = makeEnv(tdb.db)
    await tdb.pg.query(
      `INSERT INTO org_settings (org_id, settings, version) VALUES ($1, $2, 1)`,
      [ORG_ID, JSON.stringify({ termbaseEditMinRole: 400 })],
    )
    const contributor = await memberToken(tdb, 400)
    const { res, body } = await prepare(env, contributor.token, patchCmd([
      { key: 'terminology', value: { concepts: [] } },
    ]))
    expect(res.status).toBe(200)
    const { res: commitRes } = await commit(env, contributor.token, body.changeset.id)
    expect(commitRes.status).toBe(200)
  })

  it('mixing terminology with another key takes the max floor (600)', async () => {
    const env = makeEnv(tdb.db)
    const lead = await memberToken(tdb, 500)
    const { res } = await prepare(env, lead.token, patchCmd([
      { key: 'terminology', value: {} },
      { key: 'brief', value: 'x' },
    ]))
    expect(res.status).toBe(403)
  })
})

describe('PatchSettings — policy-key denial', () => {
  it.each(POLICY_SETTINGS_KEYS.map((k) => [k]))('rejects %s even for an owner', async (key) => {
    const env = makeEnv(tdb.db)
    const owner = await memberToken(tdb, 700)
    const { res, body } = await prepare(env, owner.token, patchCmd([{ key, value: 1 }]))
    expect(res.status).toBe(403)
    expect(body.error.code).toBe('permission_denied')
    expect(body.error.details.policyKeys).toEqual([key])
    expect(await tdb.rows('changesets')).toHaveLength(0)
  })
})

describe('UpdateProjectSettings — policy guard re-check at commit (AQU-926)', () => {
  it('a policy value changed under the pinned version between prepare and commit → permission_denied, approval not consumed', async () => {
    const env = makeEnv(tdb.db)
    const maintainer = await memberToken(tdb, 600)

    // Whole-blob replace carrying the CURRENT policy values (pass-through) —
    // prepare's guard passes.
    const res1 = (await handleExternalChangesetsRequest(prepareReq(maintainer.token, {
      commands: [{
        kind: 'UpdateProjectSettings',
        projectId: PROJECT,
        settings: { targetLanguage: 'de', terminology: { concepts: [] }, validationCount: 3 },
        ifMatchVersion: 1,
      }],
    }), env))!
    const prep = (await res1.json()) as any
    expect(res1.status).toBe(200)

    // Simulate an out-of-band policy edit that did NOT move the version (e.g.
    // a plan staged before the guard deployed, or direct DB surgery): the
    // commit-time re-check against the LIVE blob must refuse — committing the
    // staged blob would silently revert validationCount 5 → 3.
    await tdb.db
      .prepare(`UPDATE project_settings SET settings = ? WHERE project_id = ?`)
      .bind(JSON.stringify({ targetLanguage: 'fr', terminology: { concepts: [] }, validationCount: 5 }), PROJECT)
      .run()

    const { res, body } = await commit(env, maintainer.token, prep.changeset.id)
    expect(res.status).toBe(403)
    expect(body.error.code).toBe('permission_denied')
    expect(body.error.details.policyKeys).toEqual(['validationCount'])
    // The write did not land; the changeset is still staged (recoverable).
    const rows = await tdb.rows<{ version: number }>('project_settings')
    expect(rows[0].version).toBe(1)
    const cs = await tdb.rows<{ status: string }>('changesets')
    expect(cs[0].status).toBe('staged')
  })
})

// AQU-1176: GET .../settings is the read that makes ifMatchVersion usable —
// this is the whole loop an agent actually runs (read the live version, patch
// ONE key with it, commit) asserted end to end.
describe('PatchSettings — read-then-patch round trip', () => {
  it('patching one key with the version from GET /settings leaves every other key byte-identical', async () => {
    const env = makeEnv(tdb.db)
    const maintainer = await memberToken(tdb, 600)

    const readRes = (await handleExternalReadRequest(
      new Request(`https://w/api/v1/external/projects/${PROJECT}/settings`, {
        headers: { Authorization: `Bearer ${maintainer.token}` },
      }),
      env,
    ))!
    expect(readRes.status).toBe(200)
    const before = (await readRes.json()) as {
      settings: Record<string, unknown>
      version: number
    }

    const { res, body } = await prepare(
      env,
      maintainer.token,
      patchCmd([{ key: 'brief', value: 'Translate plainly.' }], before.version),
    )
    expect(res.status).toBe(200)
    const { res: commitRes } = await commit(env, maintainer.token, body.changeset.id)
    expect(commitRes.status).toBe(200)

    const afterRes = (await handleExternalReadRequest(
      new Request(`https://w/api/v1/external/projects/${PROJECT}/settings`, {
        headers: { Authorization: `Bearer ${maintainer.token}` },
      }),
      env,
    ))!
    const after = (await afterRes.json()) as {
      settings: Record<string, unknown>
      version: number
    }

    expect(after.settings.brief).toBe('Translate plainly.')
    expect(after.version).toBe(before.version + 1)
    // Byte-identical for everything the ops did not name.
    for (const key of Object.keys(before.settings)) {
      expect(JSON.stringify(after.settings[key]), key).toBe(JSON.stringify(before.settings[key]))
    }
  })

  it('a stale ifMatchVersion (guessed instead of read) is rejected, not applied', async () => {
    const env = makeEnv(tdb.db)
    const maintainer = await memberToken(tdb, 600)
    const { res, body } = await prepare(
      env,
      maintainer.token,
      patchCmd([{ key: 'brief', value: 'nope' }], 99),
    )
    expect(res.status).toBe(409)
    expect(body.error.code).toBe('plan_stale')
    const rows = await tdb.rows<{ settings: string }>('project_settings')
    expect(JSON.parse(rows[0].settings).brief).toBeUndefined()
  })
})

describe('PatchSettings — version guard', () => {
  it('version drift at prepare → plan_stale, nothing staged', async () => {
    const env = makeEnv(tdb.db)
    const maintainer = await memberToken(tdb, 600)
    const { res, body } = await prepare(env, maintainer.token, patchCmd([{ key: 'brief', value: 'b' }], 5))
    expect(res.status).toBe(409)
    expect(body.error.code).toBe('plan_stale')
    expect(await tdb.rows('changesets')).toHaveLength(0)
  })

  it('drift between prepare and commit → plan_stale + status stale', async () => {
    const env = makeEnv(tdb.db)
    const maintainer = await memberToken(tdb, 600)
    const { body: prep } = await prepare(env, maintainer.token, patchCmd([{ key: 'brief', value: 'b' }]))

    await tdb.db
      .prepare(`UPDATE project_settings SET version = 2 WHERE project_id = ?`)
      .bind(PROJECT)
      .run()

    const { res, body } = await commit(env, maintainer.token, prep.changeset.id)
    expect(res.status).toBe(409)
    expect(body.error.code).toBe('plan_stale')
    const cs = await tdb.rows<{ status: string }>('changesets')
    expect(cs[0].status).toBe('stale')
  })

  it('sole-command rule: PatchSettings cannot ride with another command', async () => {
    const env = makeEnv(tdb.db)
    const maintainer = await memberToken(tdb, 600)
    const { res, body } = await prepare(env, maintainer.token, [
      ...patchCmd([{ key: 'brief', value: 'b' }]),
      { kind: 'SetTranslation', fileId: 'f', cellId: 'c', value: 'v' },
    ])
    expect(res.status).toBe(400)
    expect(body.error.code).toBe('validation_failed')
  })

  it('duplicate op keys are rejected at validation', async () => {
    const env = makeEnv(tdb.db)
    const maintainer = await memberToken(tdb, 600)
    const { res, body } = await prepare(env, maintainer.token, patchCmd([
      { key: 'brief', value: 'a' },
      { key: 'brief', value: 'b' },
    ]))
    expect(res.status).toBe(400)
    expect(body.error.code).toBe('validation_failed')
  })
})

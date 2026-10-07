// AQU-1532 regression: an Agent API write whose laneId names the project's
// primary target language returned 500 "DB batch failed".
//
// AQU-1594: CreateProject writes a target lane tagged with the language. It does
// not write `legacy_tag ''`. PatchSettings of sourceLanguage / targetLanguage /
// targetLanes creates the rows that are not already there, in the same batch,
// and a second insert of the same tags must not duplicate them. A write that
// names that tag lands on the lane. A write that omits laneId still addresses
// `''` (canonicalLaneId) and fails on a new project — AQU-1615.
//
// CI missed the original 500 because the PGlite harness installs a test-only
// trigger that mints any missing lane (db/shared/test-lane-fill.ts). Every test
// here turns that trigger OFF.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// commit.ts → events/route.ts → broadcast.ts → partyserver (cloudflare:*).
vi.mock('partyserver', () => ({
  getServerByName: vi.fn().mockResolvedValue({
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  }),
}))

import { handleExternalChangesetsRequest } from '../external/changesets-route'
import { handleEventsWriteRequest } from '../events/route'
import { mintApiToken } from '../../../db/shared/api-credentials'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'
import { makeTestToken } from './helpers/auth'
import type { RawEvent } from '../events/types'

const SECRET = 'test-secret'
const ORG_ID = 10
const PROJECT = 'lane-proj'
const CRED = '00000000-0000-0000-0000-0000000015a2'

interface ErrorBody {
  error: { code: string; message: string }
}
interface PrepareBody {
  changeset: { id: string; status: string; autonomyMode: string }
  digest: string
}
interface CommitBody {
  receipt: { fileId?: string; appliedCount?: number; warnings?: { code: string; message: string }[] }
}
interface EventsBody {
  accepted: { id: string }[]
  rejected: { id: string; status: number; reason: string }[]
}

function makeEnv(db: AquillaDb) {
  return { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET, BASE_URL: 'https://aquilla.app' }
}

let tdb: TestDb
let env: ReturnType<typeof makeEnv>
let token: string

beforeEach(async () => {
  tdb = await makeTestDb({
    organizations: [{ id: ORG_ID, name: 'Org', owner_user_id: 1 }],
  })
  // Production has no lane-minting trigger; neither does this suite.
  await tdb.pg.query(`SELECT set_config('aquilla.test_lane_fill', 'off', false)`)
  await tdb.pg.query(
    `INSERT INTO users (id, username, email, password_hash) VALUES (1, 'alice', 'alice@x.com', 'h')`,
  )
  await tdb.pg.query(`INSERT INTO org_members (org_id, user_id, role_level) VALUES ($1, 1, 600)`, [ORG_ID])
  const minted = await mintApiToken()
  await tdb.pg.query(
    `INSERT INTO api_credentials (id, user_id, name, token_prefix, token_hash, mode, org_id, project_id)
     VALUES ($1, '1', 'test', $2, $3, 'act', $4, NULL)`,
    [CRED, minted.tokenPrefix, minted.tokenHash, String(ORG_ID)],
  )
  token = minted.token
  env = makeEnv(tdb.db)
})

function changesetsUrl(): string {
  return `https://w/api/v1/external/projects/${PROJECT}/changesets`
}

async function prepare(commands: unknown[]): Promise<{ status: number; body: PrepareBody & ErrorBody }> {
  const res = (await handleExternalChangesetsRequest(
    new Request(changesetsUrl(), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands }),
    }),
    env,
  ))!
  return { status: res.status, body: (await res.json()) as PrepareBody & ErrorBody }
}

/** Commit a staged changeset, seeding the human approval an ask-mode plan needs. */
async function commit(prep: PrepareBody): Promise<{ status: number; body: CommitBody & ErrorBody }> {
  if (prep.changeset.autonomyMode === 'ask') {
    await tdb.db
      .prepare(
        `INSERT INTO changeset_confirmations (id, changeset_id, user_id, credential_id, digest, expires_at, consumed_at)
         VALUES (?, ?, '1', ?, ?, ?, NULL)`,
      )
      .bind(`conf-${prep.changeset.id}`, prep.changeset.id, CRED, prep.digest, new Date(Date.now() + 60_000).toISOString())
      .run()
  }
  const res = (await handleExternalChangesetsRequest(
    new Request(`${changesetsUrl()}/${prep.changeset.id}/commit`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    }),
    env,
  ))!
  return { status: res.status, body: (await res.json()) as CommitBody & ErrorBody }
}

/** Prepare + commit; both must succeed. */
async function apply(commands: unknown[]): Promise<CommitBody> {
  const prep = await prepare(commands)
  expect(prep.status, JSON.stringify(prep.body)).toBe(200)
  const done = await commit(prep.body)
  expect(done.status, JSON.stringify(done.body)).toBe(200)
  return done.body
}

/**
 * The agent's setup sequence. Returns the imported file and its first cell.
 * `variants` rides on the first PlanImport cell when given.
 */
async function setUpProject(
  targetLanguage: string,
  targetLanes: string[],
  variants?: { laneId: string; content: string }[],
): Promise<{ fileId: string; cellId: string }> {
  await apply([
    { kind: 'CreateProject', name: 'Lane Project', orgId: ORG_ID, sourceLanguage: 'en', targetLanguage },
  ])
  const { rows } = await tdb.pg.query<{ version: number }>(
    `SELECT version FROM project_settings WHERE project_id = $1`,
    [PROJECT],
  )
  await apply([
    {
      kind: 'PatchSettings',
      projectId: PROJECT,
      ops: [{ key: 'targetLanes', value: targetLanes }],
      ifMatchVersion: rows[0]?.version ?? 0,
    },
  ])
  const imported = await apply([
    {
      kind: 'PlanImport',
      fileName: 'gen.txt',
      fileType: 'txt',
      cells: [
        { content: 'In the beginning', ...(variants ? { variants } : {}) },
        { content: 'And the earth' },
      ],
    },
  ])
  const fileId = imported.receipt.fileId!
  const source = await tdb.pg.query<{ cell_id: string }>(
    `SELECT cell_id FROM cells WHERE project_id = $1 AND file_id = $2 AND side = 'source'
      ORDER BY sequence_index LIMIT 1`,
    [PROJECT, fileId],
  )
  return { fileId, cellId: source.rows[0].cell_id }
}

async function targetRows(): Promise<{ target_lang: string; value: string; lane_id: string; legacy_tag: string }[]> {
  const { rows } = await tdb.pg.query<{ target_lang: string; value: string; lane_id: string; legacy_tag: string }>(
    `SELECT c.target_lang, c.value, c.lane_id, l.legacy_tag
       FROM cells c JOIN lanes l ON l.id = c.lane_id
      WHERE c.project_id = $1 AND c.side = 'target'
      ORDER BY c.target_lang, c.value`,
    [PROJECT],
  )
  return rows
}

async function setTranslation(fileId: string, cellId: string, value: string, laneId?: string) {
  const prep = await prepare([
    { kind: 'SetTranslation', fileId, cellId, value, ...(laneId !== undefined ? { laneId } : {}) },
  ])
  if (prep.status !== 200) return { prepareStatus: prep.status, prep: prep.body, commit: null }
  return { prepareStatus: prep.status, prep: prep.body, commit: await commit(prep.body) }
}

describe('AQU-1532 — SetTranslation laneId naming the primary language (lane-fill trigger off)', () => {
  it('laneId equal to the primary writes the lane tagged with that language', async () => {
    const { fileId, cellId } = await setUpProject('bla', ['bla'])
    const lanes = await tdb.pg.query<{ legacy_tag: string }>(
      `SELECT legacy_tag FROM lanes WHERE project_id = $1 AND role = 'target'`,
      [PROJECT],
    )
    expect(lanes.rows.map((lane) => lane.legacy_tag)).toEqual(['bla'])
    const r = await setTranslation(fileId, cellId, 'primary text', 'bla')
    expect(r.prepareStatus).toBe(200)
    expect(r.commit?.status, JSON.stringify(r.commit?.body)).toBe(200)
    expect(r.commit?.body.receipt.appliedCount).toBe(1)
    expect(await targetRows()).toEqual([
      expect.objectContaining({ target_lang: 'bla', value: 'primary text', legacy_tag: 'bla' }),
    ])
  })

  it('a differently-cased primary ("BLA") is not the tagged lane until AQU-1615', async () => {
    const { fileId, cellId } = await setUpProject('bla', ['bla'])
    const r = await setTranslation(fileId, cellId, 'upper', 'BLA')
    expect(r.prepareStatus).toBe(400)
    expect(r.prep.error.message).toContain('unregistered lane "BLA"')
  })

  it('an unregistered lane is still refused at prepare', async () => {
    const { fileId, cellId } = await setUpProject('bla', ['bla'])
    const r = await setTranslation(fileId, cellId, 'nope', 'bla-x')
    expect(r.prepareStatus).toBe(400)
    expect(r.prep.error.code).toBe('validation_failed')
    expect(r.prep.error.message).toContain('unregistered lane "bla-x"')
  })

  it('omitting laneId still addresses legacy_tag "" and does not land (AQU-1615)', async () => {
    const { fileId, cellId } = await setUpProject('bla', ['bla'])
    const r = await setTranslation(fileId, cellId, 'no lane')
    expect(r.prepareStatus).toBe(200)
    expect(r.commit?.status).toBe(500)
    expect(await targetRows()).toEqual([])
  })

  it('omitting laneId does not share a slot with the tagged primary (AQU-1615)', async () => {
    const { fileId, cellId } = await setUpProject('bla', ['bla'])
    const prep = await prepare([
      { kind: 'SetTranslation', fileId, cellId, value: 'first' },
      { kind: 'SetTranslation', fileId, cellId, value: 'second', laneId: 'bla' },
    ])
    expect(prep.status).toBe(200)
    const done = await commit(prep.body)
    expect(done.status).toBe(500)
    expect(await targetRows()).toEqual([])
  })

  it('a registered non-primary lane writes its own row', async () => {
    const { fileId, cellId } = await setUpProject('bla', ['bla', 'es'])
    const r = await setTranslation(fileId, cellId, 'hola', 'es')
    expect(r.commit?.status, JSON.stringify(r.commit?.body)).toBe(200)
    expect(await targetRows()).toEqual([
      expect.objectContaining({ target_lang: 'es', value: 'hola', legacy_tag: 'es' }),
    ])
  })

  it('a regional lane beside its base primary (fr-CA next to French) gets its own row', async () => {
    const { fileId, cellId } = await setUpProject('French', ['French', 'fr-CA'])
    const lanes = await tdb.pg.query<{ legacy_tag: string }>(
      `SELECT legacy_tag FROM lanes WHERE project_id = $1 AND role = 'target' ORDER BY legacy_tag`,
      [PROJECT],
    )
    expect(lanes.rows.map((l) => l.legacy_tag)).toEqual(['French', 'fr-CA'])

    const r = await setTranslation(fileId, cellId, 'icitte', 'fr-CA')
    expect(r.commit?.status, JSON.stringify(r.commit?.body)).toBe(200)
    expect(await targetRows()).toEqual([
      expect.objectContaining({ target_lang: 'fr-CA', value: 'icitte', legacy_tag: 'fr-CA' }),
    ])
  })

  it('a raw target.cell.commit naming an unknown lane is a 422, not a DB-batch 500', async () => {
    const { fileId, cellId } = await setUpProject('bla', ['bla'])
    const syncToken = await makeTestToken(SECRET, {
      projectId: PROJECT, fileId, userId: 1, username: 'alice', role: 700,
    })
    const ev: RawEvent<'target.cell.commit'> = {
      id: 'raw-unknown-lane-1', schemaVersion: 1, kind: 'target.cell.commit',
      projectId: PROJECT, fileId, cellId, parentId: null,
      author: 'alice', payload: { value: 'stray', targetLang: 'zz-unknown' }, clientTs: 1,
    }
    const res = (await handleEventsWriteRequest(
      new Request('https://w/events', {
        method: 'POST',
        headers: { Authorization: `Bearer ${syncToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ events: [ev] }),
      }),
      env,
    ))!
    const body = (await res.json()) as EventsBody
    expect(body.accepted).toEqual([])
    expect(body.rejected).toEqual([
      { id: 'raw-unknown-lane-1', status: 422, reason: 'unknown lane "zz-unknown"; register it in settings.targetLanes' },
    ])
    expect(await targetRows()).toEqual([])
  })
})

describe('AQU-1532 — PlanImport variants and EmitEvents naming the primary (lane-fill trigger off)', () => {
  it('a PlanImport variant whose laneId is the primary lands in the default lane', async () => {
    await setUpProject('bla', ['bla', 'es'], [
      { laneId: 'bla', content: 'primary variant' },
      { laneId: 'es', content: 'variante' },
    ])
    expect(await targetRows()).toEqual([
      expect.objectContaining({ target_lang: 'bla', value: 'primary variant', legacy_tag: 'bla' }),
      expect.objectContaining({ target_lang: 'es', value: 'variante', legacy_tag: 'es' }),
    ])
  })

  it('an EmitEvents cell.validate naming the primary validates the default lane', async () => {
    const { fileId, cellId } = await setUpProject('bla', ['bla'])
    const written = await setTranslation(fileId, cellId, 'to validate', 'bla')
    expect(written.commit?.status).toBe(200)

    const done = await apply([
      { kind: 'EmitEvents', events: [{ kind: 'cell.validate', fileId, cellId, laneId: 'bla', payload: {} }] },
    ])
    expect(done.receipt.appliedCount).toBe(1)
    const validators = await tdb.pg.query<{ target_lang: string; legacy_tag: string }>(
      `SELECT v.target_lang, l.legacy_tag
         FROM cell_validators v JOIN lanes l ON l.id = v.lane_id
        WHERE v.project_id = $1 AND v.cell_id = $2`,
      [PROJECT, cellId],
    )
    expect(validators.rows).toEqual([{ target_lang: 'bla', legacy_tag: 'bla' }])
  })
})

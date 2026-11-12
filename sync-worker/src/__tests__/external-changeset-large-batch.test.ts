// AQU-1852: a SetTranslation changeset larger than the /events perimeter's
// per-request cap must still apply — and a mid-apply stop must be visible and
// resumable rather than stranding the changeset in `committing`.
//
// What used to happen: commit posted ALL of one file's compiled
// target.cell.commit events in a single internal /events request. The perimeter
// refuses more than MAX_EVENTS_PER_REQUEST (500) with a 413 whose body is
// `{ error }` — no `accepted` key — so `for (const a of out.accepted)` threw,
// the changeset stayed in `committing`, and every retry repeated the failure.
//
// Covered here:
//   1. 600 and 5,000 cells in one file apply fully and the changeset commits.
//   2. A perimeter refusal partway leaves a receipt naming what applied, the
//      changeset in `committing`, and a retry that finishes it without
//      duplicating events.
//   3. Above the documented cap, prepare refuses and stages nothing.
//   4. Prepare for a whole-book batch never binds past the driver's parameter
//      ceiling (the precondition lookup is paged).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// commit.ts → events/route.ts → broadcast.ts → partyserver (cloudflare:*).
vi.mock('partyserver', () => ({
  getServerByName: vi.fn().mockResolvedValue({
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  }),
}))

// A controllable seam over the real perimeter: `refuseAfterChunks` makes the
// (n+1)th write POST answer exactly as the perimeter's own 413 does, so the
// partial-apply path is exercised against a real refusal shape, not a stub.
const perimeter = {
  refuseAfterChunks: Number.POSITIVE_INFINITY,
  calls: 0,
  /** Wall-clock milliseconds each write POST advances the mocked clock by, so a
   *  long apply can be simulated without actually taking minutes. */
  advanceMsPerCall: 0,
  offsetMs: 0,
  /** Every Authorization header the perimeter was handed, in order. */
  tokensSeen: [] as string[],
}
vi.mock('../events/route', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../events/route')>()
  return {
    ...actual,
    handleEventsWriteRequest: async (request: Request, env: unknown, ctx?: unknown) => {
      if (request.method === 'POST' && new URL(request.url).pathname === '/events') {
        perimeter.tokensSeen.push(request.headers.get('Authorization') ?? '')
        perimeter.offsetMs += perimeter.advanceMsPerCall
        if (perimeter.calls >= perimeter.refuseAfterChunks) {
          perimeter.calls++
          return Response.json({ error: 'too many events in one request (9999 > 500)' }, { status: 413 })
        }
        perimeter.calls++
      }
      return actual.handleEventsWriteRequest(
        request,
        env as Parameters<typeof actual.handleEventsWriteRequest>[1],
        ctx as Parameters<typeof actual.handleEventsWriteRequest>[2],
      )
    },
  }
})

import { handleExternalChangesetsRequest } from '../external/changesets-route'
import { SET_TRANSLATION_MAX_COMMANDS } from '../external/commands'
import { mintApiToken } from '../../../db/shared/api-credentials'
import { makeTestDb, DRIVER_MAX_BIND_PARAMS, type TestDb } from './helpers/pg-test-db'

const SECRET = 'test-secret'
const PROJECT = 'proj-big'
const FILE = 'file-big'
const CRED = '00000000-0000-0000-0000-000000001852'
const LANE = 'deflane1'

function makeEnv(db: AquillaDb) {
  return { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET, BASE_URL: 'https://aquilla.app' }
}

/** N source cells in one file — the shape a whole-book batch writes against. */
function sourceCells(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    project_id: PROJECT,
    file_id: FILE,
    cell_id: `cell-${i}`,
    side: 'source' as const,
    value: `source ${i}`,
    event_id: `src-evt-${i}`,
    last_edit_at: 1,
  }))
}

async function seedProject(cellCount: number, opts?: Parameters<typeof makeTestDb>[1]): Promise<TestDb> {
  const tdb = await makeTestDb(
    {
      projects: [{ id: PROJECT, name: 'P', created_by: 99, org_id: null }],
      project_members: [{ project_id: PROJECT, user_id: 1, role_level: 400 }],
      cells: sourceCells(cellCount),
    },
    opts,
  )
  await tdb.pg.query(
    `INSERT INTO lanes (id, project_id, role, legacy_tag, position) VALUES ($1, $2, 'target', '', 1)`,
    [LANE, PROJECT],
  )
  return tdb
}

async function credToken(tdb: TestDb): Promise<string> {
  await tdb.pg.query(
    `INSERT INTO users (id, username, email, password_hash) VALUES (1, 'alice', 'alice@x.com', 'h')
     ON CONFLICT (id) DO NOTHING`,
  )
  const { token, tokenHash, tokenPrefix } = await mintApiToken()
  await tdb.pg.query(
    `INSERT INTO api_credentials (id, user_id, name, token_prefix, token_hash, mode, org_id, project_id)
     VALUES ($1, '1', 'test', $2, $3, 'act', NULL, $4)`,
    [CRED, tokenPrefix, tokenHash, PROJECT],
  )
  return token
}

function setTranslations(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    kind: 'SetTranslation',
    fileId: FILE,
    cellId: `cell-${i}`,
    laneId: LANE,
    value: `translated ${i}`,
  }))
}

async function prepare(env: ReturnType<typeof makeEnv>, token: string, commands: unknown) {
  const req = new Request(`https://w/api/v1/external/projects/${PROJECT}/changesets`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ commands }),
  })
  const res = (await handleExternalChangesetsRequest(req, env))!
  return { res, body: (await res.json()) as any }
}

async function commit(env: ReturnType<typeof makeEnv>, token: string, id: string) {
  const req = new Request(
    `https://w/api/v1/external/projects/${PROJECT}/changesets/${id}/commit`,
    { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
  )
  const res = (await handleExternalChangesetsRequest(req, env))!
  return { res, body: (await res.json()) as any }
}

async function targetCommitCount(tdb: TestDb): Promise<number> {
  const { rows } = await tdb.pg.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM events WHERE kind = 'target.cell.commit'`,
  )
  return Number(rows[0].count)
}

async function changesetStatus(tdb: TestDb, id: string): Promise<string> {
  const { rows } = await tdb.pg.query<{ status: string }>(
    `SELECT status FROM changesets WHERE id = $1`,
    [id],
  )
  return rows[0].status
}

beforeEach(() => {
  perimeter.refuseAfterChunks = Number.POSITIVE_INFINITY
  perimeter.calls = 0
  perimeter.advanceMsPerCall = 0
  perimeter.offsetMs = 0
  perimeter.tokensSeen = []
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('AQU-1852 — a changeset above the perimeter cap applies fully', () => {
  it('600 SetTranslation commands in one file commit, with every event applied', async () => {
    const tdb = await seedProject(600)
    const env = makeEnv(tdb.db)
    const token = await credToken(tdb)

    const { body: prep } = await prepare(env, token, setTranslations(600))
    expect(prep.summary.translationsAdded).toBe(600)

    const { res, body } = await commit(env, token, prep.changeset.id)
    expect(res.status).toBe(200)
    expect(body.receipt.appliedCount).toBe(600)
    expect(body.receipt.eventIds).toHaveLength(600)

    expect(await targetCommitCount(tdb)).toBe(600)
    expect(await changesetStatus(tdb, prep.changeset.id)).toBe('committed')
  })

  // The cap-sized case. Applying 5,000 target commits through the real
  // perimeter against PGlite takes minutes, so it is opt-in rather than a tax
  // on every suite run: `AQU_SLOW_TESTS=1 npx vitest run
  // src/__tests__/external-changeset-large-batch.test.ts`. The 600-cell case
  // above is the standing regression guard (it is already past the perimeter's
  // 500 cap, which is the defect), and the prepare-side 5,000-cell shape is
  // guarded unconditionally by the parameter-ceiling test below.
  it.runIf(process.env.AQU_SLOW_TESTS)(
    'a 5,000-cell changeset (the documented cap) commits in full',
    async () => {
      const tdb = await seedProject(SET_TRANSLATION_MAX_COMMANDS)
      const env = makeEnv(tdb.db)
      const token = await credToken(tdb)

      const { body: prep } = await prepare(env, token, setTranslations(SET_TRANSLATION_MAX_COMMANDS))
      expect(prep.summary.translationsAdded).toBe(SET_TRANSLATION_MAX_COMMANDS)

      const { res, body } = await commit(env, token, prep.changeset.id)
      expect(res.status).toBe(200)
      expect(body.receipt.appliedCount).toBe(SET_TRANSLATION_MAX_COMMANDS)
      expect(await targetCommitCount(tdb)).toBe(SET_TRANSLATION_MAX_COMMANDS)
      expect(await changesetStatus(tdb, prep.changeset.id)).toBe('committed')
    },
    900_000,
  )
})

describe('AQU-1852 — a long apply refreshes its internal write token', () => {
  it('re-mints mid-apply instead of losing the tail to "token expired"', async () => {
    const tdb = await seedProject(600)
    const env = makeEnv(tdb.db)
    const token = await credToken(tdb)

    const { body: prep } = await prepare(env, token, setTranslations(600))

    // Each of the 6 write POSTs advances the clock 90s, so the apply spans 540s
    // — well past the 300s life of the token minted at its start. The perimeter
    // verifies `exp` against the same clock, so an un-refreshed token really
    // does expire here, exactly as it does on a slow production apply.
    const realNow = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => realNow + perimeter.offsetMs)
    perimeter.advanceMsPerCall = 90_000

    const { res, body } = await commit(env, token, prep.changeset.id)
    expect(res.status).toBe(200)
    // Before the fix the last two chunks came back rejected with
    // "token expired" and the changeset still closed as `committed`.
    expect(body.receipt.warnings.filter((w: { message: string }) => /expired/i.test(w.message))).toEqual([])
    expect(body.receipt.appliedCount).toBe(600)
    expect(await targetCommitCount(tdb)).toBe(600)
    expect(await changesetStatus(tdb, prep.changeset.id)).toBe('committed')

    // It refreshed rather than reusing one token for the whole apply.
    expect(new Set(perimeter.tokensSeen).size).toBeGreaterThan(1)
  }, 120_000)
})

describe('AQU-1852 — a mid-apply stop is visible and resumable', () => {
  it('a perimeter refusal records what applied, keeps `committing`, and a retry finishes it', async () => {
    const tdb = await seedProject(600)
    const env = makeEnv(tdb.db)
    const token = await credToken(tdb)

    const { body: prep } = await prepare(env, token, setTranslations(600))

    // Let the first two chunks (100 events each) land, then refuse.
    perimeter.calls = 0
    perimeter.refuseAfterChunks = 2
    const first = await commit(env, token, prep.changeset.id)
    expect(first.res.status).toBe(500)
    expect(first.body.error.code).toBe('job_failed')
    expect(first.body.error.message).toContain('apply stopped partway')
    expect(first.body.error.details.appliedCount).toBe(200)
    expect(first.body.error.details.retryable).toBe(true)

    // The changeset is NOT stranded silently: it still sits in the
    // retry-resumable state, and its receipt names the events that landed.
    const mid = (
      await tdb.pg.query<{ status: string; receipt: unknown }>(
        `SELECT status, receipt FROM changesets WHERE id = $1`,
        [prep.changeset.id],
      )
    ).rows[0]
    expect(mid.status).toBe('committing')
    const partial = (typeof mid.receipt === 'string' ? JSON.parse(mid.receipt) : mid.receipt) as any
    expect(partial.appliedCount).toBe(200)
    expect(partial.eventIds).toHaveLength(200)
    expect(partial.warnings.some((w: { code: string }) => w.code === 'apply_incomplete')).toBe(true)

    const appliedFirst = new Set<string>(partial.eventIds)

    // Retry: the stored planned ids mean the re-post is idempotent, so the
    // 200 that already landed are not duplicated.
    perimeter.refuseAfterChunks = Number.POSITIVE_INFINITY
    const retry = await commit(env, token, prep.changeset.id)
    expect(retry.res.status).toBe(200)
    expect(retry.body.receipt.appliedCount).toBe(600)

    expect(await targetCommitCount(tdb)).toBe(600)

    // The ids from the first attempt are the same ids after the retry.
    const retried = new Set<string>(retry.body.receipt.eventIds)
    for (const id of appliedFirst) expect(retried.has(id)).toBe(true)

    expect(await changesetStatus(tdb, prep.changeset.id)).toBe('committed')
  }, 120_000)
})

describe('AQU-1852 — the cap is enforced at prepare', () => {
  it('above the cap, prepare refuses by name and stages nothing', async () => {
    const tdb = await seedProject(10)
    const env = makeEnv(tdb.db)
    const token = await credToken(tdb)

    const { res, body } = await prepare(env, token, setTranslations(SET_TRANSLATION_MAX_COMMANDS + 1))
    expect(res.status).toBe(400)
    expect(body.error.code).toBe('validation_failed')
    expect(body.error.message).toContain(String(SET_TRANSLATION_MAX_COMMANDS))
    expect(body.error.details.maxCommands).toBe(SET_TRANSLATION_MAX_COMMANDS)

    expect((await tdb.pg.query(`SELECT id FROM changesets`)).rows).toHaveLength(0)
  })
})

describe('AQU-1852 — the precondition lookup stays under the driver ceiling', () => {
  it('a 5,000-cell prepare binds no statement past the parameter limit', async () => {
    let worst = 0
    const tdb = await seedProject(SET_TRANSLATION_MAX_COMMANDS, {
      onStatement: (_sql, params) => {
        if (params.length > worst) worst = params.length
      },
    })
    const env = makeEnv(tdb.db)
    const token = await credToken(tdb)

    const { res } = await prepare(env, token, setTranslations(SET_TRANSLATION_MAX_COMMANDS))
    expect(res.status).toBe(200)
    // Unpaged, the (file_id, cell_id) IN (...) lookup bound 2 params per cell —
    // the shape that throws MAX_PARAMETERS_EXCEEDED past ~32.7k cells.
    expect(worst).toBeLessThanOrEqual(DRIVER_MAX_BIND_PARAMS)
  }, 180_000)
})

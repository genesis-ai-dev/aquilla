// Commit-time supersession (command registry P1 §3.2). A staged plan whose
// preconditions drifted is only `stale` when there is still work in it; when
// the drift IS the plan's own end-state — a human did it by hand — the stored
// status is `superseded`, a healthy outcome.
//
// The FROZEN part: the wire error stays `plan_stale` in both cases. Only the
// stored status and the error's `details.status` discriminator differ.

import { describe, it, expect, beforeEach } from 'vitest'
import { vi } from 'vitest'

// commit core → events/route.ts → broadcast.ts → partyserver (cloudflare:*).
vi.mock('partyserver', () => ({
  getServerByName: vi.fn().mockResolvedValue({
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  }),
}))

import { handleSessionChangesetsRequest } from '../external/session-routes'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'
import { makeTestToken } from './helpers/auth'

const SECRET = 'test-secret'
const PROJECT = 'proj-a'
const FILE = 'file-x'
const CELL = 'cell-1'
const BASE = `https://w/api/v1/changesets/${PROJECT}`

function makeEnv(db: AquillaDb) {
  return { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET, BASE_URL: 'https://aquilla.app' }
}

async function token(userId: number, username: string, role: number): Promise<string> {
  return makeTestToken(SECRET, { projectId: PROJECT, fileId: '', userId, username, role })
}

function req(tok: string, path: string, method: string, body?: unknown): Request {
  return new Request(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${tok}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

async function call(env: ReturnType<typeof makeEnv>, request: Request) {
  const res = (await handleSessionChangesetsRequest(request, env))!
  return { res, body: (await res.json()) as Record<string, never> & Record<string, unknown> }
}

/** As auth-worker's approve route mints it: credential_id = 'session'. */
async function insertConfirmation(db: AquillaDb, changesetId: string, digest: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO changeset_confirmations
         (id, changeset_id, user_id, credential_id, digest, expires_at, consumed_at)
       VALUES (?, ?, '1', 'session', ?, ?, NULL)`,
    )
    .bind(`conf-${changesetId}`, changesetId, digest, new Date(Date.now() + 60_000).toISOString())
    .run()
}

async function statusOf(tdb: TestDb, id: string): Promise<string> {
  const row = await tdb.pg.query<{ status: string }>(`SELECT status FROM changesets WHERE id = $1`, [id])
  return row.rows[0].status
}

/** A human writes the target cell by hand: new chain head, new value. */
async function humanCommitsTarget(tdb: TestDb, value: string, eventId: string): Promise<void> {
  await tdb.pg.query(
    `INSERT INTO cells (project_id, file_id, cell_id, side, target_lang, value, event_id, last_edit_at)
     VALUES ($1, $2, $3, 'target', '', $4, $5, 2)
     ON CONFLICT (project_id, file_id, cell_id, side, target_lang)
     DO UPDATE SET value = EXCLUDED.value, event_id = EXCLUDED.event_id`,
    [PROJECT, FILE, CELL, value, eventId],
  )
}

let tdb: TestDb
beforeEach(async () => {
  tdb = await makeTestDb({
    users: [
      { id: 1, username: 'alice', email: 'a@x.com', password_hash: 'h' },
      { id: 2, username: 'bob', email: 'b@x.com', password_hash: 'h' },
    ],
    projects: [{ id: PROJECT, name: 'P', created_by: 1, org_id: null }],
    project_members: [
      { project_id: PROJECT, user_id: 1, role_level: 600 },
      { project_id: PROJECT, user_id: 2, role_level: 600 },
    ],
    files: [{ id: FILE, project_id: PROJECT, name: 'F', event_id: 'f-evt-1' }],
    cells: [
      {
        project_id: PROJECT, file_id: FILE, cell_id: CELL, side: 'source',
        value: 'source one', event_id: 'src-evt-1', last_edit_at: 1,
      },
    ],
  })
})

describe('SetTranslation — drift that IS the plan', () => {
  it('commits as superseded when a human already committed the planned value, still answering plan_stale', async () => {
    const env = makeEnv(tdb.db)
    const alice = await token(1, 'alice', 600)
    const { body: prep } = await call(env, req(alice, '', 'POST', {
      commands: [{ kind: 'SetTranslation', fileId: FILE, cellId: CELL, value: 'hola' }],
    }))
    const id = (prep.changeset as { id: string }).id

    await humanCommitsTarget(tdb, 'hola', 'human-evt-1')

    const { res, body } = await call(env, req(alice, `/${id}/commit`, 'POST'))
    // FROZEN wire contract: still 409 / plan_stale.
    expect(res.status).toBe(409)
    const err = body.error as { code: string; details: { status: string } }
    expect(err.code).toBe('plan_stale')
    // …but the stored status and the discriminator say "already done by hand".
    expect(err.details.status).toBe('superseded')
    expect(await statusOf(tdb, id)).toBe('superseded')

    // Nothing was applied and no approval was burned — drift is checked before
    // the consume-then-flip sequence.
    expect(await tdb.rows('events')).toHaveLength(0)
    expect(await tdb.rows('changeset_confirmations')).toHaveLength(0)

    // Terminal: a re-commit reports superseded rather than re-entering.
    const { res: again, body: againBody } = await call(env, req(alice, `/${id}/commit`, 'POST'))
    expect(again.status).toBe(409)
    expect((againBody.error as { details: { status: string } }).details.status).toBe('superseded')
    expect(await statusOf(tdb, id)).toBe('superseded')
  })

  it('stays stale when the drift is any OTHER change', async () => {
    const env = makeEnv(tdb.db)
    const alice = await token(1, 'alice', 600)
    const { body: prep } = await call(env, req(alice, '', 'POST', {
      commands: [{ kind: 'SetTranslation', fileId: FILE, cellId: CELL, value: 'hola' }],
    }))
    const id = (prep.changeset as { id: string }).id

    await humanCommitsTarget(tdb, 'algo distinto', 'human-evt-1')

    const { res, body } = await call(env, req(alice, `/${id}/commit`, 'POST'))
    expect(res.status).toBe(409)
    const err = body.error as { code: string; details: { status: string } }
    expect(err.code).toBe('plan_stale')
    expect(err.details.status).toBe('stale')
    expect(await statusOf(tdb, id)).toBe('stale')
  })

  it('is not satisfied by a matching value in a DIFFERENT lane', async () => {
    const env = makeEnv(tdb.db)
    const alice = await token(1, 'alice', 600)
    await tdb.pg.query(
      `INSERT INTO project_settings (project_id, settings, version) VALUES ($1, $2, 1)`,
      [PROJECT, JSON.stringify({ targetLanes: ['es'] })],
    )
    const { body: prep } = await call(env, req(alice, '', 'POST', {
      commands: [{ kind: 'SetTranslation', fileId: FILE, cellId: CELL, value: 'hola', laneId: 'es' }],
    }))
    const id = (prep.changeset as { id: string }).id

    // The human wrote the same text into the DEFAULT lane, not the "es" lane.
    await humanCommitsTarget(tdb, 'hola', 'human-evt-1')
    // …and the es lane moved for some other reason, so the plan is drifted.
    await tdb.pg.query(
      `INSERT INTO cells (project_id, file_id, cell_id, side, target_lang, value, event_id, last_edit_at)
       VALUES ($1, $2, $3, 'target', 'es', 'otra', 'es-evt-1', 3)`,
      [PROJECT, FILE, CELL],
    )

    const { body } = await call(env, req(alice, `/${id}/commit`, 'POST'))
    expect((body.error as { details: { status: string } }).details.status).toBe('stale')
    expect(await statusOf(tdb, id)).toBe('stale')
  })

  it('never conflates expiry with supersession', async () => {
    const env = makeEnv(tdb.db)
    const alice = await token(1, 'alice', 600)
    const { body: prep } = await call(env, req(alice, '', 'POST', {
      commands: [{ kind: 'SetTranslation', fileId: FILE, cellId: CELL, value: 'hola' }],
    }))
    const id = (prep.changeset as { id: string }).id

    // The end-state exists AND the TTL passed: expiry is checked first and
    // wins — nobody acted on the plan itself, which is the unhealthy fact.
    await humanCommitsTarget(tdb, 'hola', 'human-evt-1')
    await tdb.pg.query(`UPDATE changesets SET expires_at = now() - interval '1 hour' WHERE id = $1`, [id])

    const { res, body } = await call(env, req(alice, `/${id}/commit`, 'POST'))
    expect(res.status).toBe(400)
    expect((body.error as { code: string }).code).toBe('validation_failed')
    expect(await statusOf(tdb, id)).toBe('expired')
  })
})

describe('EmitEvents — validation a human already gave', () => {
  beforeEach(async () => {
    await tdb.pg.query(
      `INSERT INTO cells (project_id, file_id, cell_id, side, target_lang, value, event_id, last_edit_at)
       VALUES ($1, $2, $3, 'target', '', 'borrador', 'tgt-evt-1', 2)`,
      [PROJECT, FILE, CELL],
    )
  })

  async function stageValidate(env: ReturnType<typeof makeEnv>, alice: string): Promise<string> {
    const { body } = await call(env, req(alice, '', 'POST', {
      commands: [{ kind: 'EmitEvents', events: [{ kind: 'cell.validate', fileId: FILE, cellId: CELL }] }],
    }))
    return (body.changeset as { id: string }).id
  }

  /** The human edits the cell (head moves) and validates the new head. */
  async function humanEditsAndValidates(username: string): Promise<void> {
    await tdb.pg.query(
      `UPDATE cells SET event_id = 'tgt-evt-2', value = 'definitivo'
        WHERE project_id = $1 AND file_id = $2 AND cell_id = $3 AND side = 'target'`,
      [PROJECT, FILE, CELL],
    )
    await tdb.pg.query(
      `INSERT INTO cell_validators (project_id, file_id, cell_id, target_lang, event_id, username, decided_ts)
       VALUES ($1, $2, $3, '', 'tgt-evt-2', $4, 3)`,
      [PROJECT, FILE, CELL, username],
    )
  }

  it("is superseded when the actor's own validation is already on the cell", async () => {
    const env = makeEnv(tdb.db)
    const alice = await token(1, 'alice', 600)
    const id = await stageValidate(env, alice)
    await humanEditsAndValidates('alice')

    const { res, body } = await call(env, req(alice, `/${id}/commit`, 'POST'))
    expect(res.status).toBe(409)
    expect((body.error as { code: string }).code).toBe('plan_stale')
    expect((body.error as { details: { status: string } }).details.status).toBe('superseded')
    expect(await statusOf(tdb, id)).toBe('superseded')
  })

  it("stays stale when only SOMEONE ELSE validated — testimony is per person", async () => {
    const env = makeEnv(tdb.db)
    const alice = await token(1, 'alice', 600)
    const id = await stageValidate(env, alice)
    await humanEditsAndValidates('bob')

    const { body } = await call(env, req(alice, `/${id}/commit`, 'POST'))
    expect((body.error as { details: { status: string } }).details.status).toBe('stale')
    expect(await statusOf(tdb, id)).toBe('stale')
  })
})

describe('PatchSettings — a settings write a human beat the agent to', () => {
  async function stagePatch(
    env: ReturnType<typeof makeEnv>,
    alice: string,
  ): Promise<{ id: string; digest: string }> {
    const { body } = await call(env, req(alice, '', 'POST', {
      commands: [
        { kind: 'PatchSettings', projectId: PROJECT, ops: [{ key: 'targetLanes', value: ['es'] }], ifMatchVersion: 0 },
      ],
    }))
    return { id: (body.changeset as { id: string }).id, digest: body.digest as string }
  }

  /** Someone else writes the settings blob, bumping the version past the pin. */
  async function humanWritesSettings(settings: Record<string, unknown>): Promise<void> {
    await tdb.pg.query(
      `INSERT INTO project_settings (project_id, settings, version, updated_by) VALUES ($1, $2, 1, 2)`,
      [PROJECT, JSON.stringify(settings)],
    )
  }

  it('is superseded when every op key already holds the proposed value', async () => {
    const env = makeEnv(tdb.db)
    const alice = await token(1, 'alice', 600)
    const { id, digest } = await stagePatch(env, alice)
    await humanWritesSettings({ targetLanes: ['es'] })
    await insertConfirmation(tdb.db, id, digest)

    const { res, body } = await call(env, req(alice, `/${id}/commit`, 'POST'))
    expect(res.status).toBe(409)
    expect((body.error as { code: string }).code).toBe('plan_stale')
    expect((body.error as { details: { status: string } }).details.status).toBe('superseded')
    expect(await statusOf(tdb, id)).toBe('superseded')
  })

  it('stays stale when the live value differs', async () => {
    const env = makeEnv(tdb.db)
    const alice = await token(1, 'alice', 600)
    const { id, digest } = await stagePatch(env, alice)
    await humanWritesSettings({ targetLanes: ['pt'] })
    await insertConfirmation(tdb.db, id, digest)

    const { body } = await call(env, req(alice, `/${id}/commit`, 'POST'))
    expect((body.error as { details: { status: string } }).details.status).toBe('stale')
    expect(await statusOf(tdb, id)).toBe('stale')
  })
})

describe('superseded is its own status', () => {
  it('is a listable, filterable status that never appears as stale or expired', async () => {
    const env = makeEnv(tdb.db)
    const alice = await token(1, 'alice', 600)
    const { body: prep } = await call(env, req(alice, '', 'POST', {
      commands: [{ kind: 'SetTranslation', fileId: FILE, cellId: CELL, value: 'hola' }],
    }))
    const id = (prep.changeset as { id: string }).id
    await humanCommitsTarget(tdb, 'hola', 'human-evt-1')
    await call(env, req(alice, `/${id}/commit`, 'POST'))

    const { body: superseded } = await call(env, req(alice, '?status=superseded', 'GET'))
    expect((superseded.changesets as { id: string }[]).map((c) => c.id)).toEqual([id])
    const { body: stale } = await call(env, req(alice, '?status=stale', 'GET'))
    expect(stale.changesets).toHaveLength(0)
    const { body: expired } = await call(env, req(alice, '?status=expired', 'GET'))
    expect(expired.changesets).toHaveLength(0)

    const { body: fetched } = await call(env, req(alice, `/${id}`, 'GET'))
    expect((fetched.changeset as { status: string }).status).toBe('superseded')
  })
})

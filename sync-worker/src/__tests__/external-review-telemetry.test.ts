// AQU-1572: the Agent API's validation and audio telemetry.
//
// Pins the contract of external/review-telemetry.ts and its two call sites:
//   - one event per kind per committed changeset, with the right cell_count,
//     medium, source and lane;
//   - the channel → source mapping (rest → api; mcp and the session route's
//     'app' → agent);
//   - nothing at staging, at a refused ask-mode commit, on a stale plan, or on
//     the idempotent re-commit — the event fires once, at the real commit;
//   - nothing at all when POSTHOG_KEY is blank;
//   - distinct_id is the SHA-256 of the username, as the browser identifies;
//   - ids and counts only: no text, file name, artifact id or URL.

import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

// commit path → events/route.ts → broadcast.ts → partyserver (cloudflare:*).
vi.mock('partyserver', () => ({
  getServerByName: vi.fn().mockResolvedValue({
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  }),
}))

import { handleExternalArtifactsRequest } from '../external/artifacts-route'
import { handleExternalChangesetsRequest } from '../external/changesets-route'
import { handleSessionChangesetsRequest } from '../external/session-routes'
import {
  MIXED_LANE,
  emitEventsTelemetry,
  linkMediaTelemetry,
  sendReviewTelemetry,
  telemetryAppEnv,
  telemetryDistinctId,
  telemetrySourceFor,
} from '../external/review-telemetry'
import { handleEventsWriteRequest } from '../events/route'
import { mintApiToken } from '../../../db/shared/api-credentials'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'
import { makeTestToken } from './helpers/auth'
import type { RawEvent } from '../events/types'

const SECRET = 'test-secret'
const PROJECT = 'proj-t'
const FILE = 'file-x'
const FILE_NAME = 'Gospel of Testing'
const UUID_CELL = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'
const TARGET_TEXT = 'the target words nobody may see'
const SOURCE_TEXT = 'the source words nobody may see'
const PH_HOST = 'https://ph.test'

/** Every property a server event may carry. Anything else is a leak. */
const ALLOWED_PROPS = new Set([
  'project_id', 'lane', 'source', 'cell_count', 'file_id', 'file_count', 'cell_id',
  'medium', 'method', 'duration_ms', 'app_env', '$lib',
])

interface PosthogBatch {
  api_key: string
  batch: { event: string; distinct_id: string; properties: Record<string, unknown>; timestamp: string }[]
}

let fetchSpy: MockInstance<typeof fetch>
let pending: Promise<unknown>[]
const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p) }

/** Every PostHog request made so far, after the waitUntil promises settle. */
async function posthogBatches(): Promise<PosthogBatch[]> {
  await Promise.all(pending)
  return fetchSpy.mock.calls
    .filter(([url]) => String(url).startsWith(PH_HOST))
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as PosthogBatch)
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function makeEnv(db: AquillaDb, extra: Record<string, unknown> = {}) {
  return {
    AQUILLA_PG: db,
    SYNC_SECRET_KEY: SECRET,
    BASE_URL: 'https://aquilla.app',
    POSTHOG_KEY: 'phc_test',
    POSTHOG_HOST: PH_HOST,
    ENVIRONMENT: 'test',
    ...extra,
  }
}

let nextUserId = 500
let nextCred = 500

async function patMember(
  tdb: TestDb,
  level: number,
  mode: 'ask' | 'act' = 'act',
): Promise<{ token: string; username: string }> {
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
  const credentialId = `00000000-0000-0000-0000-${String(++nextCred).padStart(12, '0')}`
  await tdb.pg.query(
    `INSERT INTO api_credentials (id, user_id, name, token_prefix, token_hash, mode, org_id, project_id)
     VALUES ($1, $2, 'test', $3, $4, $5, NULL, $6)`,
    [credentialId, String(userId), tokenPrefix, tokenHash, mode, PROJECT],
  )
  return { token, username }
}

async function prepare(env: ReturnType<typeof makeEnv>, token: string, commands: unknown[]) {
  const res = (await handleExternalChangesetsRequest(
    new Request(`https://w/api/v1/external/projects/${PROJECT}/changesets`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands }),
    }),
    env,
    ctx,
  ))!
  return { res, body: (await res.json()) as any }
}

async function commit(env: ReturnType<typeof makeEnv>, token: string, id: string, headers: Record<string, string> = {}) {
  const res = (await handleExternalChangesetsRequest(
    new Request(`https://w/api/v1/external/projects/${PROJECT}/changesets/${id}/commit`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, ...headers },
    }),
    env,
    ctx,
  ))!
  return { res, body: (await res.json()) as any }
}

/** A target commit through the real perimeter, by someone other than the
 *  validator, so heads are honest and self-validation never trips. */
async function seedTarget(tdb: TestDb, cellId: string, eventId: string, value = TARGET_TEXT) {
  await tdb.pg.query(
    `INSERT INTO users (id, username, email, password_hash) VALUES (999, 'seeder', 's@x.com', 'h')
     ON CONFLICT (id) DO NOTHING`,
  )
  await tdb.pg.query(
    `INSERT INTO project_members (project_id, user_id, role_level) VALUES ($1, 999, 700)
     ON CONFLICT DO NOTHING`,
    [PROJECT],
  )
  const tok = await makeTestToken(SECRET, { projectId: PROJECT, fileId: FILE, userId: 999, username: 'seeder', role: 700 })
  const ev: RawEvent<'target.cell.create'> = {
    id: eventId, schemaVersion: 1, kind: 'target.cell.create',
    projectId: PROJECT, fileId: FILE, cellId, parentId: null,
    author: 'seeder', payload: { cellId, value }, clientTs: 1,
  }
  const res = await handleEventsWriteRequest(
    new Request('https://w/events', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: [ev] }),
    }),
    { AQUILLA_PG: tdb.db, SYNC_SECRET_KEY: SECRET },
  )
  expect(res!.status).toBe(200)
}

function validate(cellId: string) {
  return { kind: 'cell.validate', fileId: FILE, cellId }
}

/** No text, file name, artifact id, audio id or URL — in any property. */
function expectIdsAndCountsOnly(batch: PosthogBatch, forbidden: string[] = []) {
  for (const e of batch.batch) {
    for (const key of Object.keys(e.properties)) expect(ALLOWED_PROPS).toContain(key)
    const raw = JSON.stringify(e.properties)
    for (const s of [TARGET_TEXT, SOURCE_TEXT, FILE_NAME, 'frontier-audio://', 'http', ...forbidden]) {
      expect(raw).not.toContain(s)
    }
  }
}

let tdb: TestDb
beforeEach(async () => {
  pending = []
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: 200 }))
  tdb = await makeTestDb({
    projects: [{ id: PROJECT, name: 'P', created_by: 98, org_id: null }],
    files: [{ id: FILE, project_id: PROJECT, name: FILE_NAME, event_id: 'f-evt-1' }],
    cells: ['cell-1', 'cell-2', UUID_CELL].map((cellId, i) => ({
      project_id: PROJECT, file_id: FILE, cell_id: cellId, side: 'source',
      value: SOURCE_TEXT, event_id: `src-evt-${i + 1}`, last_edit_at: 1,
    })),
  })
})

afterEach(() => {
  fetchSpy.mockRestore()
})

// ── Pure helpers ─────────────────────────────────────────────────────────────

describe('review telemetry — builders', () => {
  it('maps the channel to who acted: REST is an API caller, MCP and the in-app session route are the agent', () => {
    expect(telemetrySourceFor('rest')).toBe('api')
    expect(telemetrySourceFor('mcp')).toBe('agent')
    expect(telemetrySourceFor('app')).toBe('agent')
  })

  it('one event per validation kind, cells counted once, other kinds ignored', () => {
    const events = emitEventsTelemetry(
      'p',
      [
        { kind: 'cell.validate', fileId: 'f1', cellId: 'c1', laneId: 'es' },
        { kind: 'cell.validate', fileId: 'f1', cellId: 'c2', laneId: 'es' },
        { kind: 'cell.validate', fileId: 'f1', cellId: 'c2', laneId: 'es' },
        { kind: 'cell.unvalidate', fileId: 'f2', cellId: 'c3' },
        { kind: 'comment.create', fileId: 'f1', cellId: 'c1' },
        { kind: 'cell.audio.validate', fileId: 'f1', cellId: 'c1' },
      ],
      'agent',
    )
    expect(events).toEqual([
      {
        event: 'cell validated',
        properties: { project_id: 'p', lane: 'es', source: 'agent', cell_count: 2, file_id: 'f1', medium: 'text' },
      },
      {
        event: 'cell unvalidated',
        properties: { project_id: 'p', lane: 'default', source: 'agent', cell_count: 1, file_id: 'f2', medium: 'text' },
      },
      {
        event: 'cell validated',
        properties: { project_id: 'p', lane: 'default', source: 'agent', cell_count: 1, file_id: 'f1', medium: 'audio' },
      },
    ])
  })

  it('names the lane "mixed" when one action spans lanes', () => {
    const [event] = emitEventsTelemetry(
      'p',
      [
        { kind: 'cell.validate', fileId: 'f1', cellId: 'c1', laneId: 'es' },
        { kind: 'cell.validate', fileId: 'f1', cellId: 'c2' },
      ],
      'api',
    )
    expect(event.properties.lane).toBe(MIXED_LANE)
    expect(event.properties.cell_count).toBe(2)
  })

  it('nothing to report is no event', () => {
    expect(emitEventsTelemetry('p', [{ kind: 'comment.create', fileId: 'f', cellId: 'c' }], 'api')).toEqual([])
    expect(linkMediaTelemetry('p', [], 'api')).toEqual([])
  })

  it('distinct_id is the hex SHA-256 of the username', async () => {
    expect(await telemetryDistinctId('alice')).toBe(sha256('alice'))
    expect(await telemetryDistinctId('Ñandú')).toBe(sha256('Ñandú'))
  })

  it('sends nothing when POSTHOG_KEY is blank or unset', async () => {
    const events = linkMediaTelemetry('p', [{ fileId: 'f', cellId: 'c' }], 'api')
    sendReviewTelemetry({ POSTHOG_KEY: '', POSTHOG_HOST: PH_HOST }, ctx, 'alice', events)
    sendReviewTelemetry({ POSTHOG_KEY: '   ' }, ctx, 'alice', events)
    sendReviewTelemetry({}, ctx, 'alice', events)
    expect(pending).toHaveLength(0)
    expect(await posthogBatches()).toHaveLength(0)
  })

  it('never throws, even when PostHog is unreachable', async () => {
    fetchSpy.mockRejectedValue(new TypeError('network down'))
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const events = linkMediaTelemetry('p', [{ fileId: 'f', cellId: 'c' }], 'api')
    expect(() => sendReviewTelemetry(makeEnv(tdb.db), ctx, 'alice', events)).not.toThrow()
    await expect(Promise.all(pending)).resolves.toBeDefined()
    expect(err).toHaveBeenCalledWith('[review-telemetry] dropped events:', 'TypeError')
    err.mockRestore()
  })
})

// ── EmitEvents through the real commit path ─────────────────────────────────

describe('review telemetry — EmitEvents commits', () => {
  it('a REST commit of N validations sends ONE `cell validated` with cell_count N', async () => {
    await seedTarget(tdb, 'cell-1', 'tgt-1')
    await seedTarget(tdb, 'cell-2', 'tgt-2')
    const env = makeEnv(tdb.db)
    const reviewer = await patMember(tdb, 300)

    const { body: prep } = await prepare(env, reviewer.token, [
      {
        kind: 'EmitEvents',
        events: [
          validate('cell-1'),
          validate('cell-2'),
          // Not a validation: must not surface as one.
          { kind: 'comment.create', fileId: FILE, cellId: 'cell-1', payload: { body: TARGET_TEXT } },
        ],
      },
    ])
    expect(prep.changeset.status).toBe('staged')
    // Staging alone sends nothing.
    expect(await posthogBatches()).toHaveLength(0)

    const { res } = await commit(env, reviewer.token, prep.changeset.id)
    expect(res.status).toBe(200)

    const batches = await posthogBatches()
    expect(batches).toHaveLength(1)
    const [batch] = batches
    expect(batch.api_key).toBe('phc_test')
    expect(batch.batch).toHaveLength(1)
    const [event] = batch.batch
    expect(event.event).toBe('cell validated')
    expect(event.distinct_id).toBe(sha256(reviewer.username))
    expect(event.properties).toEqual({
      project_id: PROJECT,
      lane: 'default',
      source: 'api',
      cell_count: 2,
      file_id: FILE,
      medium: 'text',
      app_env: 'test',
      $lib: 'aquilla-sync-worker',
    })
    expectIdsAndCountsOnly(batch)
  })

  it('validate + unvalidate in one changeset: one event per kind, in one request', async () => {
    await seedTarget(tdb, 'cell-1', 'tgt-1')
    await seedTarget(tdb, UUID_CELL, 'tgt-3')
    const env = makeEnv(tdb.db)
    const reviewer = await patMember(tdb, 300)

    const first = await prepare(env, reviewer.token, [{ kind: 'EmitEvents', events: [validate('cell-1')] }])
    await commit(env, reviewer.token, first.body.changeset.id)

    const { body: prep } = await prepare(env, reviewer.token, [
      {
        kind: 'EmitEvents',
        events: [{ kind: 'cell.unvalidate', fileId: FILE, cellId: 'cell-1' }, validate(UUID_CELL)],
      },
    ])
    const { res } = await commit(env, reviewer.token, prep.changeset.id)
    expect(res.status).toBe(200)

    const batches = await posthogBatches()
    expect(batches).toHaveLength(2)
    const second = batches[1].batch
    expect(second.map((e) => e.event)).toEqual(['cell unvalidated', 'cell validated'])
    expect(second.every((e) => e.properties.cell_count === 1)).toBe(true)
    // A single UUID cell is named; a verse-reference-shaped id never is.
    expect(second[0].properties.cell_id).toBeUndefined()
    expect(second[1].properties.cell_id).toBe(UUID_CELL)
  })

  it('an MCP commit reports the agent as the source', async () => {
    await seedTarget(tdb, 'cell-1', 'tgt-1')
    const env = makeEnv(tdb.db)
    const reviewer = await patMember(tdb, 300)
    const { body: prep } = await prepare(env, reviewer.token, [{ kind: 'EmitEvents', events: [validate('cell-1')] }])

    const { res } = await commit(env, reviewer.token, prep.changeset.id, { 'x-aquilla-channel': 'mcp' })
    expect(res.status).toBe(200)

    const [batch] = await posthogBatches()
    expect(batch.batch[0].properties.source).toBe('agent')
  })

  it('sends nothing when POSTHOG_KEY is blank, though the commit lands', async () => {
    await seedTarget(tdb, 'cell-1', 'tgt-1')
    const env = makeEnv(tdb.db, { POSTHOG_KEY: '' })
    const reviewer = await patMember(tdb, 300)
    const { body: prep } = await prepare(env, reviewer.token, [{ kind: 'EmitEvents', events: [validate('cell-1')] }])

    const { res } = await commit(env, reviewer.token, prep.changeset.id)
    expect(res.status).toBe(200)
    expect(await tdb.rows('cell_validators')).toHaveLength(1)
    expect(await posthogBatches()).toHaveLength(0)
  })

  it('a stale plan sends nothing', async () => {
    await seedTarget(tdb, 'cell-1', 'tgt-1')
    const env = makeEnv(tdb.db)
    const reviewer = await patMember(tdb, 300)
    const { body: prep } = await prepare(env, reviewer.token, [{ kind: 'EmitEvents', events: [validate('cell-1')] }])

    // A new edit moves the head the plan pinned.
    const tok = await makeTestToken(SECRET, { projectId: PROJECT, fileId: FILE, userId: 999, username: 'seeder', role: 700 })
    const edit: RawEvent<'target.cell.commit'> = {
      id: 'tgt-1b', schemaVersion: 1, kind: 'target.cell.commit',
      projectId: PROJECT, fileId: FILE, cellId: 'cell-1', parentId: 'tgt-1',
      author: 'seeder', payload: { value: 'edited', sourceEventId: 'src-evt-1' }, clientTs: 2,
    }
    await handleEventsWriteRequest(
      new Request('https://w/events', {
        method: 'POST',
        headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ events: [edit] }),
      }),
      { AQUILLA_PG: tdb.db, SYNC_SECRET_KEY: SECRET },
    )

    const { res, body } = await commit(env, reviewer.token, prep.changeset.id)
    expect(res.status).toBe(409)
    expect(body.error.code).toBe('plan_stale')
    expect(await posthogBatches()).toHaveLength(0)
  })
})

// ── Ask mode: the in-app agent's plan, applied from the review card ─────────

describe('review telemetry — ask mode through the session route', () => {
  async function sessionCall(env: ReturnType<typeof makeEnv>, token: string, path: string, body?: unknown) {
    const res = (await handleSessionChangesetsRequest(
      new Request(`https://w/api/v1/changesets/${PROJECT}${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
      env,
      ctx,
    ))!
    return { res, body: (await res.json()) as any }
  }

  it('fires once, at the real commit — not at staging, not on a refused commit, not on re-commit', async () => {
    await seedTarget(tdb, 'cell-1', 'tgt-1')
    await tdb.pg.query(
      `INSERT INTO users (id, username, email, password_hash) VALUES (7, 'alice', 'a@x.com', 'h')`,
    )
    await tdb.pg.query(
      `INSERT INTO project_members (project_id, user_id, role_level) VALUES ($1, 7, 300)`,
      [PROJECT],
    )
    const env = makeEnv(tdb.db)
    const token = await makeTestToken(SECRET, { projectId: PROJECT, fileId: '', userId: 7, username: 'alice', role: 300 })

    const { body: prep } = await sessionCall(env, token, '', {
      commands: [{ kind: 'EmitEvents', events: [validate('cell-1')] }],
    })
    const id = prep.changeset.id as string
    expect(prep.changeset.autonomyMode).toBe('ask')

    // No approval yet: refused, nothing applied, nothing sent.
    const { res: refused } = await sessionCall(env, token, `/${id}/commit`)
    expect(refused.status).toBe(428)
    expect(await posthogBatches()).toHaveLength(0)

    // The approval (auth-worker's approve route) only mints this row — it
    // applies nothing, so it cannot be where an event fires.
    await tdb.db
      .prepare(
        `INSERT INTO changeset_confirmations
           (id, changeset_id, user_id, credential_id, digest, expires_at, consumed_at)
         VALUES (?, ?, '7', 'session', ?, ?, NULL)`,
      )
      .bind('conf-1', id, prep.digest, new Date(Date.now() + 60_000).toISOString())
      .run()
    expect(await posthogBatches()).toHaveLength(0)

    const { res } = await sessionCall(env, token, `/${id}/commit`)
    expect(res.status).toBe(200)
    const { res: again } = await sessionCall(env, token, `/${id}/commit`)
    expect(again.status).toBe(200)

    const batches = await posthogBatches()
    expect(batches).toHaveLength(1)
    expect(batches[0].batch).toHaveLength(1)
    const [event] = batches[0].batch
    expect(event.event).toBe('cell validated')
    expect(event.distinct_id).toBe(sha256('alice'))
    expect(event.properties.source).toBe('agent')
    expect(event.properties.cell_count).toBe(1)
  })
})

// ── LinkMedia ────────────────────────────────────────────────────────────────

describe('review telemetry — LinkMedia commits', () => {
  function makeBucket() {
    const store = new Map<string, ArrayBuffer>()
    return {
      async get(key: string) {
        const body = store.get(key)
        return body ? { arrayBuffer: async () => body } : null
      },
      async put(key: string, value: ArrayBuffer | Uint8Array) {
        store.set(key, value instanceof Uint8Array ? value.slice().buffer : value)
      },
      async delete() {},
    }
  }

  it('one `audio attached` with method "link" for the cells it attached to', async () => {
    const env = makeEnv(tdb.db, { SNAPSHOTS: makeBucket() as unknown as R2Bucket, R2_KEY_PREFIX: '' })
    const contributor = await patMember(tdb, 400)

    const upload = (await handleExternalArtifactsRequest(
      new Request(`https://w/api/v1/external/projects/${PROJECT}/artifacts`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${contributor.token}`,
          'x-artifact-name': 'take.wav',
          'x-artifact-kind': 'audio',
          'content-type': 'audio/wav',
        },
        body: new Uint8Array([1, 2, 3, 4]),
      }),
      env,
    ))!
    expect(upload.status).toBe(200)
    const { artifactId, audioId } = (await upload.json()) as { artifactId: string; audioId: string }

    const { body: prep } = await prepare(env, contributor.token, [
      { kind: 'LinkMedia', fileId: FILE, cellId: UUID_CELL, artifactId },
    ])
    expect(await posthogBatches()).toHaveLength(0)

    const { res } = await commit(env, contributor.token, prep.changeset.id)
    expect(res.status).toBe(200)

    const batches = await posthogBatches()
    expect(batches).toHaveLength(1)
    const [event] = batches[0].batch
    expect(event.event).toBe('audio attached')
    expect(event.distinct_id).toBe(sha256(contributor.username))
    expect(event.properties).toEqual({
      project_id: PROJECT,
      lane: 'default',
      source: 'api',
      cell_count: 1,
      file_id: FILE,
      cell_id: UUID_CELL,
      method: 'link',
      app_env: 'test',
      $lib: 'aquilla-sync-worker',
    })
    expectIdsAndCountsOnly(batches[0], [artifactId, audioId, 'take.wav'])
  })
})

describe('telemetryAppEnv', () => {
  it("speaks the browser's app_env: the dev deployment is 'dev'", () => {
    expect(telemetryAppEnv('development')).toBe('dev')
    expect(telemetryAppEnv('production')).toBe('production')
    expect(telemetryAppEnv('local')).toBe('local')
    expect(telemetryAppEnv('  ')).toBeUndefined()
    expect(telemetryAppEnv(undefined)).toBeUndefined()
  })
})

describe('sendReviewTelemetry on a local stack', () => {
  it('prints what would have been sent instead of sending it', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const events = linkMediaTelemetry('p', [{ fileId: 'f1', cellId: 'c1' }], 'api')
    sendReviewTelemetry({ POSTHOG_KEY: '', ENVIRONMENT: 'local' }, undefined, 'alice', events)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(info).toHaveBeenCalledWith('[review-telemetry]', 'audio attached', expect.stringContaining('"method":"link"'))
    info.mockClear()
    // Anywhere else a blank key stays silent.
    sendReviewTelemetry({ POSTHOG_KEY: '', ENVIRONMENT: 'production' }, undefined, 'alice', events)
    expect(info).not.toHaveBeenCalled()
    info.mockRestore()
    fetchSpy.mockRestore()
  })
})

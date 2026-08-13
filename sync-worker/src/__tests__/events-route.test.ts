// Tests for handleEventsWriteRequest (POST /events) under AD-2 / AD-9.

import { describe, it, expect, vi } from 'vitest'

// route.ts imports broadcast.ts → partyserver (cloudflare:* imports).
// Mock partyserver so Node's ESM loader doesn't choke.
vi.mock('partyserver', () => ({
  getServerByName: vi.fn().mockResolvedValue({
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  }),
}))

import { handleEventsWriteRequest } from '../events/route'
import { handleRebuildProjectionRequest } from '../events/rebuild'
import { makeTestDb } from './helpers/pg-test-db'
import { makeTestToken } from './helpers/auth'
import type { RawEvent } from '../events/types'

const SECRET = 'test-secret'

async function makeToken(overrides: Record<string, unknown> = {}): Promise<string> {
  return makeTestToken(SECRET, {
    projectId: 'proj-a',
    fileId: 'file-x',
    ...overrides,
  } as any)
}

function targetCreate(
  overrides: Partial<RawEvent<'target.cell.create'>> = {},
): RawEvent<'target.cell.create'> {
  return {
    id: 'evt-create-001',
    schemaVersion: 1,
    kind: 'target.cell.create',
    projectId: 'proj-a',
    fileId: 'file-x',
    cellId: 'cell-1',
    parentId: null,
    author: 'alice',
    payload: { cellId: 'cell-1', value: 'hello', valueHtml: '<p>hello</p>' },
    clientTs: 1000,
    ...overrides,
  }
}

function targetCommit(
  overrides: Partial<RawEvent<'target.cell.commit'>> = {},
): RawEvent<'target.cell.commit'> {
  return {
    id: 'evt-commit-001',
    schemaVersion: 1,
    kind: 'target.cell.commit',
    projectId: 'proj-a',
    fileId: 'file-x',
    cellId: 'cell-1',
    parentId: 'evt-create-001',
    author: 'alice',
    payload: { value: 'updated', valueHtml: '<p>updated</p>' },
    clientTs: 2000,
    ...overrides,
  }
}

function sourceCreate(
  overrides: Partial<RawEvent<'source.cell.create'>> = {},
): RawEvent<'source.cell.create'> {
  return {
    id: 'evt-src-create-001',
    schemaVersion: 1,
    kind: 'source.cell.create',
    projectId: 'proj-a',
    fileId: 'file-x',
    cellId: 'cell-1',
    parentId: null,
    author: 'import-bot',
    payload: { cellId: 'cell-1', value: 'source text' },
    clientTs: 0,
    ...overrides,
  }
}

function validate(
  overrides: Partial<RawEvent<'cell.validate'>> = {},
): RawEvent<'cell.validate'> {
  return {
    id: 'evt-validate-001',
    schemaVersion: 1,
    kind: 'cell.validate',
    projectId: 'proj-a',
    fileId: 'file-x',
    cellId: 'cell-1',
    parentId: 'evt-create-001',
    author: 'bob',
    payload: { editEventId: 'evt-create-001' },
    clientTs: 3000,
    ...overrides,
  }
}

function makeEnv(db?: AquillaDb, secret: string | undefined = SECRET) {
  return { AQUILLA_PG: db, SYNC_SECRET_KEY: secret }
}

async function makeRequest(events: unknown[], token?: string): Promise<Request> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token !== undefined) headers['Authorization'] = `Bearer ${token}`
  return new Request('https://worker/events', {
    method: 'POST',
    headers,
    body: JSON.stringify({ events }),
  })
}

// ── URL / method / env / body ──────────────────────────────────────────

describe('POST /events — wiring', () => {
  it('returns null for non-/events URLs', async () => {
    const req = new Request('https://worker/admin/projects/p1/rebuild-projection', { method: 'POST' })
    expect(await handleEventsWriteRequest(req, makeEnv((await makeTestDb()).db))).toBeNull()
  })

  it('returns 405 for non-POST', async () => {
    const req = new Request('https://worker/events', { method: 'GET' })
    const res = (await handleEventsWriteRequest(req, makeEnv((await makeTestDb()).db)))!
    expect(res.status).toBe(405)
  })

  it('returns 500 when SYNC_SECRET_KEY missing', async () => {
    const req = new Request('https://worker/events', {
      method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' },
    })
    const res = (await handleEventsWriteRequest(req, { AQUILLA_PG: (await makeTestDb()).db, SYNC_SECRET_KEY: undefined }))!
    expect(res.status).toBe(500)
  })

  it('returns 400 for invalid JSON body', async () => {
    const req = new Request('https://worker/events', {
      method: 'POST', body: 'not json', headers: { 'Content-Type': 'text/plain' },
    })
    const res = (await handleEventsWriteRequest(req, makeEnv((await makeTestDb()).db)))!
    expect(res.status).toBe(400)
  })

  it('returns 200 with empty arrays for an empty batch', async () => {
    const token = await makeToken()
    const res = (await handleEventsWriteRequest(await makeRequest([], token), makeEnv((await makeTestDb()).db)))!
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.accepted).toEqual([])
    expect(body.rejected).toEqual([])
  })
})

// ── Author / authorization ─────────────────────────────────────────────

describe('POST /events — authorization', () => {
  it('writes the token username as the events.author (not the client-supplied author)', async () => {
    const token = await makeToken({ username: 'token-alice' })
    const event = targetCreate({ author: 'mallory' })
    const { db, snapshot } = await makeTestDb()
    await handleEventsWriteRequest(await makeRequest([event], token), makeEnv(db))
    const tables = (await snapshot())
    expect(tables.events[0].author).toBe('token-alice')
  })

  it('rejects source.cell.* from a CONTRIBUTOR token with 403', async () => {
    const token = await makeToken({ role: 400 })
    const event = sourceCreate()
    const { db, snapshot } = await makeTestDb()
    const res = (await handleEventsWriteRequest(await makeRequest([event], token), makeEnv(db)))!
    const body = await res.json() as any
    expect(body.rejected).toHaveLength(1)
    expect(body.rejected[0].status).toBe(403)
  })

  it('accepts source.cell.* from a PROJECT_LEAD token', async () => {
    const token = await makeToken({ role: 500 })
    const event = sourceCreate()
    const { db, snapshot } = await makeTestDb()
    const res = (await handleEventsWriteRequest(await makeRequest([event], token), makeEnv(db)))!
    const body = await res.json() as any
    expect(body.accepted).toHaveLength(1)
    expect((await snapshot()).events[0].kind).toBe('source.cell.create')
  })

  it('rejects target.cell.commit from a COMMENTER token (< CONTRIBUTOR)', async () => {
    const token = await makeToken({ role: 200 })
    const event = targetCommit()
    const { db, snapshot } = await makeTestDb()
    const res = (await handleEventsWriteRequest(await makeRequest([event], token), makeEnv(db)))!
    const body = await res.json() as any
    expect(body.rejected[0].status).toBe(403)
  })
})

// ── server_seq monotonicity ────────────────────────────────────────────

describe('POST /events — server_seq', () => {
  it('assigns a monotonically increasing server_seq per project', async () => {
    const token = await makeToken()
    const { db, snapshot } = await makeTestDb()
    const events = [
      targetCreate({ id: 'a', cellId: 'cell-1', payload: { cellId: 'cell-1', value: '1' } }),
      targetCreate({ id: 'b', cellId: 'cell-2', payload: { cellId: 'cell-2', value: '2' } }),
      targetCreate({ id: 'c', cellId: 'cell-3', payload: { cellId: 'cell-3', value: '3' } }),
    ]
    await handleEventsWriteRequest(await makeRequest(events, token), makeEnv(db))
    const tables = (await snapshot())
    expect(tables.events).toHaveLength(3)
    const seqs = tables.events.map((e: any) => e.server_seq).sort((a: number, b: number) => a - b)
    expect(seqs).toEqual([1, 2, 3])
  })

  it('two concurrent /events requests for the same project produce strictly distinct seqs', async () => {
    // server_seq is now derived inside each events INSERT via a correlated
    // subquery, so within a single batch each statement picks the next seq
    // from the just-inserted prior row, and concurrent batches serialise at
    // the database primary. The pre-fix code read MAX once per request in JS and
    // pre-computed seqs, which collided on the UNIQUE INDEX
    // idx_events_project_seq under concurrency.
    //
    // The in-memory fake cannot deterministically interleave two route
    // handlers across microtasks the way real Postgres interleaves HTTP requests,
    // so this test mostly documents the contract; the fake additionally
    // enforces the UNIQUE constraint, so any code path that produces a
    // duplicate (project_id, server_seq) trips loudly.
    const token = await makeToken()
    const { db, snapshot } = await makeTestDb()

    const batchA = [
      targetCreate({ id: 'a1', cellId: 'cell-a1', payload: { cellId: 'cell-a1', value: 'a1' } }),
      targetCreate({ id: 'a2', cellId: 'cell-a2', payload: { cellId: 'cell-a2', value: 'a2' } }),
    ]
    const batchB = [
      targetCreate({ id: 'b1', cellId: 'cell-b1', payload: { cellId: 'cell-b1', value: 'b1' } }),
      targetCreate({ id: 'b2', cellId: 'cell-b2', payload: { cellId: 'cell-b2', value: 'b2' } }),
    ]

    await Promise.all([
      handleEventsWriteRequest(await makeRequest(batchA, token), makeEnv(db)),
      handleEventsWriteRequest(await makeRequest(batchB, token), makeEnv(db)),
    ])

    const tables = (await snapshot())
    expect(tables.events).toHaveLength(4)
    const seqs = tables.events.map((e: any) => e.server_seq).sort((a: number, b: number) => a - b)
    expect(new Set(seqs).size).toBe(4)
    expect(seqs).toEqual([1, 2, 3, 4])
  })
})

// ── AD-2 parent-chain rule ─────────────────────────────────────────────

describe('POST /events — AD-2 first-child-of-parent', () => {
  it('cell commits follow first-child-of-parent: a later sibling is logged but does NOT overwrite the projection', async () => {
    const token = await makeToken()
    const { db, snapshot } = await makeTestDb()

    // Genesis create.
    const create = targetCreate({ id: 'evt-create-001' })
    const r0 = await handleEventsWriteRequest(await makeRequest([create], token), makeEnv(db))
    expect((await r0!.json() as any).accepted).toHaveLength(1)

    // Two commits with the SAME parent_id — the Alice/Bob race from the
    // spec, or the equivalent offline-reconnect scenario where the
    // reconnected client's queued commit flushes long after a concurrent
    // online commit has already projected.
    //
    // Per AD-2 (03-data-model.md): the first commit accepted at this
    // parent_id wins the chain slot; the second is durably logged but
    // does NOT advance the projection. It is reported in `stale` so the
    // client outbox can surface "your edit was bumped" and offer a
    // promote-from-history affordance.
    const first = targetCommit({
      id: 'evt-first',
      parentId: 'evt-create-001',
      payload: { value: 'FIRST' },
    })
    const second = targetCommit({
      id: 'evt-second',
      parentId: 'evt-create-001',
      payload: { value: 'SECOND' },
    })

    const r1 = await handleEventsWriteRequest(await makeRequest([first], token), makeEnv(db))
    expect((await r1!.json() as any).accepted).toHaveLength(1)

    let cell = (await snapshot()).cells[0]
    expect(cell.value).toBe('FIRST')
    expect(cell.event_id).toBe('evt-first')

    // Second commit on the same parent: accepted (200, durable in `events`)
    // but flagged stale and projection is unchanged.
    const r2 = await handleEventsWriteRequest(await makeRequest([second], token), makeEnv(db))
    const body2 = await r2!.json() as any
    expect(body2.accepted).toHaveLength(1)
    expect(body2.rejected).toHaveLength(0)
    expect(body2.stale).toHaveLength(1)
    expect(body2.stale[0].id).toBe('evt-second')

    const events = (await snapshot()).events
    // Both events durably persisted.
    expect(events.find((e: any) => e.id === 'evt-first')).toBeDefined()
    expect(events.find((e: any) => e.id === 'evt-second')).toBeDefined()

    cell = (await snapshot()).cells[0]
    // Projection still pinned to the first-child winner.
    expect(cell.value).toBe('FIRST')
    expect(cell.event_id).toBe('evt-first')
  })

  it('idempotent replay: the same event id replayed twice keeps the same chain head', async () => {
    const token = await makeToken()
    const { db, snapshot } = await makeTestDb()

    const create = targetCreate({ id: 'evt-create-001' })
    await handleEventsWriteRequest(await makeRequest([create], token), makeEnv(db))
    await handleEventsWriteRequest(await makeRequest([create], token), makeEnv(db))

    const tables = (await snapshot())
    expect(tables.events).toHaveLength(1)
    expect(tables.cells).toHaveLength(1)
    expect(tables.cells[0].event_id).toBe('evt-create-001')
  })
})

// ── AQU-538 lane/side-qualified arbitration in the ROUTE pre-check ──────
//
// Regression tests for the PERF-2 batching of the chain-winner pre-check
// (prefetchChainWinners): it originally arbitrated on the UNQUALIFIED
// (cell, parent) slot, so a second lane's first commit — which legitimately
// shares its parent (the source head) with the default lane's first commit —
// was judged a losing sibling and dead-lettered as stale, and the same for a
// source correction arriving after a target commit pinned to the same head.
// The lane invariants were already pinned against isWinningChild
// (target-lang-lanes.test.ts §3), but the route no longer calls it — these
// pin them at the wire, where the "sparkle in a lane says Saved but the cell
// stays empty" bug escaped.

describe('POST /events — lane/side-qualified chain slots (route pre-check)', () => {
  const srcCreate = () =>
    sourceCreate({ id: 'evt-src', payload: { cellId: 'cell-1', value: 'source text' } })

  it("two lanes' first commits share the source parent and BOTH project (separate requests)", async () => {
    const leadToken = await makeToken({ role: 500 })
    const token = await makeToken()
    const { db, snapshot } = await makeTestDb()

    await handleEventsWriteRequest(await makeRequest([srcCreate()], leadToken), makeEnv(db))

    const defaultLane = targetCommit({
      id: 'evt-default',
      parentId: 'evt-src',
      payload: { value: 'English draft', sourceEventId: 'evt-src' },
    })
    const r1 = await handleEventsWriteRequest(await makeRequest([defaultLane], token), makeEnv(db))
    expect(((await r1!.json()) as any).stale).toHaveLength(0)

    const esLane = targetCommit({
      id: 'evt-es',
      parentId: 'evt-src',
      payload: { value: 'Hola draft', sourceEventId: 'evt-src', targetLang: 'es' },
    })
    const r2 = await handleEventsWriteRequest(await makeRequest([esLane], token), makeEnv(db))
    const body2 = (await r2!.json()) as any
    expect(body2.accepted).toHaveLength(1)
    // THE regression: this was `stale: [evt-es]` and the lane row never landed.
    expect(body2.stale).toHaveLength(0)

    const cells = (await snapshot()).cells
    const targets = cells.filter((c: any) => c.side === 'target')
    expect(targets.map((c: any) => [c.target_lang, c.value]).sort()).toEqual([
      ['', 'English draft'],
      ['es', 'Hola draft'],
    ])
    expect(targets.find((c: any) => c.target_lang === 'es')?.event_id).toBe('evt-es')
  })

  it('a source correction after a target commit on the same parent still projects', async () => {
    const leadToken = await makeToken({ role: 500 })
    const token = await makeToken()
    const { db, snapshot } = await makeTestDb()

    await handleEventsWriteRequest(await makeRequest([srcCreate()], leadToken), makeEnv(db))
    await handleEventsWriteRequest(
      await makeRequest(
        [targetCommit({ id: 'evt-tgt', parentId: 'evt-src', payload: { value: 'draft', sourceEventId: 'evt-src' } })],
        token,
      ),
      makeEnv(db),
    )

    const sourceFix: RawEvent<'source.cell.commit'> = {
      id: 'evt-src-fix',
      schemaVersion: 1,
      kind: 'source.cell.commit',
      projectId: 'proj-a',
      fileId: 'file-x',
      cellId: 'cell-1',
      parentId: 'evt-src',
      author: 'alice',
      payload: { value: 'corrected source' },
      clientTs: 3000,
    }
    const r = await handleEventsWriteRequest(await makeRequest([sourceFix], leadToken), makeEnv(db))
    const body = (await r!.json()) as any
    expect(body.accepted).toHaveLength(1)
    expect(body.stale).toHaveLength(0)

    const cells = (await snapshot()).cells
    const source = cells.find((c: any) => c.side === 'source')
    expect(source?.value).toBe('corrected source')
    expect(source?.event_id).toBe('evt-src-fix')
  })

  it('a broken-period ghost event blocks its slot until a projection rebuild surfaces it and unblocks the chain', async () => {
    // The unqualified-pre-check era (2026-06-10 → fix) dead-lettered lane
    // commits: accepted + logged in `events`, but no projection write and no
    // chain claim. Those ghosts still own their (lane-qualified) slot by the
    // AD-2 first-in-seq rule, so after the fix a NEW commit chaining on the
    // (empty) projection head loses to the ghost every time — the user-facing
    // "draft was outdated ... not saved" loop. The heal is the projection
    // rebuild: replay projects the ghost, the client revalidates to the real
    // lane head, and the next commit chains cleanly.
    const leadToken = await makeToken({ role: 500 })
    const token = await makeToken()
    const { db, snapshot } = await makeTestDb()

    await handleEventsWriteRequest(await makeRequest([srcCreate()], leadToken), makeEnv(db))
    await handleEventsWriteRequest(
      await makeRequest(
        [targetCommit({ id: 'evt-ghost', parentId: 'evt-src', payload: { value: 'ghost draft', targetLang: 'es' } })],
        token,
      ),
      makeEnv(db),
    )
    // Reproduce the broken-period artifact: the event row stays, but its
    // projection row and chain claim never existed.
    await db.prepare(`DELETE FROM cells WHERE target_lang = 'es'`).run()
    await db.prepare(`DELETE FROM chain_claims WHERE parent_key LIKE '%@lane:es'`).run()

    // A fresh commit chains on the projection head (the source event, since
    // the lane looks untranslated) — and loses the slot to the ghost.
    const retry = targetCommit({
      id: 'evt-retry',
      parentId: 'evt-src',
      payload: { value: 'retry draft', targetLang: 'es' },
    })
    const r1 = await handleEventsWriteRequest(await makeRequest([retry], token), makeEnv(db))
    const body1 = (await r1!.json()) as any
    expect(body1.stale.map((s: any) => s.id)).toEqual(['evt-retry'])
    expect((await snapshot()).cells.find((c: any) => c.target_lang === 'es')).toBeUndefined()

    // Realistic log noise: an assignment event whose projection is built by
    // handleAssignmentEvent, not buildEventProjectionStmts. The rebuild must
    // SKIP it (regression: it aborted the replay mid-way, stranding the
    // project on a partially rebuilt projection).
    const assignmentEvent = {
      id: 'evt-assign',
      schemaVersion: 1,
      kind: 'assignment.create',
      projectId: 'proj-a',
      fileId: 'file-x',
      cellId: null,
      parentId: null,
      author: 'alice',
      payload: {
        assignmentId: 'as-1',
        scopeKind: 'books',
        scope: [{ fileId: 'file-x' }],
        scopeLabel: 'Sample',
        assigneeUserId: 1,
      },
      clientTs: 4000,
    }
    const rAssign = await handleEventsWriteRequest(
      await makeRequest([assignmentEvent], leadToken),
      makeEnv(db),
    )
    expect(((await rAssign!.json()) as any).accepted).toHaveLength(1)

    // Heal: rebuild replays the log with lane-qualified arbitration and
    // projects the ghost as the lane head.
    const rebuildRes = (await handleRebuildProjectionRequest(
      new Request('https://worker/admin/projects/proj-a/rebuild-projection', {
        method: 'POST',
        headers: { Authorization: `Bearer ${SECRET}` },
      }),
      makeEnv(db) as never,
    ))!
    expect(rebuildRes.status).toBe(200)
    const healed = (await snapshot()).cells.find((c: any) => c.target_lang === 'es')
    expect(healed?.value).toBe('ghost draft')
    expect(healed?.event_id).toBe('evt-ghost')

    // The chain is unblocked: the client's revalidate now sees evt-ghost as
    // the lane head, and a commit chaining on it applies.
    const next = targetCommit({
      id: 'evt-next',
      parentId: 'evt-ghost',
      payload: { value: 'post-heal draft', targetLang: 'es' },
    })
    const r2 = await handleEventsWriteRequest(await makeRequest([next], token), makeEnv(db))
    expect(((await r2!.json()) as any).stale).toHaveLength(0)
    expect((await snapshot()).cells.find((c: any) => c.target_lang === 'es')?.value).toBe('post-heal draft')
  })

  it('a same-lane sibling still loses its slot (AD-2 preserved per lane)', async () => {
    const leadToken = await makeToken({ role: 500 })
    const token = await makeToken()
    const { db, snapshot } = await makeTestDb()

    await handleEventsWriteRequest(await makeRequest([srcCreate()], leadToken), makeEnv(db))
    await handleEventsWriteRequest(
      await makeRequest(
        [targetCommit({ id: 'evt-es-1', parentId: 'evt-src', payload: { value: 'primero', targetLang: 'es' } })],
        token,
      ),
      makeEnv(db),
    )
    const sibling = targetCommit({
      id: 'evt-es-2',
      parentId: 'evt-src',
      payload: { value: 'segundo', targetLang: 'es' },
    })
    const r = await handleEventsWriteRequest(await makeRequest([sibling], token), makeEnv(db))
    const body = (await r!.json()) as any
    expect(body.accepted).toHaveLength(1)
    expect(body.stale).toHaveLength(1)
    expect(body.stale[0].id).toBe('evt-es-2')

    const es = (await snapshot()).cells.find((c: any) => c.side === 'target' && c.target_lang === 'es')
    expect(es?.value).toBe('primero')
    expect(es?.event_id).toBe('evt-es-1')
  })
})

// ── AD-9 source pin ────────────────────────────────────────────────────

describe('POST /events — AD-9 source_event_id pin', () => {
  it('target.cell.commit writes payload.sourceEventId into cells.source_event_id', async () => {
    const token = await makeToken()
    const { db, snapshot } = await makeTestDb()

    await handleEventsWriteRequest(
      await makeRequest([targetCreate({ id: 'evt-create-001' })], token),
      makeEnv(db),
    )
    const commit = targetCommit({
      id: 'evt-commit-001',
      parentId: 'evt-create-001',
      payload: {
        value: 'translated',
        valueHtml: '<p>translated</p>',
        sourceEventId: 'src-pin-99',
      },
    })
    await handleEventsWriteRequest(await makeRequest([commit], token), makeEnv(db))

    const cell = (await snapshot()).cells[0]
    expect(cell.source_event_id).toBe('src-pin-99')
  })

  it('target.cell.commit without sourceEventId leaves source_event_id NULL', async () => {
    const token = await makeToken()
    const { db, snapshot } = await makeTestDb()
    await handleEventsWriteRequest(
      await makeRequest([targetCreate({ id: 'evt-create-001' })], token),
      makeEnv(db),
    )
    await handleEventsWriteRequest(
      await makeRequest([targetCommit({ id: 'evt-commit-001' })], token),
      makeEnv(db),
    )
    const cell = (await snapshot()).cells[0]
    expect(cell.source_event_id).toBeNull()
  })
})

// ── Validation ─────────────────────────────────────────────────────────

describe('POST /events — cell.validate', () => {
  it('marks the cell validated when the validator targets the current chain head', async () => {
    const token = await makeToken({ role: 400 })
    const reviewerToken = await makeToken({ role: 300, username: 'reviewer-bob' })
    const { db, snapshot } = await makeTestDb()
    await handleEventsWriteRequest(
      await makeRequest([targetCreate({ id: 'evt-create-001' })], token),
      makeEnv(db),
    )
    await handleEventsWriteRequest(
      await makeRequest([validate({ payload: { editEventId: 'evt-create-001' } })], reviewerToken),
      makeEnv(db),
    )
    const cell = (await snapshot()).cells[0]
    expect(cell.validated).toBe(1)
  })

  it('validation for a prior edit does NOT mark the cell validated after a new commit', async () => {
    const token = await makeToken({ role: 400 })
    const reviewerToken = await makeToken({ role: 300, username: 'reviewer-bob' })
    const { db, snapshot } = await makeTestDb()

    await handleEventsWriteRequest(
      await makeRequest([targetCreate({ id: 'evt-create-001' })], token),
      makeEnv(db),
    )
    // Validate the create event.
    await handleEventsWriteRequest(
      await makeRequest([validate({ payload: { editEventId: 'evt-create-001' } })], reviewerToken),
      makeEnv(db),
    )
    expect((await snapshot()).cells[0].validated).toBe(1)

    // A new commit advances the chain head — validated should flip to 0.
    await handleEventsWriteRequest(
      await makeRequest([targetCommit({ id: 'evt-commit-new', parentId: 'evt-create-001' })], token),
      makeEnv(db),
    )
    expect((await snapshot()).cells[0].validated).toBe(0)
  })
})

// ── PERF-2: request-scoped query batching ──────────────────────────────

/**
 * Wrap an AquillaDb so every statement EXECUTION outside `batch()` is
 * counted (one execution ≈ one Hyperdrive round-trip in prod). Statements
 * passed to `batch()` are unwrapped back to the shim's own objects because
 * PostgresDb.batch reaches into their internals (`_on`).
 */
function makeCountingDb(db: AquillaDb): { db: AquillaDb; counts: { statements: number; batches: number } } {
  const counts = { statements: 0, batches: 0 }
  const originals = new WeakMap<AquillaStatement, AquillaStatement>()
  const wrapStmt = (stmt: AquillaStatement): AquillaStatement => {
    const wrapped: AquillaStatement = {
      bind: (...args: unknown[]) => wrapStmt(stmt.bind(...args)),
      all: <T,>() => { counts.statements++; return stmt.all<T>() },
      run: <T,>() => { counts.statements++; return stmt.run<T>() },
      first: <T,>(colName?: string) => { counts.statements++; return stmt.first<T>(colName) },
      raw: <T,>() => { counts.statements++; return stmt.raw<T>() },
    }
    originals.set(wrapped, stmt)
    return wrapped
  }
  const counting: AquillaDb = {
    prepare: (query) => wrapStmt(db.prepare(query)),
    batch: <T,>(stmts: AquillaStatement[]) => {
      counts.batches++
      return db.batch<T>(stmts.map((s) => originals.get(s) ?? s))
    },
    exec: (query) => db.exec(query),
    close: () => db.close(),
  }
  return { db: counting, counts }
}

describe('POST /events — PERF-2 batched pre-checks', () => {
  // One request of 3n events exercising every formerly-per-event pre-check:
  // n creates + n pinned commits (idempotency + AD-2 chain pre-check +
  // F5 source-pin) and n validates (project_settings).
  function makeBatch(n: number): RawEvent[] {
    const events: RawEvent[] = []
    for (let i = 0; i < n; i++) {
      const cell = `cell-${i}`
      events.push(
        targetCreate({
          id: `evt-create-${i}`,
          cellId: cell,
          payload: { cellId: cell, value: `v${i}` },
        }),
        targetCommit({
          id: `evt-commit-${i}`,
          cellId: cell,
          parentId: `evt-create-${i}`,
          payload: { value: `w${i}`, valueHtml: `<p>w${i}</p>`, sourceEventId: `pin-${i}` },
        }),
        validate({
          id: `evt-validate-${i}`,
          cellId: cell,
          parentId: `evt-create-${i}`,
          payload: { editEventId: `evt-commit-${i}` },
        }),
      )
    }
    return events
  }

  async function statementsFor(n: number): Promise<number> {
    const token = await makeToken()
    const { db } = await makeTestDb()
    // Settings row present so the validate path actually reads settings.
    await db
      .prepare(
        `INSERT INTO project_settings (project_id, settings, version, updated_at)
         VALUES (?, ?, 1, CURRENT_TIMESTAMP)`,
      )
      .bind('proj-a', '{}')
      .run()
    const { db: counting, counts } = makeCountingDb(db)
    const res = await handleEventsWriteRequest(
      await makeRequest(makeBatch(n), token),
      makeEnv(counting),
    )
    const body = (await res!.json()) as any
    expect(body.accepted).toHaveLength(3 * n)
    expect(body.rejected).toHaveLength(0)
    expect(body.stale).toHaveLength(0)
    expect(body.staleSource).toHaveLength(0)
    return counts.statements
  }

  it('pre-check queries do not scale with batch size (one batched read per concern, not per event)', async () => {
    // The WHY: a 100-event outbox flush used to cost ~2N+ serial Hyperdrive
    // round-trips in pre-checks alone (idempotency, isWinningChild, source
    // pin, settings — audit PERF-2). Each concern must now be ONE batched
    // read per request, so the count is identical for 2 and 8 events of the
    // same kind mix. Any reintroduced per-event query fails this.
    const [small, large] = [await statementsFor(2), await statementsFor(8)]
    expect(large).toBe(small)
  }, 120_000)
})

// ── ProjectSync fan-out ────────────────────────────────────────────────

describe('POST /events — ProjectSync event.applied fan-out', () => {
  function makeProjectSyncEnv(db: AquillaDb) {
    const bodies: Array<Record<string, unknown>> = []
    const stubFetch = vi.fn().mockImplementation(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    })
    const env = {
      ...makeEnv(db),
      ProjectSync: {
        idFromName: vi.fn().mockReturnValue({ id: 'do-id' }),
        get: vi.fn().mockReturnValue({ fetch: stubFetch }),
      } as unknown as DurableObjectNamespace,
    }
    return { env, bodies }
  }

  it('stamps the authenticated username into event.applied as `by` (not the client-supplied author)', async () => {
    // The client suppresses the "changed elsewhere" banner when
    // `by === currentUsername`. `by` must come from the verified JWT claims —
    // trusting the raw event's author field would let a buggy/malicious
    // client spoof someone else's identity to suppress (or trigger) banners.
    const token = await makeToken({ username: 'alice' })
    const { db } = await makeTestDb()
    const { env, bodies } = makeProjectSyncEnv(db)

    const res = await handleEventsWriteRequest(
      await makeRequest([targetCreate({ author: 'mallory' })], token),
      env,
    )
    expect(res?.status).toBe(200)

    const applied = bodies.filter((b) => b.t === 'event.applied')
    expect(applied.length).toBe(1)
    expect(applied[0].cell).toBe('cell-1')
    expect(applied[0].by).toBe('alice')
  })

  it('batches all of a project\'s frames into ONE __broadcast subrequest (PERF-8)', async () => {
    // The WHY: per-event fan-out burned ~1 subrequest per committed event
    // against Cloudflare's 1000-subrequest cap, so a large flush could
    // starve the request of subrequest budget. Multi-event requests must
    // send a single broadcast.batch envelope per project; the DO unpacks it
    // into the same per-event WS frames (see unpackBroadcastBody tests).
    const token = await makeToken({ username: 'alice' })
    const { db } = await makeTestDb()
    const { env, bodies } = makeProjectSyncEnv(db)

    const events = [
      targetCreate({ id: 'e1', cellId: 'c1', payload: { cellId: 'c1', value: '1' } }),
      targetCreate({ id: 'e2', cellId: 'c2', payload: { cellId: 'c2', value: '2' } }),
      targetCreate({ id: 'e3', cellId: 'c3', payload: { cellId: 'c3', value: '3' } }),
    ]
    const res = await handleEventsWriteRequest(await makeRequest(events, token), env)
    expect(res?.status).toBe(200)

    expect(bodies).toHaveLength(1)
    expect(bodies[0].t).toBe('broadcast.batch')
    const messages = bodies[0].messages as Array<Record<string, unknown>>
    expect(messages.map((m) => m.id)).toEqual(['e1', 'e2', 'e3'])
    for (const m of messages) {
      expect(m.t).toBe('event.applied')
      expect(m.by).toBe('alice')
      expect(m.project).toBe('proj-a')
    }
  })

  it("marks Agent API writes with `via: 'external'` so the owner's own client refetches", async () => {
    // The token bridge (external/token-bridge.ts) mints internal sync tokens
    // with src: 'external' for Agent API commits, and `by` is the credential
    // OWNER's username. If that owner has the project open, no outbox write
    // happened in their browser — without this marker, isOwnWriteEcho would
    // swallow the frame and the editor would never show the agent's committed
    // translation until a manual reload.
    const token = await makeToken({ username: 'alice', src: 'external' })
    const { db } = await makeTestDb()
    const { env, bodies } = makeProjectSyncEnv(db)

    const res = await handleEventsWriteRequest(await makeRequest([targetCreate()], token), env)
    expect(res?.status).toBe(200)

    const applied = bodies.filter((b) => b.t === 'event.applied')
    expect(applied.length).toBe(1)
    expect(applied[0].by).toBe('alice')
    expect(applied[0].via).toBe('external')
  })

  it('browser-token role-resolution `src` values do NOT leak a `via` marker', async () => {
    // Regular sync tokens reuse `src` for the role-resolution path (AQU-346:
    // 'override' | 'group' | 'org' | 'creator' | 'platform'). None of those
    // may set `via`, or the own-write echo suppression (and its double-fetch
    // savings) silently regresses for every browser write.
    const token = await makeToken({ username: 'alice', src: 'org' })
    const { db } = await makeTestDb()
    const { env, bodies } = makeProjectSyncEnv(db)

    const res = await handleEventsWriteRequest(await makeRequest([targetCreate()], token), env)
    expect(res?.status).toBe(200)

    const applied = bodies.filter((b) => b.t === 'event.applied')
    expect(applied.length).toBe(1)
    expect('via' in applied[0]).toBe(false)
  })
})

// Concurrent-write regression tests (audit 2026-06-10: RACE-1, RACE-2,
// PERF-5 → tasks M0-4 unit half / M1-1 / M1-2).
//
// PGlite is single-connection, so two truly concurrent transactions can't be
// interleaved here. Instead the races are simulated deterministically:
//   - RACE-2's TOCTOU is reproduced by putting two siblings of one parent in
//     the SAME request batch — the pre-insert guard runs for both before
//     either row is committed, exactly like two racing requests.
//   - RACE-1's allocator drift is reproduced by pre-seeding the state a
//     concurrent writer would have committed (events ahead of the counter).
//
// Contracts under test:
//   (a) server_seq allocation never reuses a seq and never silently drops an
//       event-log row; cells.event_id always references an existing event.
//   (b) two chain-mutating children of one parent: exactly one advances the
//       projection, the loser is reported via the response `stale` array
//       (the client banner contract) while still landing in `events`.
//   (c) rebuild's tie-break (first sibling by server_seq) agrees with the
//       live outcome, so replay == live.

import { describe, it, expect, beforeEach } from 'vitest'
import { vi } from 'vitest'

// route.ts imports broadcast.ts → partyserver (cloudflare:* imports).
vi.mock('partyserver', () => ({
  getServerByName: vi.fn().mockResolvedValue({
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  }),
}))

import { handleEventsWriteRequest } from '../events/route'
import { handleRebuildProjectionRequest } from '../events/rebuild'
import { handleBulkImportRequest } from '../events/import-route'
import { handleCellHistoryReadRequest } from '../events/cell-history-read-route'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'
import { makeTestToken } from './helpers/auth'
import type { RawEvent } from '../events/types'
import { buildChainClaimStmt } from '../events/chain-claims'
import { buildEventProjectionStmts } from '../events/event-projection'

const SECRET = 'test-secret'
const PROJECT = 'proj-a'
const FILE = 'file-x'

interface EventsResponse {
  accepted: Array<{ id: string }>
  rejected: Array<{ id: string; status: number; reason: string }>
  stale: Array<{ id: string; fileId: string | null; cellId: string | null }>
  staleSource: unknown[]
}

function commit(
  id: string,
  parentId: string | null,
  value: string,
  cellId = 'cell-1',
): RawEvent<'target.cell.commit'> {
  return {
    id,
    schemaVersion: 1,
    kind: 'target.cell.commit',
    projectId: PROJECT,
    fileId: FILE,
    cellId,
    parentId,
    author: 'alice',
    payload: { value },
    clientTs: 1000,
  }
}

async function postEvents(
  db: AquillaDb,
  events: unknown[],
  role = 400,
): Promise<EventsResponse> {
  const token = await makeTestToken(SECRET, { projectId: PROJECT, fileId: FILE, role })
  const req = new Request('https://worker/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ events }),
  })
  const res = await handleEventsWriteRequest(req, { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET })
  expect(res).not.toBeNull()
  expect(res!.status).toBe(200)
  return (await res!.json()) as EventsResponse
}

interface EventRow {
  id: string
  server_seq: number
}

async function eventRows(t: TestDb): Promise<EventRow[]> {
  return (
    await t.pg.query<EventRow>(
      `SELECT id, server_seq FROM events WHERE project_id = $1 ORDER BY server_seq`,
      [PROJECT],
    )
  ).rows
}

async function counterValue(t: TestDb): Promise<number | null> {
  const r = await t.pg.query<{ last_seq: number }>(
    `SELECT last_seq FROM project_seq_counters WHERE project_id = $1`,
    [PROJECT],
  )
  return r.rows[0]?.last_seq ?? null
}

async function headOf(t: TestDb, cellId = 'cell-1'): Promise<{ event_id: string; value: string } | null> {
  const r = await t.pg.query<{ event_id: string; value: string }>(
    `SELECT event_id, value FROM cells WHERE project_id = $1 AND file_id = $2 AND cell_id = $3 AND side = 'target'`,
    [PROJECT, FILE, cellId],
  )
  return r.rows[0] ?? null
}

/** (a)-invariant: every cells.event_id references a row that exists in events. */
async function assertNoGhostHeads(t: TestDb): Promise<void> {
  const r = await t.pg.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM cells c
     WHERE NOT EXISTS (SELECT 1 FROM events e WHERE e.id = c.event_id)`,
  )
  expect(r.rows[0].n).toBe(0)
}

let t: TestDb

beforeEach(async () => {
  t = await makeTestDb({
    files: [
      {
        id: FILE,
        project_id: PROJECT,
        name: 'Genesis',
        event_id: 'evt-file-genesis',
        meta: '{}',
      },
    ],
  })
})

// ── (b) + RACE-2: two children of one parent ──────────────────────────────

describe('AD-2 first-child arbitration is atomic (RACE-2)', () => {
  it('two siblings of one parent in the same batch: exactly one wins, the loser is reported stale', async () => {
    const r1 = await postEvents(t.db, [commit('evt-c1', null, 'base')])
    expect(r1.accepted.map((a) => a.id)).toEqual(['evt-c1'])
    expect(r1.stale).toEqual([])

    // Both siblings chain to evt-c1. The pre-insert guard sees no committed
    // sibling for either — the same window two concurrent requests hit.
    const r2 = await postEvents(t.db, [
      commit('evt-c2', 'evt-c1', 'alice wins'),
      commit('evt-c3', 'evt-c1', 'bob loses'),
    ])

    // Both are accepted (logged) — but only the FIRST advances the chain.
    expect(r2.accepted.map((a) => a.id).sort()).toEqual(['evt-c2', 'evt-c3'])
    expect(r2.rejected).toEqual([])

    // The loser MUST be flagged stale so the client banner fires (M1-2).
    expect(r2.stale).toEqual([{ id: 'evt-c3', fileId: FILE, cellId: 'cell-1' }])

    // The projection holds the winner, not last-write-wins.
    const head = await headOf(t)
    expect(head?.event_id).toBe('evt-c2')
    expect(head?.value).toBe('alice wins')

    // The loser still lands in the event log (it is history).
    const rows = await eventRows(t)
    expect(rows.map((r) => r.id)).toContain('evt-c3')
    await assertNoGhostHeads(t)
  })

  it('a temporally separated sibling is still reported stale and does not advance the projection', async () => {
    await postEvents(t.db, [commit('evt-c1', null, 'base')])
    await postEvents(t.db, [commit('evt-c2', 'evt-c1', 'first child')])

    const r3 = await postEvents(t.db, [commit('evt-c4', 'evt-c1', 'late offline edit')])
    expect(r3.accepted.map((a) => a.id)).toEqual(['evt-c4'])
    expect(r3.stale).toEqual([{ id: 'evt-c4', fileId: FILE, cellId: 'cell-1' }])

    const head = await headOf(t)
    expect(head?.event_id).toBe('evt-c2')
    await assertNoGhostHeads(t)
  })

  it('replaying the winning event is idempotent (still wins, no duplicate row)', async () => {
    await postEvents(t.db, [commit('evt-c1', null, 'base')])
    await postEvents(t.db, [commit('evt-c2', 'evt-c1', 'winner')])
    const replay = await postEvents(t.db, [commit('evt-c2', 'evt-c1', 'winner')])
    expect(replay.accepted.map((a) => a.id)).toEqual(['evt-c2'])
    expect(replay.stale).toEqual([])

    const rows = await eventRows(t)
    expect(rows.filter((r) => r.id === 'evt-c2')).toHaveLength(1)
    expect((await headOf(t))?.event_id).toBe('evt-c2')
  })
})

// ── (d) rebuild agrees with live ──────────────────────────────────────────

describe('rebuild tie-break agrees with the live outcome (replay == live)', () => {
  it('after a sibling race, rebuilding the projection reproduces the live winner', async () => {
    await postEvents(t.db, [commit('evt-c1', null, 'base')])
    await postEvents(t.db, [
      commit('evt-c2', 'evt-c1', 'alice wins'),
      commit('evt-c3', 'evt-c1', 'bob loses'),
    ])

    const liveHead = await headOf(t)
    expect(liveHead).not.toBeNull()

    const req = new Request(`https://worker/admin/projects/${PROJECT}/rebuild-projection`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${SECRET}` },
    })
    const res = await handleRebuildProjectionRequest(req, {
      AQUILLA_PG: t.db,
      SYNC_SECRET_KEY: SECRET,
    })
    expect(res).not.toBeNull()
    expect(res!.status).toBe(200)

    const rebuiltHead = await headOf(t)
    expect(rebuiltHead?.event_id).toBe(liveHead?.event_id)
    expect(rebuiltHead?.value).toBe(liveHead?.value)
    await assertNoGhostHeads(t)
  })
})

// ── (a) allocator: monotonic, drift-healing, no silent drops ──────────────

describe('per-project server_seq allocator (RACE-1 / PERF-5)', () => {
  it('assigns unique, increasing seqs across requests and tracks them in the counter', async () => {
    await postEvents(t.db, [commit('evt-c1', null, 'one')])
    await postEvents(t.db, [commit('evt-c2', 'evt-c1', 'two')])

    const rows = await eventRows(t)
    const seqs = rows.map((r) => Number(r.server_seq))
    expect(new Set(seqs).size).toBe(seqs.length)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))

    // The counter is the single allocator: it must be at MAX(server_seq).
    expect(await counterValue(t)).toBe(Math.max(...seqs))
    await assertNoGhostHeads(t)
  })

  it('seeds the counter from MAX(server_seq) for a project with pre-existing events', async () => {
    // Pre-cutover project: events exist, counter row does not.
    await t.pg.query(
      `INSERT INTO events (id, schema_version, project_id, file_id, cell_id, parent_id, kind, author, payload, client_ts, server_ts, server_seq)
       VALUES ('evt-legacy', 1, $1, $2, 'cell-1', NULL, 'target.cell.commit', 'alice', '{"value":"legacy"}', 1, 1, 5)`,
      [PROJECT, FILE],
    )
    expect(await counterValue(t)).toBeNull()

    await postEvents(t.db, [commit('evt-c1', 'evt-legacy', 'post-cutover')])

    const rows = await eventRows(t)
    const c1 = rows.find((r) => r.id === 'evt-c1')
    expect(Number(c1?.server_seq)).toBe(6)
    expect(await counterValue(t)).toBe(6)
  })

  it('self-heals when the counter is behind the event log (simulated racing writer)', async () => {
    // Simulate the state a concurrent/legacy writer would have committed:
    // an event holding seq 5 while the counter still says 2.
    await t.pg.query(
      `INSERT INTO events (id, schema_version, project_id, file_id, cell_id, parent_id, kind, author, payload, client_ts, server_ts, server_seq)
       VALUES ('evt-other-writer', 1, $1, $2, 'cell-9', NULL, 'target.cell.commit', 'bob', '{"value":"other"}', 1, 1, 5)`,
      [PROJECT, FILE],
    )
    await t.pg.query(
      `INSERT INTO project_seq_counters (project_id, last_seq) VALUES ($1, 2)`,
      [PROJECT],
    )

    // The next write must NOT reuse seq 3..5 (which would collide and, under
    // the old unqualified ON CONFLICT DO NOTHING, silently drop the log row).
    const r = await postEvents(t.db, [commit('evt-c1', null, 'healed')])
    expect(r.accepted.map((a) => a.id)).toEqual(['evt-c1'])
    expect(r.rejected).toEqual([])

    const rows = await eventRows(t)
    const c1 = rows.find((r2) => r2.id === 'evt-c1')
    // The event row exists (no silent drop) with a fresh seq past the log max.
    expect(c1).toBeDefined()
    expect(Number(c1!.server_seq)).toBe(6)
    expect(await counterValue(t)).toBe(6)
    await assertNoGhostHeads(t)
  })

  it('bulk import and interactive writes share the allocator (no overlapping seqs)', async () => {
    const token = await makeTestToken(SECRET, { projectId: PROJECT, fileId: FILE, role: 500 })
    const importReq = new Request('https://worker/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        projectId: PROJECT,
        fileId: FILE,
        file: { id: 'evt-file-genesis', name: 'Genesis' },
        cells: [
          { id: 'evt-src-1', cellId: 'cell-1', value: 'In the beginning' },
          { id: 'evt-src-2', cellId: 'cell-2', value: 'And the earth' },
        ],
      }),
    })
    const importRes = await handleBulkImportRequest(importReq, {
      AQUILLA_PG: t.db,
      SYNC_SECRET_KEY: SECRET,
    })
    expect(importRes!.status).toBe(200)

    await postEvents(t.db, [commit('evt-c1', null, 'translation')])

    const rows = await eventRows(t)
    const seqs = rows.map((r) => Number(r.server_seq))
    expect(new Set(seqs).size).toBe(seqs.length)
    expect(await counterValue(t)).toBe(Math.max(...seqs))
    await assertNoGhostHeads(t)
  })
})

// ── AQU-1154: head compare-and-swap (invariant I1) ────────────────────────
//
// First-child-of-parent alone lets a stale branch climb back onto the head:
// A1 and B1 both chain on H; A1 wins, B1 is stale — but B's client keeps
// chaining on ITS OWN stale head, and B2 (parent B1) finds the (cell, B1)
// slot unclaimed, so it won and overwrote A1; A2 (parent A1) then won back,
// and the head ping-ponged forever. The rule is now a compare-and-swap on the
// cell's current head: an event advances the projection iff its parentId IS
// the head for that side/lane at commit time (or the row does not exist yet).

async function rebuild(): Promise<void> {
  const req = new Request(`https://worker/admin/projects/${PROJECT}/rebuild-projection`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SECRET}` },
  })
  const res = await handleRebuildProjectionRequest(req, { AQUILLA_PG: t.db, SYNC_SECRET_KEY: SECRET })
  expect(res!.status).toBe(200)
}

describe('head compare-and-swap: a stale branch cannot climb back onto the head (AQU-1154)', () => {
  it('B2 chained on the stale sibling B1 is stale; A2 chained on the head A1 wins', async () => {
    await postEvents(t.db, [commit('evt-H', null, 'head')])

    const rA1 = await postEvents(t.db, [commit('evt-A1', 'evt-H', 'A1')])
    expect(rA1.stale).toEqual([])
    const rB1 = await postEvents(t.db, [commit('evt-B1', 'evt-H', 'B1')])
    expect(rB1.stale.map((s) => s.id)).toEqual(['evt-B1'])
    expect((await headOf(t))?.event_id).toBe('evt-A1')

    // THE bug: (cell, evt-B1) has no claim, so first-child let this win.
    const rB2 = await postEvents(t.db, [commit('evt-B2', 'evt-B1', 'B2')])
    expect(rB2.accepted.map((a) => a.id)).toEqual(['evt-B2'])
    expect(rB2.stale).toEqual([{ id: 'evt-B2', fileId: FILE, cellId: 'cell-1' }])
    expect((await headOf(t))?.event_id).toBe('evt-A1')
    expect((await headOf(t))?.value).toBe('A1')

    const rA2 = await postEvents(t.db, [commit('evt-A2', 'evt-A1', 'A2')])
    expect(rA2.stale).toEqual([])
    expect((await headOf(t))?.event_id).toBe('evt-A2')

    // Every event is still history.
    expect((await eventRows(t)).map((r) => r.id)).toEqual(
      expect.arrayContaining(['evt-A1', 'evt-B1', 'evt-B2', 'evt-A2']),
    )
    await assertNoGhostHeads(t)
  })

  it('a same-request chain C1 → C2 both advance (C1 moved the head earlier in the transaction)', async () => {
    await postEvents(t.db, [commit('evt-H', null, 'head')])
    const r = await postEvents(t.db, [
      commit('evt-C1', 'evt-H', 'C1'),
      commit('evt-C2', 'evt-C1', 'C2'),
    ])
    expect(r.accepted.map((a) => a.id)).toEqual(['evt-C1', 'evt-C2'])
    expect(r.stale).toEqual([])
    expect((await headOf(t))?.event_id).toBe('evt-C2')
  })

  it('the in-transaction cells write is itself a head CAS (an in-flight race the pre-check cannot see)', async () => {
    // Bypass the route pre-check: build B2's gated statements directly with a
    // claim it holds, against a row whose head is A1 — the shape an in-flight
    // request lands in after a concurrent A1 committed between its pre-check
    // and its transaction.
    await postEvents(t.db, [commit('evt-H', null, 'head')])
    await postEvents(t.db, [commit('evt-A1', 'evt-H', 'A1')])

    const gate = { projectId: PROJECT, fileId: FILE, cellId: 'cell-1', parentKey: 'evt-B1' }
    const stmts: AquillaStatement[] = [buildChainClaimStmt(t.db, gate, 'evt-B2')]
    buildEventProjectionStmts(
      t.db,
      {
        id: 'evt-B2',
        schemaVersion: 1,
        projectId: PROJECT,
        fileId: FILE,
        cellId: 'cell-1',
        parentId: 'evt-B1',
        kind: 'target.cell.commit',
        author: 'bob',
        payload: { value: 'B2' },
        clientTs: 1,
        serverTs: 1,
      },
      stmts,
      { chainGate: gate, deferFileCounters: true },
    )
    const results = await t.db.batch(stmts)
    // The claim was taken (slot was free) but the cells UPSERT changed nothing.
    expect(results[0].meta.changes).toBe(1)
    expect(results[1].meta.changes).toBe(0)
    expect((await headOf(t))?.event_id).toBe('evt-A1')
  })

  it('rebuild replays the same head-CAS rule, so replay == live for the A/B branch', async () => {
    await postEvents(t.db, [commit('evt-H', null, 'head')])
    await postEvents(t.db, [commit('evt-A1', 'evt-H', 'A1')])
    await postEvents(t.db, [commit('evt-B1', 'evt-H', 'B1')])
    await postEvents(t.db, [commit('evt-B2', 'evt-B1', 'B2')])
    await postEvents(t.db, [commit('evt-A2', 'evt-A1', 'A2')])
    const live = await headOf(t)
    expect(live?.event_id).toBe('evt-A2')

    await rebuild()
    const rebuilt = await headOf(t)
    expect(rebuilt?.event_id).toBe('evt-A2')
    expect(rebuilt?.value).toBe('A2')
    await assertNoGhostHeads(t)
  })

  it('never loses user data: the bumped branch (B1, B2) is durable with its full payload and served by the history route', async () => {
    // Invariant "never lose user data": a commit that loses the head CAS is
    // reported in `stale[]` (HTTP 200) but MUST still land in the event log
    // with its payload and parent pointer, and the per-cell history route
    // MUST return it — that is what lets the client drawer show it as a
    // bumped entry with "Promote to current".
    await postEvents(t.db, [commit('evt-H', null, 'head')])
    await postEvents(t.db, [commit('evt-A1', 'evt-H', 'A1')])
    const rB1 = await postEvents(t.db, [commit('evt-B1', 'evt-H', 'B1')])
    expect(rB1.stale.map((s) => s.id)).toEqual(['evt-B1'])
    const rB2 = await postEvents(t.db, [commit('evt-B2', 'evt-B1', 'B2')])
    expect(rB2.stale.map((s) => s.id)).toEqual(['evt-B2'])
    await postEvents(t.db, [commit('evt-A2', 'evt-A1', 'A2')])
    expect((await headOf(t))?.event_id).toBe('evt-A2')

    const token = await makeTestToken(SECRET, { projectId: PROJECT, fileId: FILE })
    const res = await handleCellHistoryReadRequest(
      new Request(`https://worker/api/v1/projects/${PROJECT}/files/${FILE}/cells/cell-1/history`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
      { AQUILLA_PG: t.db, SYNC_SECRET_KEY: SECRET },
    )
    expect(res!.status).toBe(200)
    const body = (await res!.json()) as {
      events: Array<{ id: string; parentId: string | null; payload: { value: string } }>
    }
    const byId = new Map(body.events.map((e) => [e.id, e]))
    // Newest-first by server_seq; every branch event is present.
    expect(body.events.map((e) => e.id)).toEqual(['evt-A2', 'evt-B2', 'evt-B1', 'evt-A1', 'evt-H'])
    expect(byId.get('evt-B1')).toMatchObject({ parentId: 'evt-H', payload: { value: 'B1' } })
    expect(byId.get('evt-B2')).toMatchObject({ parentId: 'evt-B1', payload: { value: 'B2' } })
    expect(byId.get('evt-A1')).toMatchObject({ parentId: 'evt-H', payload: { value: 'A1' } })
    expect(byId.get('evt-A2')).toMatchObject({ parentId: 'evt-A1', payload: { value: 'A2' } })
  })
})

// ── QW-10 guard: counters stay correct with batch-coalesced recompute ─────

describe('file counters after a multi-commit batch (QW-10 semantic guard)', () => {
  it('a batch of commits to one file leaves the rollup counters correct', async () => {
    await postEvents(t.db, [
      commit('evt-a', null, 'one two', 'cell-1'),
      commit('evt-b', null, 'three', 'cell-2'),
      commit('evt-c', null, 'four five six', 'cell-3'),
    ])

    const r = await t.pg.query<{ filled_count: number; word_count: number; cell_count: number }>(
      `SELECT filled_count, word_count, cell_count FROM files WHERE id = $1 AND project_id = $2`,
      [FILE, PROJECT],
    )
    expect(r.rows[0].filled_count).toBe(3)
    expect(r.rows[0].word_count).toBe(6)
    expect(r.rows[0].cell_count).toBe(3)
  })
})

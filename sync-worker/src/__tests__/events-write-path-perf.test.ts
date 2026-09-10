// perf/events-write-path: the single-cell commit hot path through POST /events.
//
// Measured on prod: one `target.cell.commit` cost ~7 standalone queries plus a
// 9–18 statement transaction executed one statement per round-trip, all while
// holding row locks on `cells`/`events` — mean single-row events INSERT 211ms
// (lock waits), hundreds of deadlocks. These tests pin the three structural
// fixes so a refactor cannot quietly reintroduce the shape:
//
//   1. the chunk commit goes through `batchPipelined` when the shim offers it
//      (one flight per statement wave instead of one round-trip per statement);
//   2. the full-file aggregate recomputes (files counters / progress) run in a
//      SECOND batch after the write transaction commits, so the transaction
//      holding the cell row locks stays short — and a recompute failure never
//      un-accepts events that are already committed;
//   3. the authority helpers behind authorize() read project/org settings at
//      most once per request, not once per event.

import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('partyserver', () => ({
  getServerByName: vi.fn().mockResolvedValue({
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  }),
}))

import { handleEventsWriteRequest } from '../events/route'
import { authorize } from '../events/authorize'
import { makeRequestCache } from '../events/request-cache'
import { ROLE } from '../events/role-policy'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'
import { makeTestToken } from './helpers/auth'
import type { RawEvent } from '../events/types'

const SECRET = 'test-secret'
const PROJECT = 'proj-a'
const FILE = 'file-x'

interface EventsResponse {
  accepted: Array<{ id: string }>
  rejected: Array<{ id: string; status: number; reason: string }>
  stale: Array<{ id: string; fileId: string | null; cellId: string | null }>
}

function commit(id: string, parentId: string | null, value: string, cellId = 'cell-1'): RawEvent<'target.cell.commit'> {
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

function sourceCreate(i: number): RawEvent<'source.cell.create'> {
  return {
    id: `evt-src-${i}`,
    schemaVersion: 1,
    kind: 'source.cell.create',
    projectId: PROJECT,
    fileId: FILE,
    cellId: `cell-${i}`,
    parentId: null,
    author: 'alice',
    payload: { cellId: `cell-${i}`, value: `src ${i}` },
    clientTs: 1000,
  }
}

async function post(db: AquillaDb, events: unknown[], role = ROLE.CONTRIBUTOR): Promise<EventsResponse> {
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

const sqlOf = (s: AquillaStatement): string => (s as unknown as { _sql(): string })._sql()

/**
 * Wrap a real (PGlite-backed) shim so every batch call is recorded with the
 * SQL texts it carried. `batchPipelined` is exposed only when `pipelined` is
 * set, so a test can also model a shim that lacks it. `failBatch(n)` makes
 * the n-th batch call reject (recompute-failure leg).
 */
function recordingDb(
  t: TestDb,
  opts: { pipelined: boolean; failBatch?: number } = { pipelined: true },
) {
  const batches: Array<{ via: 'batch' | 'batchPipelined'; sql: string[] }> = []
  const record = (via: 'batch' | 'batchPipelined', stmts: AquillaStatement[]) => {
    batches.push({ via, sql: stmts.map(sqlOf) })
    if (opts.failBatch === batches.length) throw new Error('simulated recompute failure')
  }
  const db: AquillaDb = {
    prepare: (q) => t.db.prepare(q),
    exec: (q) => t.db.exec(q),
    close: () => t.db.close(),
    batch: async (stmts) => {
      record('batch', stmts)
      return t.db.batch(stmts)
    },
    ...(opts.pipelined
      ? {
          batchPipelined: async (stmts: AquillaStatement[]) => {
            record('batchPipelined', stmts)
            return t.db.batchPipelined!(stmts)
          },
        }
      : {}),
  }
  return { db, batches }
}

const isWriteTxn = (sql: string[]) => sql.some((s) => s.includes('INSERT INTO events'))
const isCountersRecompute = (s: string) => s.includes('UPDATE files SET cell_count')
const isProgressRecompute = (s: string) => s.includes('INSERT INTO file_section_progress')

let t: TestDb | undefined
afterEach(async () => {
  await t?.close()
  t = undefined
})

describe('POST /events — chunk commit is pipelined', () => {
  it('commits the chunk through batchPipelined when the shim offers it, and still flags the in-flight chain loser', async () => {
    const td = (t = await makeTestDb())
    const { db, batches } = recordingDb(td)
    await post(db, [commit('evt-c1', null, 'base')])
    // Two siblings of one parent in ONE request: both pass the prefetched
    // pre-check, one loses inside the transaction. flagChainLosers reads that
    // loser off results[i].meta.changes — so the pipelined result array must
    // keep batch()'s exact index/shape contract or this silently stops firing.
    const r = await post(db, [commit('evt-c2', 'evt-c1', 'alice wins'), commit('evt-c3', 'evt-c1', 'bob loses')])
    expect(r.rejected).toEqual([])
    expect(r.accepted.map((a) => a.id)).toEqual(['evt-c2', 'evt-c3'])
    expect(r.stale).toEqual([{ id: 'evt-c3', fileId: FILE, cellId: 'cell-1' }])

    const writeTxns = batches.filter((b) => isWriteTxn(b.sql))
    expect(writeTxns.length).toBeGreaterThan(0)
    for (const b of writeTxns) expect(b.via).toBe('batchPipelined')
  })

  it('falls back to batch() when the shim has no batchPipelined', async () => {
    const td = (t = await makeTestDb())
    const { db, batches } = recordingDb(td, { pipelined: false })
    const r = await post(db, [commit('evt-c1', null, 'base')])
    expect(r.accepted).toEqual([{ id: 'evt-c1' }])
    expect(batches.filter((b) => isWriteTxn(b.sql)).every((b) => b.via === 'batch')).toBe(true)
  })
})

describe('POST /events — counter recompute runs after the write transaction', () => {
  it('keeps the full-file aggregate scans out of the transaction that holds the cell row locks', async () => {
    const td = (t = await makeTestDb({ files: [{ id: FILE, project_id: PROJECT, name: 'x' }] }))
    const { db, batches } = recordingDb(td)
    await post(db, [commit('evt-c1', null, 'one'), commit('evt-c2', null, 'two', 'cell-2')])

    const [writeTxn, ...rest] = batches
    expect(isWriteTxn(writeTxn.sql)).toBe(true)
    expect(writeTxn.sql.some(isCountersRecompute)).toBe(false)
    expect(writeTxn.sql.some(isProgressRecompute)).toBe(false)

    // Exactly ONE recompute batch for the one (file, chunk), carrying exactly
    // one files-counters recompute — same once-per-(file, chunk) coalescing as
    // before, just in its own short transaction after the commit.
    const recomputes = rest.filter((b) => b.sql.some(isCountersRecompute))
    expect(recomputes).toHaveLength(1)
    expect(recomputes[0].sql.filter(isCountersRecompute)).toHaveLength(1)
    expect(recomputes[0].sql.some(isProgressRecompute)).toBe(true)

    // And the counters are right by the time the response is built — the
    // recompute is awaited in the request, not fired into waitUntil.
    const files = await td.rows<{ id: string; cell_count: number; filled_count: number }>('files')
    expect(files.map((f) => [f.id, f.cell_count, f.filled_count])).toEqual([[FILE, 2, 2]])
  })

  it('a failed recompute is logged loudly but the committed events stay accepted', async () => {
    const td = (t = await makeTestDb())
    // Batch #1 is the write transaction, batch #2 the recompute.
    const { db } = recordingDb(td, { pipelined: true, failBatch: 2 })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const r = await post(db, [commit('evt-c1', null, 'base')])
      expect(r.accepted).toEqual([{ id: 'evt-c1' }])
      expect(r.rejected).toEqual([])
      // The event really is durable — the failure was only the follow-up.
      const events = await td.rows<{ id: string }>('events')
      expect(events.map((e) => e.id)).toEqual(['evt-c1'])
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('counter recompute failed'),
        expect.anything(),
      )
    } finally {
      error.mockRestore()
    }
  })
})

describe('authorize() — settings reads are memoized per request', () => {
  /** Counting fake: one row each in projects / org_settings / project_settings. */
  function countingDb() {
    const reads = { projects: 0, org_settings: 0, project_settings: 0 }
    const db = {
      prepare(sql: string) {
        return {
          bind() {
            return {
              async first() {
                if (sql.includes('FROM projects')) { reads.projects++; return { org_id: 7 } }
                if (sql.includes('FROM org_settings')) { reads.org_settings++; return { settings: JSON.stringify({ allowSelfAssignment: true }) } }
                if (sql.includes('FROM project_settings')) { reads.project_settings++; return { settings: JSON.stringify({ allowLineCreation: true }) } }
                return null
              },
              async all() { return { results: [] } },
            }
          },
        }
      },
    } as unknown as AquillaDb
    return { db, reads }
  }

  it('reads projects / org_settings / project_settings once for a whole batch sharing one cache', async () => {
    const { db, reads } = countingDb()
    const cache = makeRequestCache(db)
    const token = await makeTestToken(SECRET, { projectId: PROJECT, fileId: FILE, role: ROLE.CONTRIBUTOR, userId: 42 })
    const selfAssign = {
      id: 'a1', schemaVersion: 1, kind: 'assignment.create', projectId: PROJECT, fileId: FILE,
      parentId: null, author: 'alice', clientTs: 1,
      payload: { assignmentId: 'as-1', assigneeUserId: 42, scope: 'file' },
    } as unknown as RawEvent<'assignment.create'>
    for (let i = 0; i < 3; i++) {
      const a = await authorize(token, { ...selfAssign, id: `a${i}` }, SECRET, db, cache)
      expect(a.ok).toBe(true)
      const s = await authorize(token, sourceCreate(i), SECRET, db, cache)
      expect(s.ok).toBe(true)
    }
    expect(reads).toEqual({ projects: 1, org_settings: 1, project_settings: 1 })
  })

  it('project_settings is read once per request for N contributor source.cell.create events', async () => {
    const statementsFor = async (n: number) => {
      const db = await makeTestDb()
      try {
        await db.db
          .prepare(`INSERT INTO project_settings (project_id, settings, version, updated_at) VALUES (?, ?, 1, CURRENT_TIMESTAMP)`)
          .bind(PROJECT, JSON.stringify({ allowLineCreation: true }))
          .run()
        let statements = 0
        // Statements handed to batch() are unwrapped back to the shim's own
        // objects (PostgresDb.batch reaches into their internals).
        const originals = new WeakMap<AquillaStatement, AquillaStatement>()
        const wrap = (st: AquillaStatement): AquillaStatement => {
          const w: AquillaStatement = {
            bind: (...a: unknown[]) => wrap(st.bind(...a)),
            all: <T,>() => { statements++; return st.all<T>() },
            run: <T,>() => { statements++; return st.run<T>() },
            first: <T,>(c?: string) => { statements++; return st.first<T>(c) },
            raw: <T,>() => { statements++; return st.raw<T>() },
          }
          originals.set(w, st)
          return w
        }
        const counting: AquillaDb = {
          prepare: (q) => wrap(db.db.prepare(q)),
          batch: (stmts) => db.db.batch(stmts.map((s) => originals.get(s) ?? s)),
          exec: (q) => db.db.exec(q),
          close: async () => {},
        }
        const r = await post(counting, Array.from({ length: n }, (_, i) => sourceCreate(i)))
        expect(r.rejected).toEqual([])
        expect(r.accepted).toHaveLength(n)
        return statements
      } finally {
        await db.close()
      }
    }
    expect(await statementsFor(6)).toBe(await statementsFor(2))
  }, 120_000)
})

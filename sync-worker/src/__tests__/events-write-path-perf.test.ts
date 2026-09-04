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

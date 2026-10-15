// AQU-1832 — the write path broadcasts the numbers it just computed.
//
// progress-push.test.ts proves the FRAME is the read's answer. This proves
// the REQUEST emits it, in one batch, after the `event.applied` frames that
// told the client to hold its refetch — the ordering is the whole contract,
// because a peer that skips the read and never receives the push is left
// showing a percentage that silently stopped moving.

import { afterEach, describe, expect, it, vi } from 'vitest'

// route.ts imports broadcast.ts → partyserver (cloudflare:* imports).
vi.mock('partyserver', () => ({
  getServerByName: vi.fn().mockResolvedValue({
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  }),
}))

import { handleEventsWriteRequest } from '../events/route'
import { makeTestToken } from './helpers/auth'
import { makeTestDb } from './helpers/pg-test-db'
import { resetFileCounterRecomputeCoalescerForTests } from '../events/counter-recompute-coalescer'

const SECRET = 'progress-push-fanout-secret'
const PROJECT = 'proj-a'
const FILE = 'file-x'

function sourceCell(cellId: string, ref: string, sequence: number) {
  return {
    project_id: PROJECT, file_id: FILE, cell_id: cellId, side: 'source',
    value: `source ${cellId}`, canonical_ref: ref, event_id: `src-${cellId}`,
    last_editor: 'alice', last_edit_at: 1, validated: 0, endorsement_count: 0,
    word_count: 2, target_lang: '', sequence_index: sequence,
  }
}

async function seeded() {
  return makeTestDb({
    files: [{ id: FILE, project_id: PROJECT, name: 'Genesis', event_id: 'file-event' }],
    cells: [sourceCell('cell-1', 'GEN 1:1', 1), sourceCell('cell-2', 'GEN 1:2', 2)],
  })
}

afterEach(() => {
  // AQU-1826: the recompute coalescer keeps isolate-scoped per-file state.
  resetFileCounterRecomputeCoalescerForTests()
})

/**
 * AQU-1826 × AQU-1832: wrap the shim so the FIRST counter-recompute pass is
 * held until released, and the Nth write transaction can be awaited. Requests
 * that commit while the first pass is held are answered by the pass queued
 * behind it — started by whichever of them reaches the coalescer first, so the
 * others never run their own callback. Same scaffolding as
 * events-write-path-perf.test.ts, which proves the coalescing itself.
 */
function heldFirstPassDb(db: AquillaDb, writesToAwait: number) {
  const sqlOf = (s: AquillaStatement): string => (s as unknown as { _sql(): string })._sql()
  let passes = 0
  let writes = 0
  let releaseFirstPass: () => void = () => {}
  const firstPassHeld = new Promise<void>((r) => { releaseFirstPass = r })
  let firstPassStarted: () => void = () => {}
  const sawFirstPass = new Promise<void>((r) => { firstPassStarted = r })
  let writesDone: () => void = () => {}
  const sawWrites = new Promise<void>((r) => { writesDone = r })
  const run = async <T = Record<string, unknown>>(stmts: AquillaStatement[]) => {
    const sql = stmts.map(sqlOf)
    if (sql.some((s) => s.includes('UPDATE files SET cell_count'))) {
      passes += 1
      if (passes === 1) {
        firstPassStarted()
        await firstPassHeld
      }
    }
    const res = await db.batchPipelined!<T>(stmts)
    if (sql.some((s) => s.includes('INSERT INTO events'))) {
      writes += 1
      if (writes === writesToAwait) writesDone()
    }
    return res
  }
  const wrapped: AquillaDb = {
    prepare: (q) => db.prepare(q),
    exec: (q) => db.exec(q),
    close: () => db.close(),
    batch: run,
    batchPipelined: run,
  }
  return { db: wrapped, sawFirstPass, sawWrites, release: () => releaseFirstPass(), passes: () => passes }
}

function envWithProjectSync(db: AquillaDb) {
  const bodies: Array<Record<string, unknown>> = []
  const stubFetch = vi.fn().mockImplementation(async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)))
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  })
  return {
    env: {
      AQUILLA_PG: db,
      SYNC_SECRET_KEY: SECRET,
      ProjectSync: {
        idFromName: vi.fn().mockReturnValue({ id: 'do-id' }),
        get: vi.fn().mockReturnValue({ fetch: stubFetch }),
      } as unknown as DurableObjectNamespace,
    },
    bodies,
  }
}

async function commitCell(env: Record<string, unknown>, cellId: string, value: string) {
  const token = await makeTestToken(SECRET, { projectId: PROJECT, fileId: FILE } as never)
  const res = await handleEventsWriteRequest(
    new Request('https://worker/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        events: [{
          id: `evt-${cellId}-${value}`,
          schemaVersion: 1,
          kind: 'target.cell.create',
          projectId: PROJECT,
          fileId: FILE,
          cellId,
          parentId: null,
          author: 'alice',
          payload: { cellId, value, valueHtml: `<p>${value}</p>` },
          clientTs: 1000,
        }],
      }),
    }),
    env as never,
  )
  expect(res?.status).toBe(200)
  return res!
}

function messagesOf(bodies: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return bodies.flatMap((body) =>
    body.t === 'broadcast.batch'
      ? (body.messages as Array<Record<string, unknown>>)
      : [body],
  )
}

describe('AQU-1832 — POST /events fans out the progress push', () => {
  it('sends one push frame per target lane, after the applied frames that defer to it', async () => {
    const { db } = await seeded()
    const { env, bodies } = envWithProjectSync(db)
    await commitCell(env, 'cell-1', 'uno')

    // One subrequest per project, as PERF-8 requires — the push rides inside
    // it rather than buying a second one.
    expect(bodies).toHaveLength(1)
    const messages = messagesOf(bodies)
    const appliedIndex = messages.findIndex((m) => m.t === 'event.applied')
    const pushIndex = messages.findIndex((m) => m.t === 'file.progress.pushed')
    expect(appliedIndex).toBeGreaterThanOrEqual(0)
    expect(pushIndex).toBeGreaterThan(appliedIndex)

    expect(messages[appliedIndex].progressPushed).toBe(true)
    const push = messages[pushIndex]
    expect(push.project).toBe(PROJECT)
    expect(push.file).toBe(FILE)
    expect(push.lane).toBe('')
    expect(push.complete).toBe(false)
    expect(push.counts).toMatchObject({ totalCount: 2, filledCount: 1 })
  })

  it('keeps the author\'s applied[] byte-identical to the frame its peers receive', async () => {
    const { db } = await seeded()
    const { env, bodies } = envWithProjectSync(db)
    const res = await commitCell(env, 'cell-1', 'uno')

    const body = (await res.json()) as { applied: Array<Record<string, unknown>> }
    const broadcast = messagesOf(bodies).find((m) => m.t === 'event.applied')!
    expect(JSON.stringify(body.applied[0])).toBe(JSON.stringify(broadcast))
  })

  it('emits no push, and no promise of one, when there is no DO to broadcast through', async () => {
    const { db } = await seeded()
    // A client told to hold its refetch by a worker that never fans out would
    // wait for a frame that does not exist.
    const res = await commitCell({ AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET }, 'cell-1', 'uno')
    const body = (await res.json()) as { applied: Array<Record<string, unknown>> }
    expect(body.applied[0].progressPushed).toBeUndefined()
  })

  it('AQU-1826: a request answered by a pass another request started still pushes its frames', async () => {
    // Under the per-file coalescer the pass that answers a request may have
    // been started by a different request's callback. What that pass wrote,
    // and the timestamp it stamped the rows with, must still reach THIS
    // request — otherwise it broadcasts no push, its applied frames carry no
    // `progressPushed`, and every peer refetches exactly as before, under the
    // one load pattern (several writers on one file) both tickets exist for.
    const { db: raw } = await makeTestDb({
      files: [{ id: FILE, project_id: PROJECT, name: 'Genesis', event_id: 'file-event' }],
      cells: [sourceCell('cell-1', 'GEN 1:1', 1), sourceCell('cell-2', 'GEN 1:2', 2), sourceCell('cell-3', 'GEN 1:3', 3)],
    })
    const held = heldFirstPassDb(raw, 3)
    const { env, bodies } = envWithProjectSync(held.db)

    const first = commitCell(env, 'cell-1', 'uno')
    await held.sawFirstPass
    // Both arrive while the first pass is held: one of them starts the queued
    // pass, the other only joins it — and must not be able to tell.
    const second = commitCell(env, 'cell-2', 'dos')
    const third = commitCell(env, 'cell-3', 'tres')
    await held.sawWrites
    await new Promise<void>((r) => { setTimeout(r, 0) })
    held.release()

    const responses = await Promise.all([first, second, third])
    // The held pass plus the one queued behind it — not one per request.
    expect(held.passes()).toBe(2)

    for (const res of responses) {
      const body = (await res.json()) as { applied: Array<Record<string, unknown>> }
      expect(body.applied[0].progressPushed).toBe(true)
    }
    expect(bodies).toHaveLength(3)
    for (const b of bodies) {
      const push = messagesOf([b]).find((m) => m.t === 'file.progress.pushed')
      expect(push).toBeDefined()
      expect(push!.file).toBe(FILE)
      expect(push!.complete).toBe(false)
    }
  })
})

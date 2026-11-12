// AQU-2025: an event's `events` INSERT and its projection statements must ride
// in the SAME transaction.
//
// migrate-ingest builds one flat list of statements — [insert₁, proj₁…,
// insert₂, proj₂…] — and sends it in chunks, one transaction per chunk. The
// chunking used to be `stmts.slice(i, i + limit)`, which cuts wherever the
// index lands: an event's INSERT committed in transaction N while the tail of
// its projection went to transaction N+1. When N+1 failed, the event id was
// already durable with an incomplete projection — and the route's replay
// pre-filter (SELECT id FROM events …) then dropped that id from every retry,
// so the missing projection rows could never be written. The extended isolated
// canary saw it as 249 audio event rows against 248 audio projection rows,
// permanently.
//
// Two guards here, run against BOTH database paths (pipelined and serial):
//   1. every transaction starts on a group boundary — the structural invariant;
//   2. a failure after a committed transaction heals on retry, without
//      overwriting edits made in between — the symptom the canary caught.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest"
import { handleMigrateIngestRequest } from "../events/migrate-ingest-route"
import { makeTestDb, type TestDb } from "./helpers/pg-test-db"
import type { AquillaDb, AquillaStatement } from "../../../db/shim/postgres"

const SECRET = "test-secret"
const PROJECT = "proj-atomic"
const FILE = "file-atomic"

let t: TestDb
beforeAll(async () => {
  t = await makeTestDb()
}, 120_000)
afterAll(async () => {
  await t.close()
})
beforeEach(async () => {
  await t.reset()
})

interface IngestEventIn {
  id: string
  kind: string
  fileId?: string | null
  cellId?: string | null
  parentId?: string | null
  author: string
  clientTs: number
  payload: unknown
}

/** Every transaction the route ran, as the SQL text of its statements. */
type Recorded = string[][]

interface WrapOpts {
  /** false hides `batchPipelined`, so the route takes the serial batch() path
   *  (and its smaller BATCH_LIMIT) exactly as a non-pipelining executor would. */
  pipelined: boolean
  /** 1-based index of the EVENT-WRITE transaction to fail INSTEAD of running.
   *  Earlier ones commit for real — that is the "failure after a committed
   *  transaction" the acceptance criteria asks for. */
  failOnTransaction?: number
  recorded?: Recorded
}

/** The route batches twice for reasons that have nothing to do with each other:
 *  once to upsert the project's lanes, then once per chunk of event writes.
 *  Only the latter are what this file is about. Every event-write chunk carries
 *  an events INSERT or the seq-allocation settle, whatever the chunking does;
 *  the lane upsert carries neither. The tests cross-check the count of chunks
 *  matched here against the route's own reported `transactions`, so a chunk
 *  this misses fails the assertion rather than hiding. */
const isEventWrite = (sqls: readonly string[]): boolean =>
  sqls.some((sql) => /^INSERT INTO events\b/i.test(sql) || /seq_allocations/i.test(sql))

/** The route's db, with its batch entry points instrumented. Everything else
 *  (prepare, exec, lane upserts, seq allocation) forwards untouched. */
function wrapDb(db: AquillaDb, opts: WrapOpts): AquillaDb {
  let writes = 0
  const run = async (stmts: AquillaStatement[]): Promise<unknown[]> => {
    const sqls = stmts.map((s) => (s as unknown as { _sql(): string })._sql())
    if (isEventWrite(sqls)) {
      writes += 1
      opts.recorded?.push(sqls)
      if (writes === opts.failOnTransaction) throw new Error("injected transaction failure")
    }
    return opts.pipelined ? db.batchPipelined!(stmts) : db.batch(stmts)
  }
  return new Proxy(db as unknown as object, {
    get(target, prop, receiver) {
      if (prop === "batch") return run
      if (prop === "batchPipelined") return opts.pipelined ? run : undefined
      const v = Reflect.get(target, prop, receiver)
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v
    },
    has(target, prop) {
      return prop === "batchPipelined" ? opts.pipelined : Reflect.has(target, prop)
    },
  }) as unknown as AquillaDb
}

async function post(db: AquillaDb, events: IngestEventIn[]): Promise<Response> {
  const res = await handleMigrateIngestRequest(
    new Request("https://sync.test/migrate/ingest", {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: PROJECT, events }),
    }),
    { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET },
  )
  expect(res).not.toBeNull()
  return res!
}

function attach(n: number): IngestEventIn {
  return {
    id: `evt-audio-${n}`,
    kind: "cell.audio.attach",
    fileId: FILE,
    cellId: `cell-${n}`,
    parentId: null,
    author: "legacy-user",
    clientTs: 1600000000000 + n,
    payload: {
      audioId: `audio-${n}`,
      url: `https://r2.invalid/audio-${n}.webm`,
      slot: "recording",
      label: "from-migration",
    },
  }
}

/** The ticket's chunk: one file rename, then N audio attaches. The rename is
 *  load-bearing — its group is a different size from an attach's, so the flat
 *  chunk boundary lands mid-attach instead of tidily between two of them. */
function renameThenAttaches(n: number): IngestEventIn[] {
  const rename: IngestEventIn = {
    id: "evt-rename",
    kind: "file.rename",
    fileId: FILE,
    cellId: null,
    parentId: null,
    author: "legacy-user",
    clientTs: 1600000000000,
    payload: { name: "Renamed During Migration" },
  }
  return [rename, ...Array.from({ length: n }, (_, i) => attach(i))]
}

const EVENTS_INSERT = /^INSERT INTO events\b/i

/** The route reports its phases and counts through console. Swallow them so a
 *  300-event run does not flood the reporter, and so the tests can read them. */
function captureLogs(): { lines: unknown[][]; restore: () => void } {
  const lines: unknown[][] = []
  const log = console.log
  const error = console.error
  console.log = (...a: unknown[]) => { lines.push(a) }
  console.error = (...a: unknown[]) => { lines.push(a) }
  return { lines, restore: () => { console.log = log; console.error = error } }
}

const phaseLine = (lines: unknown[][]): Record<string, unknown> | undefined =>
  lines.find((l) => l[0] === "[migrate-ingest] phases")?.[1] as Record<string, unknown> | undefined

async function audioRows(): Promise<Array<{ audio_id: string; label: string | null }>> {
  const r = await t.pg.query<{ audio_id: string; label: string | null }>(
    `SELECT audio_id, label FROM cell_audio WHERE project_id=$1 ORDER BY audio_id`,
    [PROJECT],
  )
  return r.rows
}

async function audioEventIds(): Promise<string[]> {
  const r = await t.pg.query<{ id: string }>(
    `SELECT id FROM events WHERE project_id=$1 AND kind='cell.audio.attach' ORDER BY server_seq`,
    [PROJECT],
  )
  return r.rows.map((x) => x.id)
}

describe.each([
  { name: "pipelined", pipelined: true, events: 300 },
  { name: "serial", pipelined: false, events: 40 },
])("migrate-ingest atomicity ($name path)", ({ pipelined, events }) => {
  // The structural guard. Groups are [events INSERT, ...that event's projection],
  // so the first statement of every transaction must be an events INSERT — or,
  // for the tail, the settle statement that rides last. A flat index cut puts a
  // bare projection statement (`UPDATE cell_audio SET selected = 0 …`) at the
  // head of a transaction, which is exactly the split that strands an event.
  it("starts every transaction on an event boundary", async () => {
    const recorded: Recorded = []
    const cap = captureLogs()
    let res: Response
    try {
      res = await post(wrapDb(t.db, { pipelined, recorded }), renameThenAttaches(events))
    } finally {
      cap.restore()
    }
    expect(res.status).toBe(200)

    // Everything the route counted as a write transaction is in `recorded` —
    // so a chunk made entirely of projection statements (which a flat index cut
    // can produce) is a miscount here, not a silent pass.
    expect(recorded).toHaveLength(Number(phaseLine(cap.lines)!.transactions))

    // The scenario has to actually span more than one transaction, or there is
    // no boundary to get wrong.
    expect(recorded.length).toBeGreaterThan(1)

    for (const [i, chunk] of recorded.entries()) {
      const head = chunk[0]
      const onBoundary = EVENTS_INSERT.test(head) || /seq_allocations/i.test(head)
      expect(onBoundary, `transaction ${i + 1} starts mid-event: ${head.slice(0, 80)}`).toBe(true)
    }
  }, 120_000)

  // The canary's symptom, end to end.
  it("heals a failure after a committed transaction on retry, keeping later edits", async () => {
    const chunk = renameThenAttaches(events)

    // Transaction 1 commits; transaction 2 blows up. Pre-fix this left one
    // audio event committed whose cell_audio row had never been written.
    const partial = await post(
      wrapDb(t.db, { pipelined, failOnTransaction: 2 }),
      chunk,
    )
    expect(partial.status).toBe(500)

    const committedIds = await audioEventIds()
    expect(committedIds.length).toBeGreaterThan(0)
    expect(committedIds.length).toBeLessThan(events)

    // Every event that committed must already have its projection row. This is
    // the invariant the retry depends on: the replay filter will skip these ids
    // forever, so whatever is missing now stays missing.
    const afterPartial = await audioRows()
    expect(afterPartial.map((r) => r.audio_id).sort()).toEqual(
      committedIds.map((id) => `audio-${id.slice("evt-audio-".length)}`).sort(),
    )

    // A later edit to one of the committed takes — the retry must not trample it.
    const edited = committedIds[0].slice("evt-audio-".length)
    await post(wrapDb(t.db, { pipelined }), [
      {
        id: "evt-later-rename",
        kind: "cell.audio.rename",
        fileId: FILE,
        cellId: `cell-${edited}`,
        parentId: null,
        author: "human-after-migration",
        clientTs: 1700000000000,
        payload: { audioId: `audio-${edited}`, label: "renamed-by-a-human" },
      },
    ])

    // Retry the identical chunk, nothing injected.
    const retry = await post(wrapDb(t.db, { pipelined }), chunk)
    expect(retry.status).toBe(200)
    expect(await retry.json()).toMatchObject({ replayed: committedIds.length + 1 })

    // Complete: every attach has both an event row and a projection row.
    const finalRows = await audioRows()
    expect(await audioEventIds()).toHaveLength(events)
    expect(finalRows).toHaveLength(events)
    expect(finalRows.map((r) => r.audio_id)).toEqual(
      Array.from({ length: events }, (_, i) => `audio-${i}`).sort(),
    )

    // And the human's rename survived the replay.
    expect(finalRows.find((r) => r.audio_id === `audio-${edited}`)?.label).toBe("renamed-by-a-human")
  }, 180_000)
})

describe("migrate-ingest diagnostics (AQU-2025)", () => {
  it("emits phase timings and counts on successful database work", async () => {
    const cap = captureLogs()
    try {
      await post(t.db, renameThenAttaches(3))
    } finally {
      cap.restore()
    }
    const line = phaseLine(cap.lines)
    expect(line).toBeDefined()
    expect(line).toMatchObject({ projectId: PROJECT, outcome: "ok", events: 4, fresh: 4 })
    expect(line!.transactions).toBeGreaterThan(0)
    expect(line!.statements).toBeGreaterThan(0)
    expect(Object.keys(line!.phases as object)).toEqual(
      expect.arrayContaining(["prepare", "replayFilter", "lanes", "seqAlloc", "write"]),
    )
    expect(typeof line!.totalMs).toBe("number")
  }, 120_000)

  it("emits them on failed database work too, without payloads or SQL parameters", async () => {
    const cap = captureLogs()
    try {
      await post(wrapDb(t.db, { pipelined: false, failOnTransaction: 1 }), renameThenAttaches(3))
    } finally {
      cap.restore()
    }
    const line = phaseLine(cap.lines)
    expect(line).toMatchObject({ outcome: "db-batch-failed" })
    expect(line!.error).toContain("injected transaction failure")

    // Nothing that could carry content: no cell text, no payload JSON, no
    // bound values, no credential. The whole line is counts and durations.
    const serialized = JSON.stringify(cap.lines)
    expect(serialized).not.toContain("r2.invalid")
    expect(serialized).not.toContain("from-migration")
    expect(serialized).not.toContain("Renamed During Migration")
    expect(serialized).not.toContain(SECRET)
    expect(serialized).not.toContain("INSERT INTO events")
  }, 120_000)
})

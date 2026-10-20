// AQU-2051 — the per-document knowledge-base indexing driver
// (src/knowledge-index-do.ts) and the route-side handshake that hands a
// document to it (lib/knowledge/index-driver.ts).
//
// WHY this is a Durable Object at all: indexing used to run on the uploading
// request's `executionCtx.waitUntil`, which the platform cuts off ~30 s past
// the response. AQU-2050 found a 60,805-character Arabic document stuck at
// `pending` forever on dev because of it, and made each run land inside the
// window — which turned a large document into a human pressing "Try indexing
// again" once per 30 s of work. An alarm has no such budget.
//
// What this guards, in order of severity:
//   1. The document getting a driver at all. A kick must reach the object and
//      arm its alarm, and the alarm must run the indexing job.
//   2. Paying twice. One document has one job: a kick that lands while the
//      alarm is working must not arm a second one, and an alarm must not be
//      able to re-run a job it has already started (the runtime retries an
//      alarm that throws).
//   3. The row stranded at `pending` with nothing driving it. So: the job's own
//      terminal write is never bypassed, a config error (no HYPERDRIVE) stops
//      cleanly rather than retrying forever, and the heartbeat that keeps a
//      long healthy run off the read side's stalled list stops the moment the
//      driver does — never outliving the driver that vouches for it.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const indexKnowledgeDoc = vi.fn()
const close = vi.fn(async () => {})
const makePostgres = vi.fn(() => ({ close }))

vi.mock("../lib/knowledge/index-doc", () => ({ indexKnowledgeDoc }))
vi.mock("../../../db/shim/postgres", () => ({ makePostgres }))
vi.mock("../../../db/shared/secrets-store-overlay", () => ({
  withStoreSecrets: async (env: unknown) => env,
}))

const { KnowledgeIndexDriver } = await import("../knowledge-index-do")
const {
  KB_DRIVER_BUDGET_MS,
  KB_DRIVER_MAX_MS,
  KB_DRIVE_URL,
  kickKnowledgeIndexDriver,
  parseKnowledgeIndexJob,
  startIndexHeartbeat,
  touchIndexingDoc,
} = await import("../lib/knowledge/index-driver")
// The real constants, past the mock above: these assertions are about the
// relationship between the driver's budget and the request-hosted one.
const { KB_INDEX_BUDGET_MS, KB_WAITUNTIL_WINDOW_MS } = await vi.importActual<
  typeof import("../lib/knowledge/index-doc")
>("../lib/knowledge/index-doc")

const DOC_ID = "doc-1"
const ENV = { HYPERDRIVE: { connectionString: "postgres://test/db" } }

/** The slice of DurableObjectState the driver uses. */
function fakeCtx() {
  const store = new Map<string, unknown>()
  const alarms: number[] = []
  return {
    alarms,
    store,
    storage: {
      get: async <T>(key: string) => store.get(key) as T | undefined,
      put: async (key: string, value: unknown) => void store.set(key, value),
      delete: async (key: string) => store.delete(key),
      setAlarm: async (at: number) => void alarms.push(at),
    },
  }
}

function driver(env: Record<string, unknown> = ENV) {
  const ctx = fakeCtx()
  const instance = new KnowledgeIndexDriver(ctx as unknown as DurableObjectState, env as never)
  return { instance, ctx }
}

function drive(body: unknown = { docId: DOC_ID }): Request {
  return new Request(KB_DRIVE_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

/** A db double recording the writes the heartbeat makes. */
function fakeDb() {
  const bound: unknown[][] = []
  const sql: string[] = []
  return {
    bound,
    sql,
    db: {
      prepare(query: string) {
        sql.push(query)
        return {
          bind(...args: unknown[]) {
            bound.push(args)
            return { run: async () => ({ rows: [], rowCount: 1 }) }
          },
        }
      },
    },
  }
}

beforeEach(() => {
  indexKnowledgeDoc.mockReset()
  indexKnowledgeDoc.mockResolvedValue(undefined)
  makePostgres.mockClear()
  close.mockClear()
  vi.spyOn(console, "error").mockImplementation(() => {})
  vi.spyOn(console, "warn").mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe("parseKnowledgeIndexJob", () => {
  it.each([
    ["a missing body", null],
    ["a non-object", "doc-1"],
    ["no docId", {}],
    ["a non-string docId", { docId: 7 }],
    ["an empty docId", { docId: "" }],
  ])("rejects %s", (_label, body) => {
    expect(parseKnowledgeIndexJob(body)).toBeNull()
  })

  it("keeps only the docId", () => {
    expect(parseKnowledgeIndexJob({ docId: DOC_ID, somethingElse: 1 })).toEqual({ docId: DOC_ID })
  })
})

describe("kickKnowledgeIndexDriver", () => {
  it("returns null with no binding, so the caller keeps the waitUntil job", () => {
    expect(kickKnowledgeIndexDriver({}, DOC_ID)).toBeNull()
  })

  it("names the object after the document and posts the job to /drive", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 202 }))
    const idFromName = vi.fn((name: string) => ({ name }))
    const get = vi.fn(() => ({ fetch }))
    const namespace = { idFromName, get } as unknown as DurableObjectNamespace

    await kickKnowledgeIndexDriver({ KNOWLEDGE_INDEX_DRIVER: namespace }, DOC_ID)

    expect(idFromName).toHaveBeenCalledWith(DOC_ID)
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(KB_DRIVE_URL)
    expect(init.method).toBe("POST")
    expect(JSON.parse(String(init.body))).toEqual({ docId: DOC_ID })
  })

  it("does not start a local job when the handshake fails — the alarm may already be armed", async () => {
    const namespace = {
      idFromName: () => ({}),
      get: () => ({
        fetch: async () => {
          throw new Error("stub unreachable")
        },
      }),
    } as unknown as DurableObjectNamespace

    await expect(
      kickKnowledgeIndexDriver({ KNOWLEDGE_INDEX_DRIVER: namespace }, DOC_ID),
    ).resolves.toBeUndefined()
    expect(indexKnowledgeDoc).not.toHaveBeenCalled()
  })
})

describe("KnowledgeIndexDriver.fetch", () => {
  it("stores the job and arms the alarm immediately", async () => {
    const { instance, ctx } = driver()
    const response = await instance.fetch(drive())

    expect(response.status).toBe(202)
    expect(ctx.store.get("job")).toEqual({ docId: DOC_ID })
    expect(ctx.alarms).toHaveLength(1)
  })

  it.each([
    ["a non-POST", new Request(KB_DRIVE_URL, { method: "GET" }), 404],
    ["another path", new Request("https://knowledge-index-driver.invalid/x", { method: "POST" }), 404],
  ])("refuses %s", async (_label, request, status) => {
    const { instance, ctx } = driver()
    expect((await instance.fetch(request)).status).toBe(status)
    expect(ctx.alarms).toHaveLength(0)
  })

  it("refuses a body that is not a job", async () => {
    const { instance, ctx } = driver()
    expect((await instance.fetch(drive({ docId: "" }))).status).toBe(400)
    expect(ctx.store.has("job")).toBe(false)
    expect(ctx.alarms).toHaveLength(0)
  })

  it("does not arm a second alarm for a document it is already indexing", async () => {
    const { instance, ctx } = driver()
    let release: (() => void) | undefined
    indexKnowledgeDoc.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )

    await instance.fetch(drive())
    const running = instance.alarm()
    await vi.waitFor(() => expect(indexKnowledgeDoc).toHaveBeenCalledTimes(1))

    // A double-clicked retry, a replayed request, a second agent.
    const second = await instance.fetch(drive())
    expect(second.status).toBe(202)
    expect(ctx.alarms).toHaveLength(1)
    expect(ctx.store.has("job")).toBe(false)

    release?.()
    await running
    expect(indexKnowledgeDoc).toHaveBeenCalledTimes(1)
  })
})

describe("KnowledgeIndexDriver.alarm", () => {
  // THE point of the ticket. indexKnowledgeDoc defaults to KB_INDEX_BUDGET_MS,
  // which AQU-2050 derived from the 30 s waitUntil window. That window does not
  // apply to an alarm, so a driver that let the default stand would still abort
  // a large document around 24 s and still report "Summaries are missing for N
  // of M sections" — moving the job would have bought nothing.
  it("gives the job the driver's budget, not the request-hosted one", async () => {
    const { instance } = driver()
    await instance.fetch(drive())
    await instance.alarm()

    const [, , , opts] = indexKnowledgeDoc.mock.calls[0] as [
      unknown,
      unknown,
      string,
      { timeoutMs?: number } | undefined,
    ]
    expect(opts?.timeoutMs).toBe(KB_DRIVER_BUDGET_MS)
    expect(KB_DRIVER_BUDGET_MS).toBeGreaterThan(KB_INDEX_BUDGET_MS)
    expect(KB_DRIVER_BUDGET_MS).toBeGreaterThan(KB_WAITUNTIL_WINDOW_MS)
  })

  // The heartbeat must outlive the job it vouches for: if it gave up first, a
  // document still being worked would go stale and offer a retry that starts a
  // second job.
  it("keeps the liveness ceiling above the job's budget", () => {
    expect(KB_DRIVER_MAX_MS).toBeGreaterThan(KB_DRIVER_BUDGET_MS)
  })

  it("runs the indexing job on a connection it owns, then closes it", async () => {
    const { instance } = driver()
    await instance.fetch(drive())
    await instance.alarm()

    expect(makePostgres).toHaveBeenCalledWith("postgres://test/db")
    expect(indexKnowledgeDoc).toHaveBeenCalledTimes(1)
    const [env, db, docId] = indexKnowledgeDoc.mock.calls[0] as [
      Record<string, unknown>,
      unknown,
      string,
    ]
    expect(docId).toBe(DOC_ID)
    expect(db).toBe(env.AQUILLA_PG)
    // The job must find a connection string and no binding, the same shape the
    // request path builds (src/index.ts).
    expect(env.PG_CONNECTION_STRING).toBe("postgres://test/db")
    expect(env.HYPERDRIVE).toBeUndefined()
    expect(close).toHaveBeenCalledTimes(1)
  })

  it("forgets the job before starting, so a retried alarm cannot pay for it twice", async () => {
    const { instance, ctx } = driver()
    await instance.fetch(drive())
    await instance.alarm()
    expect(ctx.store.has("job")).toBe(false)

    // The runtime retries an alarm that threw. There is nothing left to re-run.
    await instance.alarm()
    expect(indexKnowledgeDoc).toHaveBeenCalledTimes(1)
  })

  it("does nothing when there is no job", async () => {
    const { instance } = driver()
    await instance.alarm()
    expect(indexKnowledgeDoc).not.toHaveBeenCalled()
    expect(makePostgres).not.toHaveBeenCalled()
  })

  it("stops cleanly when HYPERDRIVE is unbound instead of retrying forever", async () => {
    const { instance, ctx } = driver({})
    await instance.fetch(drive())
    await instance.alarm()

    expect(indexKnowledgeDoc).not.toHaveBeenCalled()
    expect(makePostgres).not.toHaveBeenCalled()
    expect(ctx.store.has("job")).toBe(false)
  })

  it("swallows a throw from the job and still releases the connection", async () => {
    const { instance } = driver()
    indexKnowledgeDoc.mockRejectedValue(new Error("driver bug"))
    await instance.fetch(drive())

    // An alarm that throws is retried, and a retry would re-enter the same bug
    // at full model price.
    await expect(instance.alarm()).resolves.toBeUndefined()
    expect(close).toHaveBeenCalledTimes(1)
  })
})

describe("the liveness heartbeat", () => {
  it("touches only a pending row, by id", async () => {
    const { db, sql, bound } = fakeDb()
    await touchIndexingDoc(db as never, DOC_ID)

    expect(sql[0]).toContain("UPDATE knowledge_docs")
    expect(sql[0]).toContain("updated_at = now()")
    expect(sql[0]).toContain("index_status = 'pending'")
    expect(bound[0]).toEqual([DOC_ID])
  })

  it("beats while the driver works and stops when it does", async () => {
    const { db, bound } = fakeDb()
    let wake: (() => void) | undefined
    const sleep = () =>
      new Promise<void>((resolve) => {
        wake = resolve
      })

    const beat = startIndexHeartbeat(db as never, DOC_ID, { sleep })
    await vi.waitFor(() => expect(wake).toBeDefined())
    wake?.()
    await vi.waitFor(() => expect(bound).toHaveLength(1))

    // stop() must cut the wait short, not leave the driver (and its Postgres
    // connection) parked until the next interval would have elapsed.
    beat.stop()
    await beat.done
    // And the beat that wait was leading to is withheld: the driver no longer
    // vouches for the row, so it goes stale on the read side's schedule.
    expect(bound).toHaveLength(1)
  })

  it("cuts the real timer short on stop", async () => {
    const { db, bound } = fakeDb()
    const beat = startIndexHeartbeat(db as never, DOC_ID, { intervalMs: 60_000 })
    beat.stop()
    await beat.done
    expect(bound).toHaveLength(0)
  })

  it("gives up at the ceiling so a hung job cannot look alive forever", async () => {
    const { db, bound } = fakeDb()
    let clock = 0
    const beat = startIndexHeartbeat(db as never, DOC_ID, {
      ceilingMs: 100,
      now: () => clock,
      sleep: async () => {
        clock += 60
      },
    })
    await beat.done
    // Two beats fit under the 100 ms ceiling (t=0 and t=60); at t=120 it stops.
    expect(bound).toHaveLength(2)
  })

  it("carries on after a failed beat rather than taking the job down", async () => {
    let calls = 0
    const db = {
      prepare: () => ({
        bind: () => ({
          run: async () => {
            calls += 1
            throw new Error("connection hiccup")
          },
        }),
      }),
    }
    let clock = 0
    const beat = startIndexHeartbeat(db as never, DOC_ID, {
      ceilingMs: 100,
      now: () => clock,
      sleep: async () => {
        clock += 60
      },
    })
    await expect(beat.done).resolves.toBeUndefined()
    expect(calls).toBe(2)
  })
})

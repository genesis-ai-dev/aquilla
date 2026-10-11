// AQU-1845 — the per-run Autopilot driver (src/contextual-run-do.ts) and the
// route-side handshake that hands a run to it (routes/contextual.ts
// `kickRunDriver`).
//
// WHY this is a Durable Object at all: the old driver was
// `executionCtx.waitUntil` on the request that started the run. Workers extend
// that ~30 s past the response, so a run of any real size was cut off after a
// wave or two and left for the 5-minute cron to re-adopt — at most 10 runs a
// sweep, which made ~10 runs per 5 minutes the platform-wide ceiling however
// much provider capacity was idle.
//
// What this guards, in order of severity:
//   1. The run getting a driver at all. A kick must reach the object and arm
//      its alarm, and the alarm must drive waves.
//   2. Two drivers for one run. The object is the single-driver guarantee; a
//      kick must NOT also start a local loop, and a kick that lands while the
//      alarm is working must not re-arm underneath it.
//   3. The run never stranded 'running' with nothing driving it — the state
//      `resumeRun` refuses, from which only a human could rescue it. So: the
//      alarm re-arms while work remains, forgets the job when it does not, and
//      a config error (no HYPERDRIVE) stops cleanly for the cron to pick up
//      rather than retrying forever.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const selfTickLoop = vi.fn()
const close = vi.fn(async () => {})

vi.mock("../routes/contextual", () => ({ selfTickLoop }))
vi.mock("../../../db/shim/postgres", () => ({ makePostgres: () => ({ close }) }))

const { ContextualRunDriver } = await import("../contextual-run-do")
const { WAVES_PER_ALARM, MAX_WAVES_PER_KICK, parseContextualDriverJob, kickRunDriver } =
  await import("../lib/contextual/run-driver")

type Job = { projectId: string; runId: string; concurrency?: number }

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

function driver(env: Record<string, unknown>) {
  const ctx = fakeCtx()
  const instance = new ContextualRunDriver(
    ctx as unknown as DurableObjectState,
    env as never,
  )
  return { instance, ctx }
}

const JOB: Job = { projectId: "proj-1", runId: "run-1", concurrency: 3 }
const ENV = { HYPERDRIVE: { connectionString: "postgres://test/db" } }

function drive(job: Job = JOB): Request {
  return new Request("https://contextual-run-driver.invalid/drive", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(job),
  })
}

beforeEach(() => {
  selfTickLoop.mockReset()
  selfTickLoop.mockResolvedValue(undefined)
  close.mockClear()
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe("ContextualRunDriver.fetch (the kick)", () => {
  it("stores the job and arms the alarm", async () => {
    const { instance, ctx } = driver(ENV)
    const response = await instance.fetch(drive())
    expect(response.status).toBe(202)
    expect(ctx.store.get("job")).toEqual(JOB)
    expect(ctx.alarms).toHaveLength(1)
  })

  it("refuses anything that is not a well-formed drive", async () => {
    const { instance, ctx } = driver(ENV)
    expect((await instance.fetch(new Request("https://d.invalid/drive"))).status).toBe(404)
    expect(
      (await instance.fetch(new Request("https://d.invalid/other", { method: "POST" }))).status,
    ).toBe(404)
    expect(
      (await instance.fetch(new Request("https://d.invalid/drive", { method: "POST", body: "{" }))).status,
    ).toBe(400)
    expect(
      (await instance.fetch(drive({ projectId: "", runId: "run-1" }))).status,
    ).toBe(400)
    // Nothing above may have left a job or an alarm behind.
    expect(ctx.store.size).toBe(0)
    expect(ctx.alarms).toHaveLength(0)
  })

  it("does not re-arm underneath an alarm that is already driving", async () => {
    const { instance, ctx } = driver(ENV)
    let release: (() => void) | undefined
    selfTickLoop.mockImplementation(
      () => new Promise<void>((resolve) => { release = resolve }),
    )
    await instance.fetch(drive())
    expect(ctx.alarms).toHaveLength(1)

    const driving = instance.alarm()
    await Promise.resolve()
    // A second kick lands mid-wave: the running loop re-arms itself if it has
    // work left, so arming from out here would only schedule a redundant
    // invocation that finds nothing to do.
    await instance.fetch(drive())
    expect(ctx.alarms).toHaveLength(1)

    release?.()
    await driving
  })
})

describe("ContextualRunDriver.alarm (the driver)", () => {
  it("drives a bounded batch of waves and forgets the job when the run settles", async () => {
    const { instance, ctx } = driver(ENV)
    await instance.fetch(drive())
    await instance.alarm()

    expect(selfTickLoop).toHaveBeenCalledTimes(1)
    const [env, projectId, runId, concurrency, options] = selfTickLoop.mock.calls[0]
    expect(projectId).toBe("proj-1")
    expect(runId).toBe("run-1")
    expect(concurrency).toBe(3)
    expect(options.maxWaves).toBe(WAVES_PER_ALARM)
    // The loop borrows the connection this invocation owns, exactly as the
    // cron hands it one; HYPERDRIVE is dropped so nothing opens a second.
    expect(env.AQUILLA_PG).toBeTruthy()
    expect(env.HYPERDRIVE).toBeUndefined()
    expect(close).toHaveBeenCalledTimes(1)

    // The run settled inside the batch: nothing to re-arm for.
    expect(ctx.alarms).toHaveLength(1) // just the kick's
    expect(ctx.store.has("job")).toBe(false)
  })

  it("re-arms immediately when the wave budget runs out with spans left", async () => {
    const { instance, ctx } = driver(ENV)
    await instance.fetch(drive())
    selfTickLoop.mockImplementation(async (_e, _p, _r, _c, options) => {
      // This is the hook routes/contextual.ts calls instead of parking.
      expect(await options.onWaveBudgetExhausted()).toBe(true)
    })
    await instance.alarm()

    expect(ctx.alarms).toHaveLength(2)
    // The job must survive, or the next alarm has nothing to pick up.
    expect(ctx.store.get("job")).toMatchObject(JOB)
  })

  it("counts the waves it has driven, so the total ceiling survives re-arming", async () => {
    const { instance, ctx } = driver(ENV)
    await instance.fetch(drive())
    selfTickLoop.mockImplementation(async (_e, _p, _r, _c, options) => {
      await options.onWaveBudgetExhausted()
    })
    await instance.alarm()
    expect(ctx.store.get("job")).toMatchObject({ wavesDriven: WAVES_PER_ALARM })
    await instance.alarm()
    expect(ctx.store.get("job")).toMatchObject({ wavesDriven: WAVES_PER_ALARM * 2 })
  })

  it("withholds the re-arm hook on the last batch, so the run parks instead of looping forever", async () => {
    // A run that somehow kept reporting "continue" without progressing would
    // otherwise re-arm forever, and every wave is real money. The ceiling is a
    // park, not a stop: `awaiting_input` surfaces Continue.
    const { instance, ctx } = driver(ENV)
    await instance.fetch(drive())
    ctx.store.set("job", { ...JOB, wavesDriven: MAX_WAVES_PER_KICK - WAVES_PER_ALARM })
    await instance.alarm()

    const [, , , , options] = selfTickLoop.mock.calls[0]
    expect(options.maxWaves).toBe(WAVES_PER_ALARM)
    // No hook: selfTickLoop takes its own park path at the budget.
    expect(options.onWaveBudgetExhausted).toBeUndefined()
    expect(ctx.store.has("job")).toBe(false)
    expect(ctx.alarms).toHaveLength(1) // just the kick's
  })

  it("clips the last batch to what the ceiling leaves", async () => {
    const { instance, ctx } = driver(ENV)
    await instance.fetch(drive())
    ctx.store.set("job", { ...JOB, wavesDriven: MAX_WAVES_PER_KICK - 2 })
    await instance.alarm()
    expect(selfTickLoop.mock.calls[0][4].maxWaves).toBe(2)
  })

  it("stops cleanly, for the cron to adopt, when HYPERDRIVE is not bound", async () => {
    const { instance, ctx } = driver({})
    await instance.fetch(drive())
    await instance.alarm()

    expect(selfTickLoop).not.toHaveBeenCalled()
    // Deliberately NOT a throw: a thrown alarm is retried, and a retry of a
    // config error just burns the retry budget.
    expect(ctx.store.has("job")).toBe(false)
    expect(ctx.alarms).toHaveLength(1)
  })

  it("does nothing at all when there is no job (a stray alarm)", async () => {
    const { instance } = driver(ENV)
    await instance.alarm()
    expect(selfTickLoop).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
  })

  it("closes its connection and forgets the job when the loop throws", async () => {
    const { instance, ctx } = driver(ENV)
    await instance.fetch(drive())
    selfTickLoop.mockRejectedValue(new Error("driver bug"))
    // Must not rethrow: the alarm would be retried into the same bug.
    await expect(instance.alarm()).resolves.toBeUndefined()
    expect(close).toHaveBeenCalledTimes(1)
    expect(ctx.store.has("job")).toBe(false)
  })
})

describe("parseContextualDriverJob", () => {
  it("never takes a wave count off the wire", () => {
    // Only the object itself may set this: a kick that could pre-load the
    // counter could push a run past its ceiling, or reset one that is at it.
    expect(parseContextualDriverJob({ projectId: "p", runId: "r", wavesDriven: 499 }))
      .toEqual({ projectId: "p", runId: "r" })
  })

  it("accepts a job with and without a concurrency", () => {
    expect(parseContextualDriverJob({ projectId: "p", runId: "r" }))
      .toEqual({ projectId: "p", runId: "r" })
    expect(parseContextualDriverJob({ projectId: "p", runId: "r", concurrency: 4.7 }))
      .toEqual({ projectId: "p", runId: "r", concurrency: 4 })
  })

  it("rejects anything it cannot drive", () => {
    for (const bad of [
      null,
      "job",
      {},
      { projectId: "p" },
      { runId: "r" },
      { projectId: "", runId: "r" },
      { projectId: "p", runId: "" },
      { projectId: "p", runId: "r", concurrency: 0 },
      { projectId: "p", runId: "r", concurrency: "3" },
      { projectId: "p", runId: "r", concurrency: Number.NaN },
    ]) {
      expect(parseContextualDriverJob(bad)).toBeNull()
    }
  })
})

describe("kickRunDriver (the route side)", () => {
  it("hands the run to its object, and never starts a second driver", async () => {
    const fetchStub = vi.fn(
      async (_url: string, _init: RequestInit): Promise<Response> =>
        new Response(null, { status: 202 }),
    )
    const namespace = {
      idFromName: vi.fn((name: string) => ({ name })),
      get: vi.fn(() => ({ fetch: fetchStub })),
    }
    const kicked = kickRunDriver(
      { CONTEXTUAL_RUN_DRIVER: namespace } as never,
      "proj-1",
      "run-1",
      3,
    )
    expect(kicked).not.toBeNull()
    await kicked
    // One object per run, named by the run: that is what makes "one alarm at a
    // time per object" mean "one driver per run".
    expect(namespace.idFromName).toHaveBeenCalledWith("run-1")
    const [, init] = fetchStub.mock.calls[0]
    expect(JSON.parse(String(init.body))).toEqual({
      projectId: "proj-1",
      runId: "run-1",
      concurrency: 3,
    })
    expect(selfTickLoop).not.toHaveBeenCalled()
  })

  it("returns null with no binding, so the caller falls back to the local loop", () => {
    expect(kickRunDriver({} as never, "proj-1", "run-1")).toBeNull()
  })

  it("leaves a refused or failed handshake to the cron sweep", async () => {
    const refusing = {
      idFromName: () => ({}),
      get: () => ({ fetch: async () => new Response("nope", { status: 500 }) }),
    }
    await expect(kickRunDriver({ CONTEXTUAL_RUN_DRIVER: refusing } as never, "p", "r")).resolves.toBeUndefined()

    const throwing = {
      idFromName: () => ({}),
      get: () => ({ fetch: async () => { throw new Error("no object") } }),
    }
    await expect(kickRunDriver({ CONTEXTUAL_RUN_DRIVER: throwing } as never, "p", "r")).resolves.toBeUndefined()
    // Crucially it does NOT start a local loop as a "fallback": that would
    // race the object we may well have armed.
    expect(selfTickLoop).not.toHaveBeenCalled()
  })
})

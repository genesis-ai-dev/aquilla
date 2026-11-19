// AQU-2664, the weak-hardware rule: a take's loudness is measured OFF the page,
// in a Web Worker, with its samples transferred rather than copied. When the
// worker can't start, the page measures in small chunks and yields between
// them — inside a long take too — so the editor never freezes.
import { describe, expect, it, vi } from "vitest"
import { createLoudnessClient, type WorkerLike } from "./loudness-client"
import { answerLoudnessRequest, type LoudnessRequest } from "./loudness-protocol"
import { measureLoudness, measureLoudnessYielding, METER_CHUNK } from "./loudness"

const RATE = 48_000
function speechish(seconds: number, seed = 1): Float32Array {
  // A sine with a slow envelope and pauses: something the gates have work on.
  const out = new Float32Array(seconds * RATE)
  for (let i = 0; i < out.length; i++) {
    const env = Math.max(0, Math.sin((2 * Math.PI * i) / (RATE * 1.7 * seed)))
    out[i] = 0.3 * env * Math.sin((2 * Math.PI * 220 * i) / RATE) + 0.05 * Math.sin((2 * Math.PI * 3100 * i) / RATE)
  }
  return out
}

/** A worker that runs the real worker protocol in-process, asynchronously. */
function inProcessWorker(log: { transfers: Transferable[][]; posts: number }): WorkerLike {
  const w: WorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage(msg: LoudnessRequest, transfer?: Transferable[]) {
      log.posts++
      log.transfers.push(transfer ?? [])
      // A transfer detaches the sender's buffers; mimic that by handing the
      // worker its own copies and zeroing what the page passed.
      const req = msg.type === "measure"
        ? { ...msg, channels: msg.channels.map((c) => { const own = c.slice(); c.fill(0); return own }) }
        : msg
      setTimeout(() => {
        const { response } = answerLoudnessRequest(req)
        w.onmessage?.({ data: response } as MessageEvent)
      }, 0)
    },
    terminate: vi.fn(),
  }
  return w
}

describe("measuring off the page", () => {
  it("the worker gives the same reading as the page", async () => {
    const pcm = speechish(5)
    const expected = measureLoudness([pcm.slice()], RATE)
    const log = { transfers: [] as Transferable[][], posts: 0 }
    const client = createLoudnessClient({ makeWorker: () => inProcessWorker(log) })
    const r = await client.measure([pcm], RATE)
    expect(r).toEqual(expected)
    expect(client.lastPath()).toBe("worker")
    // Yielding on the page gives the very same numbers too.
    expect(await measureLoudnessYielding([speechish(5)], RATE, { yieldFn: async () => {} })).toEqual(expected)
  })

  it("transfers the channel data instead of copying it", async () => {
    const pcm = speechish(2)
    const log = { transfers: [] as Transferable[][], posts: 0 }
    const client = createLoudnessClient({ makeWorker: () => inProcessWorker(log) })
    await client.measure([pcm], RATE)
    const measured = log.transfers.find((t) => t.length > 0)
    expect(measured).toEqual([pcm.buffer])
  })

  it("reuses one worker for take after take", async () => {
    const makeWorker = vi.fn(() => inProcessWorker({ transfers: [], posts: 0 }))
    const client = createLoudnessClient({ makeWorker })
    await client.measure([speechish(1)], RATE)
    await client.measure([speechish(1, 2)], RATE)
    expect(makeWorker).toHaveBeenCalledTimes(1)
  })
})

describe("FALLBACK: measuring on the page when the worker can't", () => {
  it("is used when the worker can't be made at all", async () => {
    const pcm = speechish(3)
    const expected = measureLoudness([pcm.slice()], RATE)
    const client = createLoudnessClient({ makeWorker: () => { throw new Error("no workers here") }, yieldFn: async () => {} })
    expect(await client.measure([pcm], RATE)).toEqual(expected)
    expect(client.lastPath()).toBe("page")
  })

  it("is used when the worker fails to start (its script won't load), and the samples are never handed over", async () => {
    const pcm = speechish(3)
    const expected = measureLoudness([pcm.slice()], RATE)
    const posted: Transferable[][] = []
    const broken: WorkerLike = {
      onmessage: null,
      onerror: null,
      postMessage(_m: LoudnessRequest, transfer?: Transferable[]) {
        posted.push(transfer ?? [])
        setTimeout(() => broken.onerror?.({ message: "failed to load" } as ErrorEvent), 0)
      },
      terminate: vi.fn(),
    }
    const client = createLoudnessClient({ makeWorker: () => broken, yieldFn: async () => {} })
    expect(await client.measure([pcm], RATE)).toEqual(expected)
    expect(client.lastPath()).toBe("page")
    // Only the "are you there?" went to the broken worker, never the samples.
    expect(posted.every((t) => t.length === 0)).toBe(true)
    expect(broken.terminate).toHaveBeenCalled()
  })

  it("is used when the worker never answers", async () => {
    const silent: WorkerLike = { onmessage: null, onerror: null, postMessage: () => {}, terminate: vi.fn() }
    const client = createLoudnessClient({ makeWorker: () => silent, yieldFn: async () => {}, readyTimeoutMs: 20 })
    const pcm = speechish(1)
    const expected = measureLoudness([pcm.slice()], RATE)
    expect(await client.measure([pcm], RATE)).toEqual(expected)
    expect(client.lastPath()).toBe("page")
  })

  it("stays on the page after a failure instead of retrying the worker every take", async () => {
    const makeWorker = vi.fn(() => { throw new Error("no") })
    const client = createLoudnessClient({ makeWorker, yieldFn: async () => {} })
    await client.measure([speechish(1)], RATE)
    await client.measure([speechish(1)], RATE)
    expect(makeWorker).toHaveBeenCalledTimes(1)
  })

  it("a worker that errors on a take hands the samples back and the page measures them", async () => {
    const pcm = speechish(2)
    const expected = measureLoudness([pcm.slice()], RATE)
    const flaky: WorkerLike = {
      onmessage: null,
      onerror: null,
      postMessage(msg: LoudnessRequest) {
        setTimeout(() => {
          if (msg.type === "ping") flaky.onmessage?.({ data: { type: "pong" } } as MessageEvent)
          else flaky.onmessage?.({ data: { type: "error", id: msg.id, message: "boom", channels: msg.channels } } as MessageEvent)
        }, 0)
      },
      terminate: vi.fn(),
    }
    const client = createLoudnessClient({ makeWorker: () => flaky, yieldFn: async () => {} })
    expect(await client.measure([pcm], RATE)).toEqual(expected)
    expect(client.lastPath()).toBe("page")
  })
})

describe("FALLBACK: the page path never freezes the editor", () => {
  it("a long take yields many times inside itself", async () => {
    let yields = 0
    const seconds = 30
    await measureLoudnessYielding([speechish(seconds)], RATE, { yieldFn: async () => { yields++ } })
    // Two passes over 30 s at one yield per second of samples.
    expect(yields).toBeGreaterThanOrEqual(seconds)
    expect(METER_CHUNK).toBeLessThanOrEqual(RATE)
  })

  it("other work runs while a long take is measured", async () => {
    const ticks: number[] = []
    const timer = setInterval(() => ticks.push(Date.now()), 0)
    try {
      await measureLoudnessYielding([speechish(20)], RATE)
    } finally {
      clearInterval(timer)
    }
    expect(ticks.length).toBeGreaterThan(5)
  })

  it("yields between takes too", async () => {
    const order: string[] = []
    const client = createLoudnessClient({ makeWorker: () => null, yieldFn: async () => { order.push("yield") } })
    await client.measure([new Float32Array(100)], RATE)
    order.push("take 1 done")
    await client.measure([new Float32Array(100)], RATE)
    // Even a take shorter than one chunk gives the page a turn first.
    expect(order).toEqual(["yield", "take 1 done", "yield"])
  })
})

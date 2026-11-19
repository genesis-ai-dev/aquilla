import { describe, expect, it, vi } from "vitest"
import { createRequestCoalescer, createSameTurnCoalescer } from "./request-coalescer"

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe("createRequestCoalescer", () => {
  it("shares one in-flight request between concurrent identical callers", async () => {
    const c = createRequestCoalescer<string>()
    const d = deferred<string>()
    const fn = vi.fn(() => d.promise)

    const a = c.run("k", fn)
    const b = c.run("k", fn)
    const other = c.run("other", () => Promise.resolve("o"))
    d.resolve("v")

    expect(await a).toBe("v")
    expect(await b).toBe("v")
    expect(await other).toBe("o")
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it("issues a fresh request once the previous one has settled (no TTL)", async () => {
    const c = createRequestCoalescer<number>()
    let n = 0
    const fn = () => Promise.resolve(++n)

    expect(await c.run("k", fn)).toBe(1)
    expect(await c.run("k", fn)).toBe(2)
  })

  it("serves the cached value inside the TTL and refetches after it expires", async () => {
    let clock = 0
    const c = createRequestCoalescer<number>({ cacheTtlMs: 30_000, now: () => clock })
    let n = 0
    const fn = vi.fn(() => Promise.resolve(++n))

    expect(await c.run("k", fn)).toBe(1)
    clock = 29_999
    expect(await c.run("k", fn)).toBe(1)
    clock = 30_001
    expect(await c.run("k", fn)).toBe(2)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it("`fresh` bypasses the cache and invalidate() drops it", async () => {
    const c = createRequestCoalescer<number>({ cacheTtlMs: 30_000 })
    let n = 0
    const fn = () => Promise.resolve(++n)

    expect(await c.run("k", fn)).toBe(1)
    expect(await c.run("k", fn, { fresh: true })).toBe(2)
    c.invalidate("k")
    expect(await c.run("k", fn)).toBe(3)
  })

  it("a late arrival past the join window waits for the in-flight request, then runs ONE follow-up", async () => {
    // A WS poke that lands mid-flight must not be answered with a response
    // computed before the write it announced.
    let clock = 0
    const c = createRequestCoalescer<number>({ joinWindowMs: 250, now: () => clock })
    const first = deferred<number>()
    let calls = 0
    const fn = vi.fn(() => (++calls === 1 ? first.promise : Promise.resolve(calls)))

    const early = c.run("k", fn)
    clock = 100
    const joined = c.run("k", fn) // inside the window → shares
    clock = 1_000
    const lateA = c.run("k", fn) // past the window → follow-up
    const lateB = c.run("k", fn) // shares the same follow-up
    expect(fn).toHaveBeenCalledTimes(1)

    first.resolve(1)
    expect(await early).toBe(1)
    expect(await joined).toBe(1)
    expect(await lateA).toBe(2)
    expect(await lateB).toBe(2)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it("a rejected request is not cached and does not poison the next call", async () => {
    const c = createRequestCoalescer<number>({ cacheTtlMs: 30_000 })
    await expect(c.run("k", () => Promise.reject(new Error("nope")))).rejects.toThrow("nope")
    expect(await c.run("k", () => Promise.resolve(7))).toBe(7)
  })
})

// AQU-2654
describe("createSameTurnCoalescer", () => {
  it("shares one request between callers in the same synchronous turn", async () => {
    const c = createSameTurnCoalescer<number>()
    const fn = vi.fn(async () => 1)
    const results = await Promise.all([c.run("k", fn), c.run("k", fn), c.run("k", fn)])
    expect(results).toEqual([1, 1, 1])
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it("keeps keys apart", async () => {
    const c = createSameTurnCoalescer<string>()
    const fn = vi.fn(async () => "x")
    await Promise.all([c.run("a", fn), c.run("b", fn)])
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it("a caller in a later turn gets its own request, even while the first is still in flight", async () => {
    const c = createSameTurnCoalescer<number>()
    let settleFirst!: (value: number) => void
    let calls = 0
    const fn = vi.fn(() => (++calls === 1 ? new Promise<number>((resolve) => { settleFirst = resolve }) : Promise.resolve(calls)))

    const hanging = c.run("k", fn)
    await Promise.resolve() // the turn ends
    // A refresh or a recovery: never queued behind, or answered by, the old one.
    expect(await c.run("k", fn)).toBe(2)
    expect(fn).toHaveBeenCalledTimes(2)
    settleFirst(1)
    expect(await hanging).toBe(1)
  })

  it("a rejection reaches everyone who shared it and is not kept", async () => {
    const c = createSameTurnCoalescer<number>()
    const failing = vi.fn(() => Promise.reject(new Error("nope")))
    const [a, b] = await Promise.allSettled([c.run("k", failing), c.run("k", failing)])
    expect(a.status).toBe("rejected")
    expect(b.status).toBe("rejected")
    expect(failing).toHaveBeenCalledTimes(1)
    expect(await c.run("k", async () => 7)).toBe(7)
  })
})

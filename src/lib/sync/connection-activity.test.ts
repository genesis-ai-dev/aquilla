import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"

describe("passive connection activity", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
  })
  afterEach(() => vi.useRealTimers())

  it("observes a real response without extra requests or consuming it twice", async () => {
    const { observedSyncFetch, readSyncJson, getConnectionActivity } = await import("./connection-activity")
    const payload = '{"text":"é"}'
    const response = new Response(payload)
    const fetchFn = vi.fn(async () => {
      vi.advanceTimersByTime(125)
      return response
    })
    const init = { method: "POST", body: payload }
    const result = await observedSyncFetch("/events", init, fetchFn)
    expect(result).toBe(response)
    expect(fetchFn).toHaveBeenCalledExactlyOnceWith("/events", init)
    expect(await readSyncJson(result)).toEqual({ text: "é" })
    expect(getConnectionActivity()).toMatchObject({ upload: 13 / 5, download: 13 / 5, latency: 125 })
    vi.advanceTimersByTime(5_000)
    expect(getConnectionActivity()).toMatchObject({ upload: 0, download: 0, latency: 125 })
    vi.advanceTimersByTime(25_000)
    expect(getConnectionActivity()).toMatchObject({
      latency: null, lastReplyAgeMs: 30_000,
      recent: { upload: 13, download: 13, requests: 1, failures: 0, averageLatency: 125, slowestLatency: 125 },
    })
  })

  it("retains traffic history after live activity idles and expires it after five minutes", async () => {
    const { recordSyncBytes, getConnectionActivity } = await import("./connection-activity")
    recordSyncBytes("upload", "hello")
    recordSyncBytes("download", "é")
    expect(getConnectionActivity()).toMatchObject({ upload: 1, download: 0.4, latency: null })
    vi.advanceTimersByTime(5_000)
    expect(getConnectionActivity()).toMatchObject({ upload: 0, download: 0, recent: { upload: 5, download: 2 } })
    vi.advanceTimersByTime(295_000)
    expect(getConnectionActivity().recent).toEqual({
      upload: 0, download: 0, requests: 0, failures: 0, averageLatency: null, slowestLatency: null,
    })
  })

  it("averages every reply rather than averaging buckets or showing the last sample", async () => {
    const { observedSyncFetch, getConnectionActivity } = await import("./connection-activity")
    for (const ms of [20, 40, 1200]) {
      await observedSyncFetch("/cells", undefined, vi.fn(async () => {
        vi.advanceTimersByTime(ms)
        return new Response("{}")
      }))
    }
    expect(getConnectionActivity()).toMatchObject({
      latency: 1200, lastReplyAgeMs: 0,
      recent: { requests: 3, failures: 0, averageLatency: 420, slowestLatency: 1200 },
    })
    vi.advanceTimersByTime(300_000)
    expect(getConnectionActivity()).toMatchObject({
      latency: null, lastReplyAgeMs: 300_000,
      recent: { requests: 0, averageLatency: null, slowestLatency: null },
    })
  })

  it("counts transport and HTTP failures without inventing timings for transport failures", async () => {
    const { observedSyncFetch, getConnectionActivity } = await import("./connection-activity")
    const fetchFn = vi.fn().mockRejectedValue(new TypeError("offline"))
    await expect(observedSyncFetch("/events", { body: "unsent" }, fetchFn)).rejects.toThrow("offline")
    expect(getConnectionActivity()).toMatchObject({
      upload: 0, download: 0, latency: null,
      recent: { requests: 1, failures: 1, averageLatency: null },
    })
    await observedSyncFetch("/events", undefined, vi.fn(async () => {
      vi.advanceTimersByTime(100)
      return new Response("{}", { status: 503 })
    }))
    expect(getConnectionActivity().recent).toMatchObject({ requests: 2, failures: 2, averageLatency: 100 })
  })

  it("does not classify navigation cancellation as a failed connection, but counts timeouts", async () => {
    const { observedSyncFetch, getConnectionActivity } = await import("./connection-activity")
    for (const name of ["AbortError", "TimeoutError"]) {
      await expect(observedSyncFetch("/cells", undefined,
        vi.fn().mockRejectedValue(new DOMException(name, name)))).rejects.toThrow(name)
    }
    expect(getConnectionActivity().recent).toMatchObject({ requests: 1, failures: 1, averageLatency: null })
  })
})

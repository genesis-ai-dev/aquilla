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
    expect(getConnectionActivity()).toMatchObject({ upload: 13 / 3, download: 13 / 3, latency: 125 })
    vi.advanceTimersByTime(3_000)
    expect(getConnectionActivity()).toMatchObject({ upload: 13 / 3, download: 13 / 3, latency: 125 })
    vi.advanceTimersByTime(27_000)
    expect(getConnectionActivity()).toMatchObject({
      latency: null, lastReplyAgeMs: 30_000,
      recent: { upload: 13, download: 13, requests: 1, failures: 0, averageLatency: 125, slowestLatency: 125 },
    })
  })

  it("retains traffic history after live activity idles and expires it after five minutes", async () => {
    const { recordSyncBytes, getConnectionActivity } = await import("./connection-activity")
    recordSyncBytes("upload", "hello")
    recordSyncBytes("download", "é")
    expect(getConnectionActivity()).toMatchObject({ upload: 5 / 3, download: 2 / 3, latency: null })
    // The last real rate lingers briefly after traffic stops, then fades to idle.
    vi.advanceTimersByTime(3_000)
    expect(getConnectionActivity()).toMatchObject({ upload: 5 / 3, download: 2 / 3, recent: { upload: 5, download: 2 } })
    vi.advanceTimersByTime(10_000)
    expect(getConnectionActivity()).toMatchObject({ upload: 0, download: 0, recent: { upload: 5, download: 2 } })
    vi.advanceTimersByTime(287_000)
    expect(getConnectionActivity().recent).toEqual({
      upload: 0, download: 0, requests: 0, failures: 0, averageLatency: null, slowestLatency: null,
    })
  })

  it("shows the mean of the last three replies so the band only moves when the average shifts", async () => {
    const { observedSyncFetch, getConnectionActivity } = await import("./connection-activity")
    const reply = async (ms: number) => observedSyncFetch("/cells", undefined, vi.fn(async () => {
      vi.advanceTimersByTime(ms)
      return new Response("{}")
    }))
    for (const ms of [20, 40, 60]) await reply(ms)
    expect(getConnectionActivity()).toMatchObject({ latency: 40, quality: "good" })
    // One spike is diluted; the band holds.
    await reply(600)
    expect(getConnectionActivity()).toMatchObject({ latency: (40 + 60 + 600) / 3, quality: "good" })
    // A shifted average (three slow replies) moves the band.
    await reply(600)
    await reply(600)
    expect(getConnectionActivity()).toMatchObject({
      latency: 600, quality: "fair", lastReplyAgeMs: 0,
      recent: { requests: 6, failures: 0, averageLatency: 320, slowestLatency: 600 },
    })
    vi.advanceTimersByTime(300_000)
    expect(getConnectionActivity()).toMatchObject({
      latency: null, quality: null, lastReplyAgeMs: 300_000,
      recent: { requests: 0, averageLatency: null, slowestLatency: null },
    })
  })

  it("bands latency with boundaries far enough apart that jitter does not flip the label", async () => {
    const { qualityFor } = await import("./connection-activity")
    expect(qualityFor(null)).toBeNull()
    expect(qualityFor(299)).toBe("good")
    expect(qualityFor(300)).toBe("fair")
    expect(qualityFor(999)).toBe("fair")
    expect(qualityFor(1000)).toBe("slow")
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

  it("produces bounded graph points, preserving unobserved and idle reply gaps", async () => {
    const { observedSyncFetch, recordSyncBytes, getConnectionActivity } = await import("./connection-activity")
    recordSyncBytes("upload", "x".repeat(100))
    recordSyncBytes("download", "x".repeat(200))
    for (const ms of [20, 40]) {
      await observedSyncFetch("/cells", undefined, vi.fn(async () => {
        vi.advanceTimersByTime(ms)
        return new Response("{}")
      }))
    }
    let history = getConnectionActivity().history
    expect(history).toHaveLength(60)
    expect(history[0]).toEqual({ upload: null, download: null, latency: null })
    expect(history[59]).toEqual({ upload: 20, download: 40, latency: 30 })
    vi.advanceTimersByTime(10_000)
    history = getConnectionActivity().history
    expect(history[57]).toEqual({ upload: 20, download: 40, latency: 30 })
    expect(history[59]).toEqual({ upload: 0, download: 0, latency: null })
    vi.advanceTimersByTime(300_000)
    expect(getConnectionActivity().history).toEqual(Array.from({ length: 60 }, () => ({
      upload: 0, download: 0, latency: null,
    })))
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

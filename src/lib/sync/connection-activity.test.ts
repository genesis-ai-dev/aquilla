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
    expect(getConnectionActivity()).toEqual({ upload: 13 / 5, download: 13 / 5, latency: 125 })
    vi.advanceTimersByTime(5_000)
    expect(getConnectionActivity()).toEqual({ upload: 0, download: 0, latency: 125 })
    vi.advanceTimersByTime(25_000)
    expect(getConnectionActivity().latency).toBeNull()
  })

  it("counts existing socket traffic and expires it while idle", async () => {
    const { recordSyncBytes, getConnectionActivity } = await import("./connection-activity")
    recordSyncBytes("upload", "hello")
    recordSyncBytes("download", "é")
    expect(getConnectionActivity()).toEqual({ upload: 1, download: 0.4, latency: null })
    vi.advanceTimersByTime(5_000)
    expect(getConnectionActivity()).toEqual({ upload: 0, download: 0, latency: null })
  })

  it("does not invent measurements when a request fails", async () => {
    const { observedSyncFetch, getConnectionActivity } = await import("./connection-activity")
    const fetchFn = vi.fn().mockRejectedValue(new TypeError("offline"))
    await expect(observedSyncFetch("/events", { body: "unsent" }, fetchFn)).rejects.toThrow("offline")
    expect(getConnectionActivity()).toEqual({ upload: 0, download: 0, latency: null })
  })
})

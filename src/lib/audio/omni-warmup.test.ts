import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  __resetZsWarmupForTests, ensureZsReady, WARMUP_CAP_MS, WARMUP_POLL_MS, ZsWarmupError,
  type WarmupTimeoutChoice, type WarmupUi, type ZsState,
} from "./omni-warmup"

vi.mock("@/lib/frontier/auth", () => ({ AUTH_BASE: "http://identity" }))

// The zero-shot model takes minutes to start. These pin the promises the
// toast makes: a ready model costs no wait at all, a cold one is started once
// and polled until ready, a batch shares one wait, and the wait ends at the cap
// with the person's choice instead of spinning forever.

function serverWith(states: ZsState[]) {
  const calls: string[] = []
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input)
    calls.push(url)
    if (url.includes("/warm")) return Response.json({ ok: true }, { status: 202 })
    const state = states.length > 1 ? states.shift()! : states[0]
    return Response.json({ state, estGpuSecPerAudioSec: 0.3 })
  })
  return {
    statusCalls: () => calls.filter((url) => url.includes("/status")).length,
    warmCalls: () => calls.filter((url) => url.includes("/warm")).length,
  }
}

function fakeUi(choices: WarmupTimeoutChoice[] = []): WarmupUi & { log: string[] } {
  const log: string[] = []
  return {
    log,
    starting: () => { log.push("starting") },
    ready: () => { log.push("ready") },
    timedOut: async () => {
      log.push("timedOut")
      return choices.shift() ?? "dismiss"
    },
  }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  __resetZsWarmupForTests()
})

describe("zero-shot warm-up", () => {
  it("a ready model starts the run at once: no warm call, no toast", async () => {
    const server = serverWith(["ready"])
    const ui = fakeUi()
    await expect(ensureZsReady("jwt", "p1", ui)).resolves.toEqual({
      kind: "ready", status: { state: "ready", estGpuSecPerAudioSec: 0.3 },
    })
    expect(server.warmCalls()).toBe(0)
    expect(ui.log).toEqual([])
  })

  it("a cold model is warmed once and polled every 4 s until ready", async () => {
    const server = serverWith(["cold", "starting", "starting", "ready"])
    const ui = fakeUi()
    const outcome = ensureZsReady("jwt", "p1", ui)
    await vi.advanceTimersByTimeAsync(WARMUP_POLL_MS * 3)
    await expect(outcome).resolves.toMatchObject({ kind: "ready" })
    expect(server.warmCalls()).toBe(1)
    expect(server.statusCalls()).toBe(4)
    expect(ui.log).toEqual(["starting", "ready"])
  })

  it("a batch queued at once shares one warm-up and one toast", async () => {
    const server = serverWith(["cold", "ready"])
    const ui = fakeUi()
    const runs = [ensureZsReady("jwt", "p1", ui), ensureZsReady("jwt", "p1", ui), ensureZsReady("jwt", "p1", ui)]
    await vi.advanceTimersByTimeAsync(WARMUP_POLL_MS)
    const outcomes = await Promise.all(runs)
    expect(outcomes.every((o) => o.kind === "ready")).toBe(true)
    expect(server.warmCalls()).toBe(1)
    expect(ui.log.filter((entry) => entry === "starting")).toHaveLength(1)
  })

  it("stops polling at the 6-minute cap and hands the choice to the person", async () => {
    const server = serverWith(["cold"])
    const ui = fakeUi(["auto"])
    const outcome = ensureZsReady("jwt", "p1", ui)
    await vi.advanceTimersByTimeAsync(WARMUP_CAP_MS - WARMUP_POLL_MS)
    expect(ui.log).toEqual(["starting"])
    await vi.advanceTimersByTimeAsync(WARMUP_POLL_MS)
    await expect(outcome).resolves.toEqual({ kind: "use-auto" })
    expect(ui.log).toEqual(["starting", "timedOut"])
    // One initial check, then one poll per 4 s for six minutes.
    expect(server.statusCalls()).toBe(1 + WARMUP_CAP_MS / WARMUP_POLL_MS)
  })

  it("Retry warms again and keeps waiting; dismissing fails the run", async () => {
    const server = serverWith(["cold"])
    const ui = fakeUi(["retry", "dismiss"])
    const outcome = ensureZsReady("jwt", "p1", ui)
    const failed = expect(outcome).rejects.toBeInstanceOf(ZsWarmupError)
    await vi.advanceTimersByTimeAsync(WARMUP_CAP_MS * 2)
    await failed
    expect(server.warmCalls()).toBe(2)
    expect(ui.log).toEqual(["starting", "timedOut", "starting", "timedOut"])
  })

  it("a later run after the wait settles starts a fresh check", async () => {
    const server = serverWith(["ready"])
    await ensureZsReady("jwt", "p1", fakeUi())
    await ensureZsReady("jwt", "p1", fakeUi())
    expect(server.statusCalls()).toBe(2)
  })
})

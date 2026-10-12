import { beforeEach, describe, expect, it, vi } from "vitest"
import { checkClientSessionHead } from "./head-check"
import { STALL_WATCHDOG_MS } from "@/test-utils/timeouts"

const seq = (client: number) => ({ global: 0, client, rebaseGeneration: 0 })

const states = (sessionUpstream: number, leaderLocal: number, sessionLocal = sessionUpstream) => ({
  session: { upstreamHead: seq(sessionUpstream), localHead: seq(sessionLocal) },
  leader: { localHead: seq(leaderLocal) },
})

const storeWith = (sessionUpstream: number, leaderLocal: number, sessionLocal?: number) => ({
  _dev: { syncStates: () => Promise.resolve(states(sessionUpstream, leaderLocal, sessionLocal)) },
})

beforeEach(() => {
  sessionStorage.clear()
  vi.spyOn(console, "warn").mockImplementation(() => {})
  vi.spyOn(console, "error").mockImplementation(() => {})
})

describe("checkClientSessionHead", () => {
  it("passes when the session and leader agree", async () => {
    const reload = vi.fn()
    expect(await checkClientSessionHead(storeWith(2299, 2299), { reload })).toBe("ok")
    expect(reload).not.toHaveBeenCalled()
  })

  it("passes while the session's own pushes are in flight to the leader", async () => {
    const reload = vi.fn()
    expect(await checkClientSessionHead(storeWith(2299, 2300, 2301), { reload })).toBe("ok")
    expect(reload).not.toHaveBeenCalled()
  })

  it("reloads when the leader is ahead of everything the session knows (eventlog was ahead)", async () => {
    const reload = vi.fn()
    expect(await checkClientSessionHead(storeWith(327, 8591), { reload })).toBe("reloading")
    expect(reload).toHaveBeenCalledOnce()
  })

  it("reloads when the session booted ahead of the leader (state db was ahead)", async () => {
    const reload = vi.fn()
    expect(await checkClientSessionHead(storeWith(2309, 2299), { reload })).toBe("reloading")
    expect(reload).toHaveBeenCalledOnce()
  })

  it("does not reload again if the heads still disagree after the reload", async () => {
    const reload = vi.fn()
    await checkClientSessionHead(storeWith(2309, 2299), { reload })
    expect(await checkClientSessionHead(storeWith(2309, 2299), { reload })).toBe("mismatch-after-reload")
    expect(reload).toHaveBeenCalledOnce()
  })

  it("re-arms the reload once a boot comes up consistent", async () => {
    const reload = vi.fn()
    await checkClientSessionHead(storeWith(2309, 2299), { reload })
    await checkClientSessionHead(storeWith(2299, 2299), { reload })
    expect(await checkClientSessionHead(storeWith(2400, 2350), { reload })).toBe("reloading")
    expect(reload).toHaveBeenCalledTimes(2)
  })

  it("gives up waiting on a leader that never answers", async () => {
    const reload = vi.fn()
    const dead = { _dev: { syncStates: () => new Promise<never>(() => {}) } }
    expect(await checkClientSessionHead(dead, { reload, timeoutMs: 10 })).toBe("timeout")
    expect(reload).not.toHaveBeenCalled()
  })

  it("still reloads if a slow leader answers with a mismatch after the timeout", async () => {
    const reload = vi.fn()
    let answer: (s: ReturnType<typeof states>) => void = () => {}
    const slow = { _dev: { syncStates: () => new Promise<ReturnType<typeof states>>((r) => (answer = r)) } }
    expect(await checkClientSessionHead(slow, { reload, timeoutMs: 10 })).toBe("timeout")
    answer(states(2309, 2299))
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce(), { timeout: STALL_WATCHDOG_MS })
  })
})

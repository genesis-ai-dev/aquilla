import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { holdLeaderLock, LeaderLockStolenError, leaderLockName } from "./leader-lock"
import { STORE_ID } from "./store-id"

const quiet = { onSlow: () => {}, onSteal: () => {} }

/** Exclusive-only LockManager: grants in request order, one holder per name; supports `signal` and `steal`. */
function fakeLocks() {
  const held = new Map<string, () => void>()
  const queue: Array<{ name: string; grant: () => void }> = []
  const pump = () => {
    for (const waiter of [...queue]) {
      if (held.has(waiter.name)) continue
      queue.splice(queue.indexOf(waiter), 1)
      waiter.grant()
    }
  }
  const request = (name: string, ...args: unknown[]) => {
    const [options, callback] = (args.length === 1 ? [{}, args[0]] : args) as [
      { signal?: AbortSignal; steal?: boolean },
      () => Promise<void>,
    ]
    return new Promise<void>((resolve, reject) => {
      const waiter = {
        name,
        grant: () => {
          let stolen = false
          held.set(name, () => {
            stolen = true
            reject(new DOMException("stolen", "AbortError"))
          })
          // Like the real LockManager: held until the callback settles, which
          // the request then settles with.
          const run = Promise.resolve().then(callback)
          void run
            .finally(() => {
              if (stolen) return
              held.delete(name)
              pump()
            })
            .then(resolve, reject)
        },
      }
      if (options.steal) {
        held.get(name)?.()
        held.delete(name)
        waiter.grant()
        return
      }
      options.signal?.addEventListener("abort", () => {
        if (!queue.includes(waiter)) return
        queue.splice(queue.indexOf(waiter), 1)
        reject(new DOMException("aborted", "AbortError"))
      })
      queue.push(waiter)
      pump()
    })
  }
  return { locks: { request } as unknown as LockManager, isHeld: (name: string) => held.has(name) }
}

const settled = () => new Promise((r) => setTimeout(r, 0))

/** A leader whose run the test ends by hand. */
function controllableLeader() {
  let stop: () => void = () => {}
  let crash: (error: unknown) => void = () => {}
  const run = vi.fn(
    () =>
      new Promise<void>((resolve, reject) => {
        stop = resolve
        crash = reject
      }),
  )
  return { run, stop: () => stop(), crash: (error: unknown) => crash(error) }
}

describe("leaderLockName", () => {
  it("is the lock makePersistedAdapter takes, so old and new builds still exclude each other", () => {
    // Read from the installed LiveStore rather than restated, so a version
    // bump that renames its lock fails here instead of racing two leaders.
    const dist = dirname(createRequire(import.meta.url).resolve("@livestore/adapter-web"))
    const source = readFileSync(join(dist, "web-worker/client-session/persisted-adapter.js"), "utf8")
    // Just the template, so a reformat or renamed const upstream doesn't fail this.
    expect(source).toContain("`livestore-tab-lock-${storeId}`")
    expect(leaderLockName(STORE_ID)).toBe("livestore-tab-lock-aquilla-offline")
  })
})

describe("holdLeaderLock", () => {
  it("doesn't start a leader until the previous one has stopped", async () => {
    const { locks, isHeld } = fakeLocks()
    const oldLeader = controllableLeader()
    const newLeader = controllableLeader()
    const oldDone = holdLeaderLock("l", oldLeader.run, { locks, ...quiet })
    const newDone = holdLeaderLock("l", newLeader.run, { locks, ...quiet })
    await settled()
    expect(oldLeader.run).toHaveBeenCalledOnce()
    expect(newLeader.run).not.toHaveBeenCalled()

    oldLeader.stop()
    await oldDone
    await settled()
    expect(newLeader.run).toHaveBeenCalledOnce()
    expect(isHeld("l")).toBe(true)

    newLeader.stop()
    await newDone
    expect(isHeld("l")).toBe(false)
  })

  it("lets go of the lock when the leader crashes, and passes the error on", async () => {
    const { locks, isHeld } = fakeLocks()
    const leader = controllableLeader()
    const done = holdLeaderLock("l", leader.run, { locks, ...quiet })
    await settled()
    const error = new Error("boom")
    leader.crash(error)
    await expect(done).rejects.toBe(error)
    expect(isHeld("l")).toBe(false)
  })

  it("says so when the wait drags on, and not when it doesn't", async () => {
    vi.useFakeTimers()
    try {
      const { locks } = fakeLocks()
      const blocker = controllableLeader()
      const waiter = controllableLeader()
      const blockerSlow = vi.fn()
      const onSlow = vi.fn()
      void holdLeaderLock("l", blocker.run, { locks, ...quiet, slowAfterMs: 1000, onSlow: blockerSlow })
      const done = holdLeaderLock("l", waiter.run, { locks, ...quiet, slowAfterMs: 1000, onSlow })
      await vi.advanceTimersByTimeAsync(1000)
      expect(onSlow).toHaveBeenCalledWith(1000)
      expect(blockerSlow).not.toHaveBeenCalled()

      blocker.stop()
      await vi.advanceTimersByTimeAsync(0)
      waiter.stop()
      await done
      expect(onSlow).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it("takes the lock from a holder that never lets go, and says so", async () => {
    vi.useFakeTimers()
    try {
      const { locks } = fakeLocks()
      const stuck = controllableLeader()
      const leader = controllableLeader()
      const onSteal = vi.fn()
      const stuckDone = holdLeaderLock("l", stuck.run, { locks, ...quiet })
      const stuckSettled = stuckDone.catch((error: unknown) => error)
      const done = holdLeaderLock("l", leader.run, { locks, slowAfterMs: 1000, stealAfterMs: 5000, onSlow: () => {}, onSteal })
      await vi.advanceTimersByTimeAsync(4999)
      expect(leader.run).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(1)
      expect(onSteal).toHaveBeenCalledWith(5000)
      expect(leader.run).toHaveBeenCalledOnce()
      expect(await stuckSettled).toBeInstanceOf(LeaderLockStolenError)
      // The browser doesn't stop the old leader; its signal tells it to stand down.
      expect((stuck.run.mock.calls[0] as unknown as [AbortSignal])[0].aborted).toBe(true)

      leader.stop()
      await done
    } finally {
      vi.useRealTimers()
    }
  })

  it("doesn't steal once it has the lock, and passes a late leader error on", async () => {
    vi.useFakeTimers()
    try {
      const { locks } = fakeLocks()
      const leader = controllableLeader()
      const onSteal = vi.fn()
      const done = holdLeaderLock("l", leader.run, { locks, ...quiet, stealAfterMs: 1000, onSteal })
      await vi.advanceTimersByTimeAsync(5000)
      // The leader's own AbortError isn't mistaken for a steal.
      const error = new DOMException("leader gave up", "AbortError")
      leader.crash(error)
      await expect(done).rejects.toBe(error)
      expect((leader.run.mock.calls[0] as unknown as [AbortSignal])[0].aborted).toBe(false)
      expect(onSteal).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it("rejects when the lock request fails, instead of hanging", async () => {
    const error = new DOMException("denied", "SecurityError")
    const locks = { request: () => Promise.reject(error) } as unknown as LockManager
    await expect(holdLeaderLock("l", vi.fn(), { locks, ...quiet })).rejects.toBe(error)
  })

  it("rejects without Web Locks", async () => {
    vi.stubGlobal("navigator", {})
    try {
      const leader = vi.fn()
      await expect(holdLeaderLock("l", leader, quiet)).rejects.toThrow(/navigator\.locks/)
      expect(leader).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

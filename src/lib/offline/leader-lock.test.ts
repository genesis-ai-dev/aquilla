import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { holdLeaderLock, leaderLockName } from "./leader-lock"
import { STORE_ID } from "./store-id"

/** Exclusive-only LockManager: grants in request order, one holder per name. */
function fakeLocks() {
  const held = new Set<string>()
  const queue: Array<{ name: string; grant: () => void }> = []
  const pump = () => {
    for (const waiter of [...queue]) {
      if (held.has(waiter.name)) continue
      queue.splice(queue.indexOf(waiter), 1)
      waiter.grant()
    }
  }
  const request = (name: string, callback: () => Promise<void>) =>
    new Promise<void>((resolve, reject) => {
      queue.push({
        name,
        grant: () => {
          held.add(name)
          // Like the real LockManager: held until the callback settles, which
          // the request then settles with.
          const run = Promise.resolve().then(callback)
          void run
            .finally(() => {
              held.delete(name)
              pump()
            })
            .then(resolve, reject)
        },
      })
      pump()
    })
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
    expect(source).toContain("const LIVESTORE_TAB_LOCK = `livestore-tab-lock-${storeId}`;")
    expect(leaderLockName(STORE_ID)).toBe("livestore-tab-lock-aquilla-offline")
  })
})

describe("holdLeaderLock", () => {
  it("doesn't start a leader until the previous one has stopped", async () => {
    const { locks, isHeld } = fakeLocks()
    const oldLeader = controllableLeader()
    const newLeader = controllableLeader()
    const oldDone = holdLeaderLock("l", oldLeader.run, { locks })
    const newDone = holdLeaderLock("l", newLeader.run, { locks })
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
    const done = holdLeaderLock("l", leader.run, { locks })
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
      void holdLeaderLock("l", blocker.run, { locks, slowAfterMs: 1000, onSlow: blockerSlow })
      const done = holdLeaderLock("l", waiter.run, { locks, slowAfterMs: 1000, onSlow })
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

  it("rejects when the lock request fails, instead of hanging", async () => {
    const error = new DOMException("denied", "SecurityError")
    const locks = { request: () => Promise.reject(error) } as unknown as LockManager
    await expect(holdLeaderLock("l", vi.fn(), { locks })).rejects.toBe(error)
  })

  it("rejects without Web Locks", async () => {
    vi.stubGlobal("navigator", {})
    try {
      const leader = vi.fn()
      await expect(holdLeaderLock("l", leader)).rejects.toThrow(/navigator\.locks/)
      expect(leader).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

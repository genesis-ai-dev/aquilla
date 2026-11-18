import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { makeInMemoryAdapter } from "@livestore/adapter-web"
import { createStorePromise } from "@livestore/livestore"
import { describe, expect, it, vi } from "vitest"
import { leaderLockName, releaseLockOnShutdown, requestLeaderLock } from "./leader-lock"
import { schema } from "./schema"
import { STORE_ID } from "./store"

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
    new Promise<void>((done) => {
      queue.push({
        name,
        grant: () => {
          held.add(name)
          void callback().then(() => {
            held.delete(name)
            done()
            pump()
          })
        },
      })
      pump()
    })
  return { locks: { request } as unknown as LockManager, isHeld: (name: string) => held.has(name) }
}

const settled = () => new Promise((r) => setTimeout(r, 0))

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

describe("requestLeaderLock", () => {
  it("waits for the previous holder, and hands over when it releases", async () => {
    const { locks, isHeld } = fakeLocks()
    const oldPage = requestLeaderLock("l", locks)
    await oldPage.acquired
    const newPage = requestLeaderLock("l", locks)
    const granted = vi.fn()
    void newPage.acquired.then(granted)
    await settled()
    expect(granted).not.toHaveBeenCalled()

    oldPage.release()
    await newPage.acquired
    expect(isHeld("l")).toBe(true)
    newPage.release()
    await settled()
    expect(isHeld("l")).toBe(false)
  })

  it("rejects when the lock request fails, instead of hanging", async () => {
    const error = new DOMException("denied", "SecurityError")
    const locks = { request: () => Promise.reject(error) } as unknown as LockManager
    await expect(requestLeaderLock("l", locks).acquired).rejects.toBe(error)
  })

  it("throws without Web Locks", () => {
    expect(() => requestLeaderLock("l", undefined)).toThrow(/navigator\.locks/)
  })
})

describe("releaseLockOnShutdown", () => {
  it("releases the lock when the store shuts down, not before", async () => {
    const release = vi.fn()
    const store = await createStorePromise({
      schema,
      storeId: `leader-lock-test-${crypto.randomUUID()}`,
      adapter: releaseLockOnShutdown(makeInMemoryAdapter(), release),
    })
    expect(release).not.toHaveBeenCalled()
    await store.shutdownPromise()
    // The adapter's scope closes just after shutdownPromise() settles.
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce())
  })
})

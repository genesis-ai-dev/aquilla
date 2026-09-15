// WHY: two `migrate-all --apply` writers (nightly Action + a stray local run)
// must never overlap. These tests pin the lease protocol: a live lock blocks,
// an expired lock is reclaimed, a lost GET→PUT race is reported as "held", and
// heartbeat extends the lease.

import { describe, it, expect } from "vitest"
import { RunLock, LockHeldError, type LockStore } from "./run-lock"

function memStore(): LockStore & { objects: Map<string, string> } {
  const objects = new Map<string, string>()
  return {
    objects,
    get: async (k) => objects.get(k) ?? null,
    put: async (k, body, opts) => {
      if (opts?.ifNoneMatch && objects.has(k)) {
        throw Object.assign(new Error("PutObject 412"), { status: 412 })
      }
      objects.set(k, body)
    },
    delete: async (k) => {
      objects.delete(k)
    },
  }
}

const KEY = "_migrate/audio-migrate-state.lock"

describe("RunLock", () => {
  it("acquires when free and releases on release()", async () => {
    const store = memStore()
    const lock = new RunLock({ store, key: KEY, holder: "a", ttlMs: 1000, now: () => 0 })
    await lock.acquire()
    expect(JSON.parse(store.objects.get(KEY)!)).toMatchObject({ holder: "a" })
    await lock.release()
    expect(store.objects.has(KEY)).toBe(false)
  })

  it("refuses a second holder while the lease is live", async () => {
    const store = memStore()
    await new RunLock({ store, key: KEY, holder: "gh-run-1", ttlMs: 60_000, now: () => 0 }).acquire()
    const other = new RunLock({ store, key: KEY, holder: "laptop", ttlMs: 60_000, now: () => 30_000 })
    await expect(other.acquire()).rejects.toBeInstanceOf(LockHeldError)
    await expect(other.acquire()).rejects.toThrow(/held by gh-run-1/)
    expect(JSON.parse(store.objects.get(KEY)!).holder).toBe("gh-run-1")
  })

  it("reclaims an expired lease (crashed holder)", async () => {
    const store = memStore()
    await new RunLock({ store, key: KEY, holder: "crashed", ttlMs: 60_000, now: () => 0 }).acquire()
    const next = new RunLock({ store, key: KEY, holder: "next", ttlMs: 60_000, now: () => 60_001 })
    await next.acquire()
    expect(JSON.parse(store.objects.get(KEY)!).holder).toBe("next")
  })

  it("reports the winner when the create-only PUT loses the race", async () => {
    const store = memStore()
    let gets = 0
    const racy: LockStore = {
      ...store,
      get: async (k) => {
        gets++
        // First GET (pre-check) sees nothing; a rival lands before our PUT.
        if (gets === 1) {
          await store.put(k, JSON.stringify({ holder: "rival", acquiredAt: "x", expiresAt: new Date(10_000).toISOString() }))
          return null
        }
        return store.get(k)
      },
    }
    const lock = new RunLock({ store: racy, key: KEY, holder: "me", ttlMs: 1000, now: () => 0 })
    await expect(lock.acquire()).rejects.toThrow(/held by rival/)
  })

  it("heartbeat extends the lease so a long healthy run keeps exclusivity", async () => {
    const store = memStore()
    let t = 0
    const lock = new RunLock({ store, key: KEY, holder: "long", ttlMs: 1000, now: () => t })
    await lock.acquire()
    t = 900
    await lock.heartbeat()
    const rival = new RunLock({ store, key: KEY, holder: "rival", ttlMs: 1000, now: () => 1500 })
    await expect(rival.acquire()).rejects.toBeInstanceOf(LockHeldError)
  })

  it("release is a no-op when never acquired (does not delete someone else's lock)", async () => {
    const store = memStore()
    store.objects.set(KEY, JSON.stringify({ holder: "x", acquiredAt: "a", expiresAt: new Date(10_000).toISOString() }))
    await new RunLock({ store, key: KEY, holder: "me", ttlMs: 1, now: () => 0 }).release()
    expect(store.objects.has(KEY)).toBe(true)
  })
})

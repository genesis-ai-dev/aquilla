// AQU-1865 — the origin-quota contract the caches and the outbox share.
//
// The load-bearing property is the ordering in `withStorageQuotaRecovery`: a
// write that fails for want of space must reclaim and retry exactly once, and
// any other failure must propagate untouched. Everything downstream (the cells
// cache shedding snapshots, the outbox keeping a contributor's edit) is built on
// that single rule, so it is tested directly rather than through IndexedDB.

import { afterEach, describe, expect, it, vi } from "vitest"
import {
  __resetStoragePressureForTests,
  isQuotaExceededError,
  isStorageNearlyFull,
  markStorageQuotaExceeded,
  refreshStoragePressure,
  requestPersistentStorage,
  STORAGE_NEARLY_FULL_RATIO,
  subscribeStoragePressure,
  withStorageQuotaRecovery,
} from "./storage-pressure"

function quotaError(name = "QuotaExceededError"): Error {
  const error = new Error("no room")
  error.name = name
  return error
}

/** Install a fake `navigator.storage` for one test. */
function stubStorage(storage: unknown): void {
  Object.defineProperty(navigator, "storage", {
    value: storage,
    configurable: true,
    writable: true,
  })
}

afterEach(() => {
  __resetStoragePressureForTests()
  vi.restoreAllMocks()
})

describe("isQuotaExceededError", () => {
  it("recognises the shapes browsers actually throw", () => {
    expect(isQuotaExceededError(quotaError())).toBe(true)
    // Firefox's legacy IndexedDB name, same code 22.
    expect(isQuotaExceededError(quotaError("NS_ERROR_DOM_QUOTA_REACHED"))).toBe(true)
    expect(isQuotaExceededError({ code: 22 })).toBe(true)
  })

  it("does not mistake other failures for a full disk", () => {
    expect(isQuotaExceededError(new Error("IDB put failed"))).toBe(false)
    expect(isQuotaExceededError(quotaError("AbortError"))).toBe(false)
    expect(isQuotaExceededError(null)).toBe(false)
    expect(isQuotaExceededError("QuotaExceededError")).toBe(false)
  })
})

describe("withStorageQuotaRecovery", () => {
  it("reclaims once and retries when the first write is out of room", async () => {
    const order: string[] = []
    let attempts = 0
    const write = vi.fn(async () => {
      attempts += 1
      order.push(`write:${attempts}`)
      if (attempts === 1) throw quotaError()
    })
    const reclaim = vi.fn(async () => { order.push("reclaim") })

    await withStorageQuotaRecovery(write, reclaim)

    expect(order).toEqual(["write:1", "reclaim", "write:2"])
    expect(isStorageNearlyFull()).toBe(true)
  })

  it("does not reclaim anything when the write succeeds", async () => {
    const reclaim = vi.fn(async () => undefined)
    await withStorageQuotaRecovery(async () => undefined, reclaim)
    expect(reclaim).not.toHaveBeenCalled()
    expect(isStorageNearlyFull()).toBe(false)
  })

  it("propagates a non-quota failure without touching the caches", async () => {
    const reclaim = vi.fn(async () => undefined)
    const boom = new Error("enqueue tx failed")
    await expect(
      withStorageQuotaRecovery(async () => { throw boom }, reclaim),
    ).rejects.toBe(boom)
    expect(reclaim).not.toHaveBeenCalled()
    expect(isStorageNearlyFull()).toBe(false)
  })

  it("propagates a second quota failure — a full disk is the caller's to report", async () => {
    const reclaim = vi.fn(async () => undefined)
    const write = vi.fn(async () => { throw quotaError() })
    await expect(withStorageQuotaRecovery(write, reclaim)).rejects.toSatisfy(isQuotaExceededError)
    expect(write).toHaveBeenCalledTimes(2)
    expect(reclaim).toHaveBeenCalledTimes(1)
  })
})

describe("storage pressure state", () => {
  it("notifies subscribers once when pressure latches on", () => {
    const seen: boolean[] = []
    const unsubscribe = subscribeStoragePressure((nearlyFull) => seen.push(nearlyFull))
    markStorageQuotaExceeded()
    markStorageQuotaExceeded()
    unsubscribe()
    markStorageQuotaExceeded()
    expect(seen).toEqual([true])
  })

  it("warns once an estimate crosses the ratio", async () => {
    stubStorage({
      estimate: async () => ({ usage: STORAGE_NEARLY_FULL_RATIO * 1000, quota: 1000 }),
    })
    await expect(refreshStoragePressure()).resolves.toBe(true)
    expect(isStorageNearlyFull()).toBe(true)
  })

  it("stays quiet on a roomy origin", async () => {
    stubStorage({ estimate: async () => ({ usage: 10, quota: 1000 }) })
    await expect(refreshStoragePressure()).resolves.toBe(false)
  })

  it("treats a missing or throwing estimate as unknown, not full", async () => {
    stubStorage({})
    await expect(refreshStoragePressure()).resolves.toBe(false)
    stubStorage({ estimate: async () => { throw new Error("blocked") } })
    await expect(refreshStoragePressure()).resolves.toBe(false)
    expect(isStorageNearlyFull()).toBe(false)
  })

  it("never clears a quota error it has already seen", async () => {
    stubStorage({ estimate: async () => ({ usage: 1, quota: 1_000_000 }) })
    markStorageQuotaExceeded()
    await refreshStoragePressure()
    expect(isStorageNearlyFull()).toBe(true)
  })
})

describe("requestPersistentStorage", () => {
  it("asks once per session and remembers the answer", async () => {
    const persist = vi.fn(async () => true)
    stubStorage({ persist, persisted: async () => false })
    await expect(requestPersistentStorage()).resolves.toBe(true)
    await expect(requestPersistentStorage()).resolves.toBe(true)
    expect(persist).toHaveBeenCalledTimes(1)
  })

  it("does not re-ask when the origin is already persisted", async () => {
    const persist = vi.fn(async () => false)
    stubStorage({ persist, persisted: async () => true })
    await expect(requestPersistentStorage()).resolves.toBe(true)
    expect(persist).not.toHaveBeenCalled()
  })

  it("reports a refusal or an absent API without throwing", async () => {
    stubStorage({})
    await expect(requestPersistentStorage()).resolves.toBe(false)
    __resetStoragePressureForTests()
    stubStorage({ persist: async () => { throw new Error("denied") }, persisted: async () => false })
    await expect(requestPersistentStorage()).resolves.toBe(false)
  })
})

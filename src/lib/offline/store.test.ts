import { makeInMemoryAdapter } from "@livestore/adapter-web"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { __resetOfflineStoreForTests, failBootOnLeaderError, getOfflineStore, whenOfflineStoreVerified } from "./store"
import { OfflineLeaderBootError } from "./leader-boot-error"
import { events, OFFLINE_DATA_GENERATION, tables } from "./schema"
import { NewerOfflineDataError, type GenerationMarker } from "./generation-guard"

const markerAt = (generation: number | null): GenerationMarker => ({
  read: async () => generation,
  write: async () => {},
})
const freshDevice = markerAt(null)

const withTauriGlobal = () => {
  ;(window as unknown as { __TAURI__?: object }).__TAURI__ = {}
}

const withoutTauriGlobal = () => {
  delete (window as unknown as { __TAURI__?: object }).__TAURI__
}

beforeEach(() => {
  __resetOfflineStoreForTests()
})

afterEach(() => {
  withoutTauriGlobal()
})

describe("getOfflineStore", () => {
  it("rejects outside the Tauri runtime", async () => {
    withoutTauriGlobal()
    await expect(getOfflineStore(() => makeInMemoryAdapter(), freshDevice)).rejects.toThrow(/Tauri desktop app/)
  })

  it("boots a working store when run inside Tauri", async () => {
    withTauriGlobal()
    const store = await getOfflineStore(() => makeInMemoryAdapter(), freshDevice)

    store.commit(
      events.projectSynced({
        id: "proj1",
        name: "Test Project",
        orgId: "org1",
        settings: null,
        syncedAt: null,
      }),
    )
    expect(store.query(tables.projects.select().where({ id: "proj1" }).first())).toMatchObject({
      name: "Test Project",
    })
  })

  it("memoizes the store across repeat calls", async () => {
    withTauriGlobal()
    let calls = 0
    const createAdapter = () => {
      calls += 1
      return makeInMemoryAdapter()
    }

    const [first, second] = await Promise.all([getOfflineStore(createAdapter, freshDevice), getOfflineStore(createAdapter, freshDevice)])

    expect(first).toBe(second)
    expect(calls).toBe(1)
  })

  it("won't open offline data a newer build wrote", async () => {
    withTauriGlobal()
    let calls = 0
    const createAdapter = () => {
      calls += 1
      return makeInMemoryAdapter()
    }

    await expect(getOfflineStore(createAdapter, markerAt(OFFLINE_DATA_GENERATION + 1))).rejects.toBeInstanceOf(
      NewerOfflineDataError,
    )
    expect(calls).toBe(0)
  })

  it("fails the boot when the leader worker stops before the store opens", async () => {
    withTauriGlobal()
    const leader = new EventTarget()
    // The adapter never finishes, as when LiveStore's shutdown leaves its boot waiting.
    const booting = getOfflineStore(() => {
      failBootOnLeaderError(leader)
      return new Promise<never>(() => {})
    }, freshDevice)
    await new Promise((resolve) => setTimeout(resolve, 0))

    leader.dispatchEvent(new ErrorEvent("error", { message: "Error: [offline] a60q7b6rsy is still open in another leader" }))

    await expect(booting).rejects.toBeInstanceOf(OfflineLeaderBootError)
    await expect(booting).rejects.toThrow(/still open in another leader/)
  })

  it("ignores a leader error once the store is out", async () => {
    withTauriGlobal()
    const leader = new EventTarget()
    const store = await getOfflineStore(() => {
      failBootOnLeaderError(leader)
      return makeInMemoryAdapter()
    }, freshDevice)

    leader.dispatchEvent(new ErrorEvent("error", { message: "late" }))

    await expect(getOfflineStore()).resolves.toBe(store)
  })

  it("reports the store verified once the leader confirms the session's head", async () => {
    withTauriGlobal()
    await getOfflineStore(() => makeInMemoryAdapter(), freshDevice)
    await expect(whenOfflineStoreVerified()).resolves.toBeUndefined()
  })
})

describe("the LiveStore adapter the desktop app boots", () => {
  // LiveStore documents makeSingleTabAdapter as a fallback it means to remove;
  // the offline store's persistence depends on it (see store.ts). Fail here,
  // not on a device, if a LiveStore bump drops it.
  it("is still exported by @livestore/adapter-web", async () => {
    const adapterWeb = await import("@livestore/adapter-web")
    expect(typeof adapterWeb.makeSingleTabAdapter).toBe("function")
  })
})

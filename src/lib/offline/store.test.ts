import { makeInMemoryAdapter } from "@livestore/adapter-web"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { __resetOfflineStoreForTests, getOfflineStore } from "./store"
import { events, tables } from "./schema"

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
    await expect(getOfflineStore(() => makeInMemoryAdapter())).rejects.toThrow(/Tauri desktop app/)
  })

  it("boots a working store when run inside Tauri", async () => {
    withTauriGlobal()
    const store = await getOfflineStore(() => makeInMemoryAdapter())

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

    const [first, second] = await Promise.all([getOfflineStore(createAdapter), getOfflineStore(createAdapter)])

    expect(first).toBe(second)
    expect(calls).toBe(1)
  })
})

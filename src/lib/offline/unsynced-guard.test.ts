import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { makeInMemoryAdapter } from "@livestore/adapter-web"
import { createStorePromise, type Store } from "@livestore/livestore"
import { renderHook, act } from "@testing-library/react"
import { schema, events, type schema as SchemaType } from "./schema"
import { hasUnsyncedOfflineWork, useUnsyncedOfflineWorkGuard } from "./unsynced-guard"

let store: Store<typeof SchemaType>
let storeId = 0

beforeEach(async () => {
  storeId += 1
  store = await createStorePromise({
    schema,
    storeId: `unsynced-guard-test-${storeId}`,
    adapter: makeInMemoryAdapter(),
    disableDevtools: true,
    batchUpdates: (run) => run(),
  })
})

function queueRow(overrides: Partial<Parameters<typeof events.eventQueued>[0]> = {}) {
  store.commit(
    events.eventQueued({
      id: overrides.id ?? "evt1",
      projectId: overrides.projectId ?? "proj1",
      fileId: overrides.fileId ?? null,
      cellId: overrides.cellId ?? null,
      kind: overrides.kind ?? "target.cell.commit",
      payload: overrides.payload ?? {},
      parentId: overrides.parentId ?? null,
      author: overrides.author ?? "alice",
      schemaVersion: overrides.schemaVersion ?? 1,
      clientTs: overrides.clientTs ?? new Date(),
      createdAt: overrides.createdAt ?? new Date(),
    }),
  )
}

describe("hasUnsyncedOfflineWork", () => {
  it("is false for an empty store", () => {
    expect(hasUnsyncedOfflineWork(store)).toBe(false)
  })

  it("is true when a queued write exists", () => {
    queueRow()
    expect(hasUnsyncedOfflineWork(store)).toBe(true)
  })

  it("is true while a project download is in flight", () => {
    store.commit(
      events.offlineProjectStatusSet({ projectId: "proj1", status: "downloading", syncedAt: null, queueDepth: 0 }),
    )
    expect(hasUnsyncedOfflineWork(store)).toBe(true)
  })

  it("is false once a project has finished downloading and the queue is empty", () => {
    store.commit(
      events.offlineProjectStatusSet({ projectId: "proj1", status: "ready", syncedAt: new Date(), queueDepth: 0 }),
    )
    expect(hasUnsyncedOfflineWork(store)).toBe(false)
  })
})

describe("useUnsyncedOfflineWorkGuard", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("does not install a beforeunload listener when there is no store", () => {
    const addSpy = vi.spyOn(window, "addEventListener")
    renderHook(() => useUnsyncedOfflineWorkGuard(null))
    expect(addSpy).not.toHaveBeenCalledWith("beforeunload", expect.any(Function))
  })

  it("does not warn when the store has no unsynced work", () => {
    const addSpy = vi.spyOn(window, "addEventListener")
    renderHook(() => useUnsyncedOfflineWorkGuard(store))
    expect(addSpy).not.toHaveBeenCalledWith("beforeunload", expect.any(Function))
  })

  it("installs and removes a beforeunload guard as queued work appears and clears", () => {
    const addSpy = vi.spyOn(window, "addEventListener")
    const removeSpy = vi.spyOn(window, "removeEventListener")
    renderHook(() => useUnsyncedOfflineWorkGuard(store))
    expect(addSpy).not.toHaveBeenCalledWith("beforeunload", expect.any(Function))

    act(() => {
      queueRow()
    })
    expect(addSpy).toHaveBeenCalledWith("beforeunload", expect.any(Function))

    const calls = addSpy.mock.calls as unknown as Array<[string, EventListener]>
    const handler = calls.find(([type]) => type === "beforeunload")?.[1] as EventListener
    const fakeEvent = { preventDefault: vi.fn(), returnValue: "" } as unknown as BeforeUnloadEvent
    handler(fakeEvent)
    expect(fakeEvent.preventDefault).toHaveBeenCalled()

    act(() => {
      store.commit(events.eventDequeued({ id: "evt1" }))
    })
    expect(removeSpy).toHaveBeenCalledWith("beforeunload", handler)
  })
})

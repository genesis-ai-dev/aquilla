import { afterEach, describe, expect, it, vi } from "vitest"
import {
  __resetOfflineBootProgressForTests,
  getOfflineBootProgress,
  installRebuildProgressForwarder,
  listenForOfflineRebuildProgress,
  reportOfflineRebuildProgress,
} from "./boot-progress"

type Hook = (progress: { done: number; total: number }) => void
const hookHolder = globalThis as { __livestoreRehydrateProgress?: Hook }

afterEach(() => {
  __resetOfflineBootProgressForTests()
  delete hookHolder.__livestoreRehydrateProgress
})

describe("offline rebuild progress", () => {
  it("starts idle", () => {
    expect(getOfflineBootProgress()).toEqual({ rebuilding: false, done: 0, total: 0, lastProgressAt: 0 })
  })

  it("is rebuilding until the replay reaches the last event", () => {
    reportOfflineRebuildProgress({ done: 250, total: 1000 }, () => 2)
    expect(getOfflineBootProgress()).toEqual({ rebuilding: true, done: 250, total: 1000, lastProgressAt: 2 })

    reportOfflineRebuildProgress({ done: 1000, total: 1000 }, () => 3)
    expect(getOfflineBootProgress()).toMatchObject({ rebuilding: false, lastProgressAt: 3 })
  })

  it("forwards the leader's per-event hook to the page, throttled, always including the last event", async () => {
    let now = 0
    installRebuildProgressForwarder(() => now)
    const stop = listenForOfflineRebuildProgress()
    const hook = hookHolder.__livestoreRehydrateProgress
    expect(hook).toBeTypeOf("function")

    hook?.({ done: 1, total: 4 })
    now = 100
    hook?.({ done: 2, total: 4 }) // within the throttle window — dropped
    await vi.waitFor(() => expect(getOfflineBootProgress()).toMatchObject({ rebuilding: true, done: 1 }))

    now = 150
    hook?.({ done: 4, total: 4 })
    await vi.waitFor(() => expect(getOfflineBootProgress()).toMatchObject({ rebuilding: false, done: 4 }))
    stop()
  })
})

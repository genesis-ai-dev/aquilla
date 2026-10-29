import { afterEach, describe, expect, it } from "vitest"
import { __resetOfflineBootProgressForTests, getOfflineBootProgress, reportOfflineBootStatus } from "./boot-progress"

afterEach(() => __resetOfflineBootProgressForTests())

describe("offline boot progress", () => {
  it("starts idle", () => {
    expect(getOfflineBootProgress()).toEqual({ rebuilding: false, done: 0, total: 0, lastProgressAt: 0 })
  })

  it("tracks an eventlog replay and clears it when boot finishes", () => {
    reportOfflineBootStatus({ stage: "loading" }, () => 1)
    expect(getOfflineBootProgress()).toMatchObject({ rebuilding: false, lastProgressAt: 1 })

    reportOfflineBootStatus({ stage: "rehydrating", progress: { done: 250, total: 1000 } }, () => 2)
    expect(getOfflineBootProgress()).toEqual({ rebuilding: true, done: 250, total: 1000, lastProgressAt: 2 })

    reportOfflineBootStatus({ stage: "done" }, () => 3)
    expect(getOfflineBootProgress()).toMatchObject({ rebuilding: false, lastProgressAt: 3 })
  })

  it("doesn't call an empty replay a rebuild", () => {
    reportOfflineBootStatus({ stage: "rehydrating", progress: { done: 0, total: 0 } }, () => 5)
    expect(getOfflineBootProgress()).toMatchObject({ rebuilding: false, lastProgressAt: 5 })
  })
})

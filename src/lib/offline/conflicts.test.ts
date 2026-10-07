import { describe, it, expect, beforeEach } from "vitest"
import { act, renderHook } from "@testing-library/react"
import {
  __resetConflictsForTests,
  dismissConflict,
  getConflicts,
  markConflict,
  subscribeConflicts,
  useConflicts,
} from "./conflicts"

beforeEach(() => {
  __resetConflictsForTests()
})

describe("markConflict / dismissConflict", () => {
  it("adds and removes a key, notifying subscribers on each actual change", () => {
    let notifications = 0
    const unsubscribe = subscribeConflicts(() => {
      notifications++
    })

    markConflict("proj1:file1:GEN 1:1:target")
    expect(getConflicts().has("proj1:file1:GEN 1:1:target")).toBe(true)
    expect(notifications).toBe(1)

    // Idempotent: marking an already-conflicted key doesn't renotify.
    markConflict("proj1:file1:GEN 1:1:target")
    expect(notifications).toBe(1)

    dismissConflict("proj1:file1:GEN 1:1:target")
    expect(getConflicts().has("proj1:file1:GEN 1:1:target")).toBe(false)
    expect(notifications).toBe(2)

    // Dismissing an absent key doesn't renotify.
    dismissConflict("proj1:file1:GEN 1:1:target")
    expect(notifications).toBe(2)

    unsubscribe()
  })
})

describe("useConflicts", () => {
  it("re-renders as conflicts are marked and dismissed", () => {
    const { result } = renderHook(() => useConflicts())
    expect(result.current.has("k1")).toBe(false)

    act(() => {
      markConflict("k1")
    })
    expect(result.current.has("k1")).toBe(true)

    act(() => {
      dismissConflict("k1")
    })
    expect(result.current.has("k1")).toBe(false)
  })
})

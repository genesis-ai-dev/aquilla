// AQU-2262: Project settings save as you change them, and the app's Undo takes
// a change back. The settings page can be open on its own (no workspace behind
// it) or as a dialog over the workspace, so the history has to be hostable by
// either, and the two must never both act on one press.
import { describe, it, expect, beforeEach } from "vitest"
import { renderHook } from "@testing-library/react"
import {
  historyReady,
  historyView,
  holdHistoryScope,
  recordStep,
  registerStepKinds,
  resetHistoryForTests,
  setHistoryScope,
  undoLast,
  type StepHandler,
} from "./history"
import { clearHistoryStoreForTests } from "./history-store"
import { useHistoryShortcuts } from "./useHistory"

function logKind(log: string[], who: string): StepHandler<never> {
  return {
    undo: async () => {
      log.push(`undo by ${who}`)
      return { kind: "done" }
    },
    redo: async () => ({ kind: "done" }),
  } as StepHandler<never>
}

beforeEach(async () => {
  resetHistoryForTests()
  await clearHistoryStoreForTests()
})

describe("two hosts of one history", () => {
  it("a kind registered twice falls back to the earlier registration when the newer one leaves", async () => {
    setHistoryScope("p1", "sam")
    await historyReady()
    const log: string[] = []
    registerStepKinds({ "test.log": logKind(log, "workspace") })
    const leave = registerStepKinds({ "test.log": logKind(log, "settings") })
    recordStep({ kind: "test.log", data: {}, labelKey: "a" })
    recordStep({ kind: "test.log", data: {}, labelKey: "b" })
    await undoLast()
    leave()
    await undoLast()
    expect(log).toEqual(["undo by settings", "undo by workspace"])
  })

  it("settings opened on their own page host the project's history while they are open", async () => {
    const release = holdHistoryScope("p1", "sam")
    await historyReady()
    registerStepKinds({ "test.log": logKind([], "settings") })
    recordStep({ kind: "test.log", data: {}, labelKey: "Change: Smart quotes" })
    expect(historyView().nextUndo?.labelKey).toBe("Change: Smart quotes")
    release()
    expect(historyView().canUndo).toBe(false)
  })

  it("settings opened over the workspace leave the workspace's history where it is", async () => {
    setHistoryScope("p1", "sam", "es")
    await historyReady()
    recordStep({ kind: "test.log", data: {}, labelKey: "Edit translation" })
    const release = holdHistoryScope("p1", "sam")
    release()
    expect(historyView().nextUndo?.labelKey).toBe("Edit translation")
  })

  it("one Cmd+Z undoes one step even when the workspace and the settings page both listen", async () => {
    setHistoryScope("p1", "sam")
    await historyReady()
    const log: string[] = []
    registerStepKinds({ "test.log": logKind(log, "either") })
    recordStep({ kind: "test.log", data: {}, labelKey: "a" })
    recordStep({ kind: "test.log", data: {}, labelKey: "b" })
    renderHook(() => useHistoryShortcuts(() => {}))
    renderHook(() => useHistoryShortcuts(() => {}))
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, cancelable: true }))
    for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0))
    expect(log).toEqual(["undo by either"])
    expect(historyView().undoSteps.map((s) => s.labelKey)).toEqual(["a"])
  })
})

// AQU-1767: the per-user edit history and who owns Cmd/Ctrl+Z.
import { describe, it, expect, beforeEach } from "vitest"
import {
  historyView,
  recordStep,
  redoLast,
  resetHistoryForTests,
  setHistoryScope,
  undoLast,
  type HistoryStep,
  type StepOutcome,
} from "./history"
import { setToastUndoAt, undoShortcutOwner } from "./arbiter"

function step(label: string, at: number, log: string[], outcome: StepOutcome = { kind: "done" }): HistoryStep {
  return {
    labelKey: label,
    at,
    undo: async () => {
      log.push(`undo ${label}`)
      return outcome
    },
    redo: async () => {
      log.push(`redo ${label}`)
      return { kind: "done" }
    },
  }
}

beforeEach(() => {
  resetHistoryForTests()
  setToastUndoAt(null)
  setHistoryScope("p1", "sam")
})

describe("edit history", () => {
  it("undoes newest first, then redoes it; a new step clears redo", async () => {
    const log: string[] = []
    recordStep(step("a", 1, log))
    recordStep(step("b", 2, log))
    expect(historyView().nextUndo?.labelKey).toBe("b")
    await undoLast()
    expect(historyView().nextRedo?.labelKey).toBe("b")
    await redoLast()
    expect(log).toEqual(["undo b", "redo b"])
    await undoLast()
    recordStep(step("c", 3, log))
    expect(historyView().canRedo).toBe(false)
  })

  it("a skipped step leaves the stack, so the next undo reaches the one before", async () => {
    const log: string[] = []
    recordStep(step("a", 1, log))
    recordStep(step("b", 2, log, { kind: "skipped", reason: "changed" }))
    const r = await undoLast()
    expect(r?.outcome).toEqual({ kind: "skipped", reason: "changed" })
    expect(historyView().canRedo).toBe(false)
    await undoLast()
    expect(log).toEqual(["undo b", "undo a"])
  })

  it("keeps one stack per project and person", async () => {
    const log: string[] = []
    recordStep(step("a", 1, log))
    setHistoryScope("p2", "sam")
    expect(historyView().canUndo).toBe(false)
    expect(await undoLast()).toBeNull()
    setHistoryScope("p1", "sam")
    expect(historyView().canUndo).toBe(true)
  })

  it("the newer of the history and an Undo toast owns Cmd/Ctrl+Z", () => {
    expect(undoShortcutOwner()).toBeNull()
    setToastUndoAt(100)
    expect(undoShortcutOwner()).toBe("toast")
    recordStep(step("a", 200, []))
    expect(undoShortcutOwner()).toBe("history")
    setToastUndoAt(300)
    expect(undoShortcutOwner()).toBe("toast")
  })
})

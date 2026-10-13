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

  it("presses made while a slow step runs wait their turn instead of being dropped", async () => {
    const log: string[] = []
    let release: () => void = () => {}
    const slow: HistoryStep = {
      labelKey: "slow",
      at: 3,
      undo: () => new Promise((resolve) => { release = () => { log.push("undo slow"); resolve({ kind: "done" }) } }),
      redo: async () => { log.push("redo slow"); return { kind: "done" } },
    }
    recordStep(step("a", 1, log))
    recordStep(step("b", 2, log))
    recordStep(slow)
    const presses = [undoLast(), undoLast(), undoLast(), undoLast()]
    await new Promise((r) => setTimeout(r, 0))
    release()
    const results = await Promise.all(presses)
    expect(log).toEqual(["undo slow", "undo b", "undo a"])
    expect(results.map((r) => r?.step.labelKey ?? null)).toEqual(["slow", "b", "a", null])
    // Undo then Redo pressed together: the redo waits for the undo, then runs.
    await redoLast()
    const [u, r] = [undoLast(), redoLast()]
    expect((await u)?.step.labelKey).toBe("a")
    expect((await r)?.step.labelKey).toBe("a")
  })

  it("a press does nothing if the user moved to another project before its turn", async () => {
    const log: string[] = []
    let release: () => void = () => {}
    recordStep(step("b", 1, log))
    recordStep({
      labelKey: "slow", at: 2,
      undo: () => new Promise((resolve) => { release = () => resolve({ kind: "done" }) }),
      redo: async () => ({ kind: "done" }),
    })
    const first = undoLast()
    const second = undoLast()
    await new Promise((r) => setTimeout(r, 0))
    setHistoryScope("p2", "sam")
    release()
    expect((await first)?.step.labelKey).toBe("slow")
    expect(await second).toBeNull()
    expect(log).toEqual([])
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

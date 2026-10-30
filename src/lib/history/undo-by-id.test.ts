// AQU-2327, Q4 (Sam, Oct 30): the Station's Undo takes back the last change to
// its recording even when newer changes elsewhere sit above it; Redo then
// brings it back; ⌘Z (undoLast) is still the newest step.
import { beforeEach, describe, expect, it } from "vitest"
import {
  historyReady,
  historyView,
  newestMatchingStep,
  recordStep,
  redoLast,
  registerStepKinds,
  resetHistoryForTests,
  setHistoryScope,
  undoLast,
  undoStepById,
  type StepHandler,
} from "./history"
import { clearHistoryStoreForTests } from "./history-store"

const log: string[] = []
const kind = {
  undo: async (d: { name: string }) => (log.push(`undo ${d.name}`), { kind: "done" }),
  redo: async (d: { name: string }) => (log.push(`redo ${d.name}`), { kind: "done" }),
} as unknown as StepHandler<never>

beforeEach(async () => {
  resetHistoryForTests()
  await clearHistoryStoreForTests()
  log.length = 0
  registerStepKinds({ "test.log": kind })
  setHistoryScope("p1", "sam")
  await historyReady()
})

const rec = (name: string, cellId: string) => recordStep({ kind: "test.log", data: { name, cellId, audioId: "a" }, labelKey: "x", lane: null })

describe("undo one step by id", () => {
  it("takes back the recording's last change past a newer one elsewhere, and Redo brings it back", async () => {
    rec("station trim", "c1")
    rec("text edit", "c9")
    const mine = newestMatchingStep((_k, d) => (d as { cellId: string }).cellId === "c1")
    expect(mine).not.toBeNull()
    await undoStepById(mine!.id)
    expect(log).toEqual(["undo station trim"])
    // The newer change elsewhere is still the newest step: ⌘Z takes it.
    expect(historyView().nextUndo?.id).not.toBe(mine!.id)
    await redoLast()
    expect(log).toEqual(["undo station trim", "redo station trim"])
    await undoLast()
    expect(log.at(-1)).toBe("undo station trim")
  })
})

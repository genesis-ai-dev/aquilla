import { describe, it, expect, vi } from "vitest"
import { cellLabelStepHandlers, type CellLabelData, type CellLabelReading } from "./label-steps"

function harness(reading: CellLabelReading, writeOk = true) {
  const writeLabel = vi.fn(async () => writeOk)
  const handlers = cellLabelStepHandlers({ readLabel: () => reading, writeLabel })
  const step = handlers["cell.label"] as unknown as {
    undo(d: CellLabelData): Promise<{ kind: string; reason?: string }>
    redo(d: CellLabelData): Promise<{ kind: string; reason?: string }>
  }
  return { step, writeLabel }
}

const data: CellLabelData = { fileId: "f1", cellId: "c1", before: null, after: "Pericope" }

describe("cell.label history step (AQU-2408)", () => {
  it("undo writes the previous label back when the line still reads ours", async () => {
    const { step, writeLabel } = harness({ label: "Pericope" })
    expect(await step.undo(data)).toEqual({ kind: "done" })
    expect(writeLabel).toHaveBeenCalledWith("f1", "c1", null)
  })

  it("redo writes the new label when the line reads the old one", async () => {
    const { step, writeLabel } = harness({ label: null })
    expect(await step.redo(data)).toEqual({ kind: "done" })
    expect(writeLabel).toHaveBeenCalledWith("f1", "c1", "Pericope")
  })

  it("skips rather than overwriting a label somebody else set since", async () => {
    const { step, writeLabel } = harness({ label: "Someone else's" })
    expect(await step.undo(data)).toEqual({ kind: "skipped", reason: "changed" })
    expect(writeLabel).not.toHaveBeenCalled()
  })

  it("is done without writing when the line already reads what it would write", async () => {
    const { step, writeLabel } = harness({ label: null })
    expect(await step.undo(data)).toEqual({ kind: "done" })
    expect(writeLabel).not.toHaveBeenCalled()
  })

  it("reports a gone line and a closed file as the History panel expects", async () => {
    expect(await harness({ missing: "gone" }).step.undo(data)).toEqual({ kind: "skipped", reason: "gone" })
    expect(await harness({ missing: "elsewhere" }).step.redo(data)).toEqual({ kind: "blocked", reason: "elsewhere" })
  })

  it("fails when the write is refused", async () => {
    const { step } = harness({ label: "Pericope" }, false)
    expect((await step.undo(data)).kind).toBe("failed")
  })
})

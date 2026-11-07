/**
 * The history step for a cell's LABEL (AQU-2408) — the hand-typed note on a
 * line, written by `cell.label.set`. Metadata, never a character and never a
 * voice (docs/decisions/0007-cell-labels-are-metadata-never-cast.md).
 *
 * The event is non-chain-mutating, so undo and redo are plain writes: no head
 * to chain on, no stale sibling to fear. The guard is the label itself — if
 * the line no longer reads what this step left, somebody else changed it and
 * the step is skipped rather than overwriting them; if it already reads what
 * we would write, nothing is written. A label belongs to every language
 * (step-lane.ts), because it lives on the source side of the line.
 */
import { recordStep, type StepHandler, type StepOutcome } from "./history"

const DONE: StepOutcome = { kind: "done" }
const GONE: StepOutcome = { kind: "skipped", reason: "gone" }
const CHANGED: StepOutcome = { kind: "skipped", reason: "changed" }
const ELSEWHERE: StepOutcome = { kind: "blocked", reason: "elsewhere" }

export interface CellLabelData {
  fileId: string
  cellId: string
  before: string | null
  after: string | null
}

/** What a line's label reads now, or why it cannot be read. */
export type CellLabelReading =
  | { label: string | null }
  | { missing: "gone" | "elsewhere" }

export interface CellLabelStepContext {
  /** The label the line carries now, null for none; `elsewhere` when its file is not open. */
  readLabel(fileId: string, cellId: string): CellLabelReading
  /** Write the label (null clears). True once queued, false when refused. */
  writeLabel(fileId: string, cellId: string, label: string | null): Promise<boolean>
}

export function cellLabelStepHandlers(ctx: CellLabelStepContext): Record<string, StepHandler<never>> {
  const flip = async (d: CellLabelData, from: string | null, to: string | null): Promise<StepOutcome> => {
    const now = ctx.readLabel(d.fileId, d.cellId)
    if ("missing" in now) return now.missing === "gone" ? GONE : ELSEWHERE
    if (now.label === to) return DONE
    if (now.label !== from) return CHANGED
    const ok = await ctx.writeLabel(d.fileId, d.cellId, to)
    return ok ? DONE : { kind: "failed", error: new Error("cell.label.set refused") }
  }
  return {
    "cell.label": {
      undo: (d: CellLabelData) => flip(d, d.after, d.before),
      redo: (d: CellLabelData) => flip(d, d.before, d.after),
    } as StepHandler<never>,
  }
}

/**
 * Record one label change as it is written. `pending` is the write's own
 * promise (true once queued, false when refused), so an Undo pressed while it
 * is still saving undoes THIS change, and a refused write leaves no step.
 */
export function recordCellLabelStep(
  data: CellLabelData,
  fileName: string | null | undefined,
  pending: Promise<boolean>,
): void {
  if (data.before === data.after) return
  recordStep(
    {
      kind: "cell.label",
      data,
      labelKey: "editor.history.stepCellLabel",
      fileId: data.fileId,
      ...(fileName ? { fileName } : {}),
    },
    undefined,
    { pending },
  )
}

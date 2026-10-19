/**
 * History steps for rows: retime, hide/show, add, remove. (AQU-1767 phase 2)
 *
 * REMOVING A ROW IS THE HARD ONE. A removal destroys most of what hangs off a
 * cell, so its undo is a real event, `source.cell.restore`: the server copied
 * that state aside when the removal landed and puts it back — every lane's
 * translation, the votes, the takes, links and comments (see the sync-worker's
 * removed-cell-archive.ts). The row that pointed past the removed one is
 * pointed back at it, but only if nobody has moved it since.
 *
 * Adding a row is undone by removing it — but only while it is still the row
 * that was added: nobody has typed in it or translated it since. Redoing that
 * undo restores it, so its id never changes.
 */
import type { StepHandler, StepOutcome } from "./history"

const DONE: StepOutcome = { kind: "done" }
const GONE: StepOutcome = { kind: "skipped", reason: "gone" }
const CHANGED: StepOutcome = { kind: "skipped", reason: "changed" }

export interface RowTiming { startMs: number; endMs: number }

/** A row as the steps need to read it, or null when it is not there. */
export interface RowState {
  hidden: boolean
  /** Text rows: the row's own timing. Media rows: the subtitle span. */
  timing: RowTiming | null
  /** The row's place in the file: the row it follows (null = first). */
  anchorCellId: string | null
  /** Whether anyone has written in it beyond what was added (text, translation). */
  hasWork: boolean
}

export interface RowRetimeData { cellId: string; mode: "text" | "media"; before: RowTiming; after: RowTiming }
export interface RowHiddenData { cellId: string; hidden: boolean }
export interface RowAddData { cellId: string }
/** `successor` is the row that pointed at the removed one, and where the
 *  removal re-pointed it (`anchorAfter`, the removed row's predecessor). */
export interface RowRemoveData {
  cellId: string
  successor: { cellId: string; anchorAfter: string | null } | null
}

export interface RowStepContext {
  readRow(cellId: string): RowState | null
  retime(cellId: string, mode: "text" | "media", timing: RowTiming): Promise<void>
  setHidden(cellId: string, hidden: boolean): Promise<void>
  /** Remove a row (no confirmation — the user already confirmed once).
   *  Resolves false when it was refused, else the row the removal re-pointed. */
  remove(cellId: string): Promise<false | { successor: RowRemoveData["successor"] }>
  /** Undo the row's newest removal. Resolves false when the server refused. */
  restore(cellId: string): Promise<boolean>
  /** Point a row at a new predecessor (chained on its current head). */
  repoint(cellId: string, anchorCellId: string | null): Promise<void>
}

const sameTiming = (a: RowTiming | null, b: RowTiming) => a != null && a.startMs === b.startMs && a.endMs === b.endMs

export function rowStepHandlers(ctx: RowStepContext): Record<string, StepHandler<never>> {
  const retimeFlip = async (d: RowRetimeData, from: RowTiming, to: RowTiming): Promise<StepOutcome> => {
    const row = ctx.readRow(d.cellId)
    if (!row) return GONE
    if (!sameTiming(row.timing, from)) return CHANGED
    await ctx.retime(d.cellId, d.mode, to)
    return DONE
  }
  const hiddenFlip = async (d: RowHiddenData, from: boolean): Promise<StepOutcome> => {
    const row = ctx.readRow(d.cellId)
    if (!row) return GONE
    if (row.hidden !== from) return CHANGED
    await ctx.setHidden(d.cellId, !from)
    return DONE
  }
  const restoreRow = async (d: RowRemoveData | RowAddData): Promise<StepOutcome> => {
    if (ctx.readRow(d.cellId)) return CHANGED // somebody already brought it back
    if (!(await ctx.restore(d.cellId))) return GONE
    const succ = "successor" in d ? d.successor : null
    if (succ) {
      const s = ctx.readRow(succ.cellId)
      // Only if the successor still sits where the removal put it; otherwise
      // somebody has rearranged the rows since, and that arrangement wins.
      if (s && s.anchorCellId === succ.anchorAfter) await ctx.repoint(succ.cellId, d.cellId)
    }
    return DONE
  }

  return {
    "row.retime": {
      undo: (d: RowRetimeData) => retimeFlip(d, d.after, d.before),
      redo: (d: RowRetimeData) => retimeFlip(d, d.before, d.after),
    } as StepHandler<never>,
    "row.hidden": {
      undo: (d: RowHiddenData) => hiddenFlip(d, d.hidden),
      redo: (d: RowHiddenData) => hiddenFlip(d, !d.hidden),
    } as StepHandler<never>,
    "row.add": {
      async undo(d: RowAddData) {
        const row = ctx.readRow(d.cellId)
        if (!row) return GONE
        if (row.hasWork) return CHANGED
        return (await ctx.remove(d.cellId)) !== false ? DONE : GONE
      },
      redo: (d: RowAddData) => restoreRow(d),
    } as StepHandler<never>,
    "row.remove": {
      undo: (d: RowRemoveData) => restoreRow(d),
      async redo(d: RowRemoveData) {
        if (!ctx.readRow(d.cellId)) return GONE
        const removed = await ctx.remove(d.cellId)
        if (removed === false) return GONE
        d.successor = removed.successor
        return DONE
      },
    } as StepHandler<never>,
  }
}

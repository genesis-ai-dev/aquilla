/**
 * The phase-1 history steps for takes on the timeline: trim, move and cut.
 * (AQU-1767)
 *
 * Each builder takes the writes as plain functions (the workspace owns the
 * emitters, the optimistic overlays and the flush), so the undo/redo logic —
 * above all the "changed since?" guard — is testable without a component.
 */
import type { HistoryStep, StepOutcome } from "./history"
import type { CodexCellAttachment } from "@/lib/codex-editor/types"

type Window = { trimStartMs?: number; trimEndMs?: number }

const DONE: StepOutcome = { kind: "done" }
const GONE: StepOutcome = { kind: "skipped", reason: "gone" }
const CHANGED: StepOutcome = { kind: "skipped", reason: "changed" }

/**
 * Undo/redo of a trim window. `isAt(w)` reads the take NOW: true when it holds
 * window `w`, false when it holds something else, null when the take is gone.
 */
export function takeWindowStep(args: {
  labelKey: string
  at: number
  before: Window
  after: Window
  isAt(w: Window): boolean | null
  apply(w: Window): Promise<void>
}): HistoryStep {
  const flip = async (from: Window, to: Window): Promise<StepOutcome> => {
    const here = args.isAt(from)
    if (here == null) return GONE
    if (!here) return CHANGED
    await args.apply(to)
    return DONE
  }
  return {
    labelKey: args.labelKey,
    at: args.at,
    undo: () => flip(args.after, args.before),
    redo: () => flip(args.before, args.after),
  }
}

/** Undo/redo of a move. Offsets are ms from the line's start; null = never placed. */
export function takePlaceStep(args: {
  at: number
  before: number | null
  after: number | null
  isAt(offset: number | null): boolean | null
  apply(offset: number | null): Promise<void>
}): HistoryStep {
  const flip = async (from: number | null, to: number | null): Promise<StepOutcome> => {
    const here = args.isAt(from)
    if (here == null) return GONE
    if (!here) return CHANGED
    await args.apply(to)
    return DONE
  }
  return {
    labelKey: "editor.history.stepMove",
    at: args.at,
    undo: () => flip(args.after, args.before),
    redo: () => flip(args.before, args.after),
  }
}

/** One cut as it was made — enough to take it back and to make it again. */
export interface CutRecord {
  cellId: string
  /** The piece that was cut (it keeps the first half). */
  audioId: string
  atMs: number
  /** The second half's id. A redo mints a fresh one and stores it here. */
  newAudioId: string
  before: { trimEndMs: number | null; label: string | null; targetOffsetMs: number | null }
  /** Whether the cut renamed the first piece ("Take 3" → "Take 3 · 1"). */
  renamed: boolean
}

/**
 * Undo/redo of one or more cuts made by ONE action.
 *
 * Undo is allowed only while both halves are exactly as the cut left them —
 * the first ends at the cut, the second starts there, runs to the old end and
 * has not been moved. Anything else means someone has worked on the pieces
 * since, and joining them back would throw that work away; the cut is skipped.
 * Undo removes the second piece and gives the first its old end (and name)
 * back. Votes are NOT restored: the cut reset them, and putting back someone
 * else's vote would be casting it for them.
 *
 * Redo cuts again, with a fresh id for the second piece.
 */
export function cutStep(args: {
  at: number
  cuts: CutRecord[]
  readTake(cellId: string, audioId: string): CodexCellAttachment | null
  cut(c: CutRecord, newAudioId: string): Promise<boolean>
  uncut(c: CutRecord): Promise<void>
  newPieceId(c: CutRecord): string
}): HistoryStep {
  const intact = (c: CutRecord): boolean | null => {
    const first = args.readTake(c.cellId, c.audioId)
    const second = args.readTake(c.cellId, c.newAudioId)
    if (!first || !second) return null
    return (
      first.trimEndMs === c.atMs &&
      second.trimStartMs === c.atMs &&
      (second.trimEndMs ?? null) === c.before.trimEndMs &&
      (second.targetOffsetMs ?? null) === c.before.targetOffsetMs
    )
  }
  const uncutState = (c: CutRecord): boolean | null => {
    const first = args.readTake(c.cellId, c.audioId)
    if (!first) return null
    return (first.trimEndMs ?? null) === c.before.trimEndMs
  }
  return {
    labelKey: args.cuts.length === 1 ? "editor.history.stepCut" : "editor.history.stepCutMany",
    at: args.at,
    async undo() {
      const checks = args.cuts.map(intact)
      if (checks.some((x) => x == null)) return GONE
      if (checks.some((x) => !x)) return CHANGED
      for (const c of args.cuts) await args.uncut(c)
      return DONE
    },
    async redo() {
      const checks = args.cuts.map(uncutState)
      if (checks.some((x) => x == null)) return GONE
      if (checks.some((x) => !x)) return CHANGED
      for (const c of args.cuts) {
        const id = args.newPieceId(c)
        if (await args.cut(c, id)) c.newAudioId = id
      }
      return DONE
    },
  }
}

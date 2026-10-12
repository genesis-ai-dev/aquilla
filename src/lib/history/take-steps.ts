/**
 * History steps for takes: trim, move, cut, choose, delete, rename. (AQU-1767)
 *
 * The steps are data; this module turns them into undo/redo given the writes
 * as plain functions (the workspace owns the emitters, the optimistic overlays
 * and the flush). That keeps the logic — above all the "changed since?" guard —
 * testable without a component, and lets a step saved yesterday be undone
 * today by whatever workspace is open now.
 */
import type { StepHandler, StepOutcome } from "./history"
import type { CodexCellAttachment } from "@/lib/codex-editor/types"

export type TakeWindow = { trimStartMs?: number; trimEndMs?: number }

const DONE: StepOutcome = { kind: "done" }
const GONE: StepOutcome = { kind: "skipped", reason: "gone" }
const CHANGED: StepOutcome = { kind: "skipped", reason: "changed" }

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

export interface TakeWindowData { cellId: string; audioId: string; before: TakeWindow; after: TakeWindow }
export interface TakePlaceData { cellId: string; audioId: string; before: number | null; after: number | null }
export interface TakeCutData { cuts: CutRecord[] }
/** Choosing which take plays in a slot. `before` null = the slot was empty. */
export interface TakeSelectData { cellId: string; slot: string; before: string | null; after: string }
/** Deleting a take. Undo un-deletes it, and puts the slot's choice back. */
export interface TakeRemoveData { cellId: string; audioId: string; slot: string; wasSelected: boolean; selectedBefore: string | null }
export interface TakeRenameData { cellId: string; audioId: string; before: string | null; after: string | null }

export interface TakeStepContext {
  /** The take as it reads NOW (null when it is gone, or deleted). */
  readTake(cellId: string, audioId: string): CodexCellAttachment | null
  /** Which take plays in a slot right now (the group's first piece for a cut take). */
  selectedIn(cellId: string, slot: string): string | null
  applyTrim(cellId: string, audioId: string, w: TakeWindow): Promise<void>
  applyPlace(cellId: string, audioId: string, offset: number | null): Promise<void>
  /** Cut `c.audioId` at `c.atMs` into a new piece `newAudioId`. */
  cut(c: CutRecord, newAudioId: string): Promise<boolean>
  /** Join a cut back: remove the second piece, give the first its end (and name) back. */
  uncut(c: CutRecord): Promise<void>
  newPieceId(c: CutRecord): string
  /** Choose a take (null empties the slot). Choosing a deleted take un-deletes it. */
  select(cellId: string, slot: string, audioId: string | null): Promise<void>
  remove(cellId: string, audioId: string): Promise<void>
  rename(cellId: string, audioId: string, label: string | null): Promise<void>
}

const sameWindow = (att: CodexCellAttachment, w: TakeWindow) =>
  (att.trimStartMs ?? undefined) === w.trimStartMs && (att.trimEndMs ?? undefined) === w.trimEndMs

/** Every take step kind, bound to one workspace's writes. */
export function takeStepHandlers(ctx: TakeStepContext): Record<string, StepHandler<never>> {
  const windowFlip = async (d: TakeWindowData, from: TakeWindow, to: TakeWindow): Promise<StepOutcome> => {
    const att = ctx.readTake(d.cellId, d.audioId)
    if (!att) return GONE
    if (!sameWindow(att, from)) return CHANGED
    await ctx.applyTrim(d.cellId, d.audioId, to)
    return DONE
  }
  const placeFlip = async (d: TakePlaceData, from: number | null, to: number | null): Promise<StepOutcome> => {
    const att = ctx.readTake(d.cellId, d.audioId)
    if (!att) return GONE
    if ((att.targetOffsetMs ?? null) !== from) return CHANGED
    await ctx.applyPlace(d.cellId, d.audioId, to)
    return DONE
  }

  // A cut can be joined back only while both halves are exactly as the cut
  // left them — the first ends at the cut, the second starts there, runs to
  // the old end and has not been moved. Anything else means someone has worked
  // on the pieces since, and joining them would throw that work away. Votes
  // are NOT restored on undo: the cut reset them, and putting back someone
  // else's vote would be casting it for them.
  const intact = (c: CutRecord): boolean | null => {
    const first = ctx.readTake(c.cellId, c.audioId)
    const second = ctx.readTake(c.cellId, c.newAudioId)
    if (!first || !second) return null
    return (
      first.trimEndMs === c.atMs &&
      second.trimStartMs === c.atMs &&
      (second.trimEndMs ?? null) === c.before.trimEndMs &&
      (second.targetOffsetMs ?? null) === c.before.targetOffsetMs
    )
  }
  const whole = (c: CutRecord): boolean | null => {
    const first = ctx.readTake(c.cellId, c.audioId)
    if (!first) return null
    return (first.trimEndMs ?? null) === c.before.trimEndMs
  }

  const handlers: Record<string, StepHandler<never>> = {
    "take.window": {
      undo: (d: TakeWindowData) => windowFlip(d, d.after, d.before),
      redo: (d: TakeWindowData) => windowFlip(d, d.before, d.after),
    } as StepHandler<never>,
    "take.place": {
      undo: (d: TakePlaceData) => placeFlip(d, d.after, d.before),
      redo: (d: TakePlaceData) => placeFlip(d, d.before, d.after),
    } as StepHandler<never>,
    "take.cut": {
      async undo(d: TakeCutData) {
        const checks = d.cuts.map(intact)
        if (checks.some((x) => x == null)) return GONE
        if (checks.some((x) => !x)) return CHANGED
        for (const c of d.cuts) await ctx.uncut(c)
        return DONE
      },
      async redo(d: TakeCutData) {
        const checks = d.cuts.map(whole)
        if (checks.some((x) => x == null)) return GONE
        if (checks.some((x) => !x)) return CHANGED
        for (const c of d.cuts) {
          const id = ctx.newPieceId(c)
          if (await ctx.cut(c, id)) c.newAudioId = id
        }
        return DONE
      },
    } as StepHandler<never>,
    "take.select": {
      async undo(d: TakeSelectData) {
        if (ctx.selectedIn(d.cellId, d.slot) !== d.after) return CHANGED
        await ctx.select(d.cellId, d.slot, d.before)
        return DONE
      },
      async redo(d: TakeSelectData) {
        if (ctx.selectedIn(d.cellId, d.slot) !== d.before) return CHANGED
        if (!ctx.readTake(d.cellId, d.after)) return GONE
        await ctx.select(d.cellId, d.slot, d.after)
        return DONE
      },
    } as StepHandler<never>,
    "take.remove": {
      async undo(d: TakeRemoveData) {
        // Deleted takes are not sent to the browser, so "still deleted" is
        // "not live". Somebody who brought it back already wins.
        if (ctx.readTake(d.cellId, d.audioId)) return CHANGED
        // Choosing a deleted take is how it comes back (the projection
        // un-deletes on select). If it was not the one playing, give the slot
        // its previous choice back straight after.
        const playingNow = ctx.selectedIn(d.cellId, d.slot)
        await ctx.select(d.cellId, d.slot, d.audioId)
        if (!d.wasSelected) await ctx.select(d.cellId, d.slot, playingNow)
        return DONE
      },
      async redo(d: TakeRemoveData) {
        if (!ctx.readTake(d.cellId, d.audioId)) return GONE
        await ctx.remove(d.cellId, d.audioId)
        return DONE
      },
    } as StepHandler<never>,
    "take.rename": {
      async undo(d: TakeRenameData) {
        const att = ctx.readTake(d.cellId, d.audioId)
        if (!att) return GONE
        if ((att.label ?? null) !== d.after) return CHANGED
        await ctx.rename(d.cellId, d.audioId, d.before)
        return DONE
      },
      async redo(d: TakeRenameData) {
        const att = ctx.readTake(d.cellId, d.audioId)
        if (!att) return GONE
        if ((att.label ?? null) !== d.before) return CHANGED
        await ctx.rename(d.cellId, d.audioId, d.after)
        return DONE
      },
    } as StepHandler<never>,
  }
  return handlers
}

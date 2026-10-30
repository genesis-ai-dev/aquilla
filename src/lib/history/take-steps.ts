/**
 * History steps for takes: trim, move, cut, choose, delete, rename (AQU-1767),
 * and adding one — recording, uploading, generating, changing a voice,
 * removing noise (decision 11).
 *
 * The steps are data; this module turns them into undo/redo given the writes
 * as plain functions (the workspace owns the emitters, the optimistic overlays
 * and the flush). That keeps the logic — above all the "changed since?" guard —
 * testable without a component, and lets a step saved yesterday be undone
 * today by whatever workspace is open now.
 */
import { recordStep, type StepHandler, type StepOutcome } from "./history"
import type { CodexCellAttachment } from "@/lib/codex-editor/types"
import { clearTakeUndone, markTakeUndone } from "@/lib/audio/undone-takes"

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
  before: {
    trimEndMs: number | null
    label: string | null
    targetOffsetMs: number | null
    /** AQU-2267: absent on a cut recorded before it (read as null). */
    recordingsOffsetMs?: number | null
  }
  /** Whether the cut renamed the first piece ("Take 3" → "Take 3 · 1"). */
  renamed: boolean
}

export interface TakeWindowData { cellId: string; audioId: string; before: TakeWindow; after: TakeWindow }
/** AQU-2267: a take's place in each timing, as stored (null = not placed there). */
export interface StoredTakePlace { targetOffsetMs: number | null; recordingsOffsetMs: number | null }
/**
 * A move. `before`/`after` are its place following the source — and the only
 * place a step saved before AQU-2267 names. AQU-2267: `recordingsBefore` /
 * `recordingsAfter` are its place following the recordings, absent on such an
 * old step (read as null: the take had no place of its own there then).
 */
export interface TakePlaceData {
  cellId: string
  audioId: string
  before: number | null
  after: number | null
  recordingsBefore?: number | null
  recordingsAfter?: number | null
}
export interface TakeCutData { cuts: CutRecord[] }
/** Choosing which take plays in a slot. `before` null = the slot was empty;
 *  `after` null = the choice emptied it (a voice made to sound, decision 11). */
export interface TakeSelectData { cellId: string; slot: string; before: string | null; after: string | null }
/** Deleting a take. Undo un-deletes it, and puts the slot's choice back. */
export interface TakeRemoveData {
  cellId: string
  audioId: string
  slot: string
  wasSelected: boolean
  selectedBefore: string | null
  /** AQU-1767: the take's other pieces, deleted with it in the same step. */
  pieces?: string[]
}
export interface TakeRenameData { cellId: string; audioId: string; before: string | null; after: string | null }
/**
 * A take an action ADDED (decision 11): recorded, uploaded, generated, voice-
 * changed or cleaned. Every one of them lands as a new take that plays in its
 * slot. Undo takes it away again — gone, not parked (gap 26) — and gives the
 * slot back the take that played before; redo brings it back, playing.
 */
export interface TakeAddData {
  cellId: string
  audioId: string
  slot: string
  /** The take (a cut take's group) that played in the slot before; null = none. */
  selectedBefore: string | null
  /** Its other pieces, when the action added a cut take (cleaning a split take). */
  pieces?: string[]
  /** The window it was born with, when the action set one. */
  window?: TakeWindow
}

export interface TakeStepContext {
  /** The take as it reads NOW (null when it is gone, or deleted). */
  readTake(cellId: string, audioId: string): CodexCellAttachment | null
  /** Which take plays in a slot right now (the group's first piece for a cut take). */
  selectedIn(cellId: string, slot: string): string | null
  applyTrim(cellId: string, audioId: string, w: TakeWindow): Promise<void>
  /** AQU-2267: both places, in one write. */
  applyPlace(cellId: string, audioId: string, place: StoredTakePlace): Promise<void>
  /** Cut `c.audioId` at `c.atMs` into a new piece `newAudioId`. */
  cut(c: CutRecord, newAudioId: string): Promise<boolean>
  /** Join a cut back: remove the second piece, give the first its end (and name) back. */
  uncut(c: CutRecord): Promise<void>
  newPieceId(c: CutRecord): string
  /** Choose a take (null empties the slot). Choosing a deleted take un-deletes it. */
  select(cellId: string, slot: string, audioId: string | null): Promise<void>
  remove(cellId: string, audioId: string): Promise<void>
  rename(cellId: string, audioId: string, label: string | null): Promise<void>
  /** Someone other than you who has approved the take, or null (gap 25). */
  approvedByOthers?(cellId: string, audioId: string): string | null
  /** Every live take in the take's group (a cut take's pieces), itself included. */
  liveGroup?(cellId: string, audioId: string): string[]
  /** A line lost (or got back) a recording of its own: the workspace keeps the
   *  target row its recordings justify in step (onLastTakeRemoved / onTakeSaved). */
  takeRemoved?(cellId: string, removedIds: readonly string[]): void
  takeRestored?(cellId: string): void
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
  // AQU-2267: both places together — checked together (a move since, in
  // either timing, is someone else's change) and put back in one write.
  const placeFlip = async (d: TakePlaceData, from: StoredTakePlace, to: StoredTakePlace): Promise<StepOutcome> => {
    const att = ctx.readTake(d.cellId, d.audioId)
    if (!att) return GONE
    if ((att.targetOffsetMs ?? null) !== from.targetOffsetMs) return CHANGED
    if ((att.recordingsOffsetMs ?? null) !== from.recordingsOffsetMs) return CHANGED
    await ctx.applyPlace(d.cellId, d.audioId, to)
    return DONE
  }
  const placeBefore = (d: TakePlaceData): StoredTakePlace =>
    ({ targetOffsetMs: d.before, recordingsOffsetMs: d.recordingsBefore ?? null })
  const placeAfter = (d: TakePlaceData): StoredTakePlace =>
    ({ targetOffsetMs: d.after, recordingsOffsetMs: d.recordingsAfter ?? null })

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
      (second.targetOffsetMs ?? null) === c.before.targetOffsetMs &&
      (second.recordingsOffsetMs ?? null) === (c.before.recordingsOffsetMs ?? null)
    )
  }
  const whole = (c: CutRecord): boolean | null => {
    const first = ctx.readTake(c.cellId, c.audioId)
    if (!first) return null
    return (first.trimEndMs ?? null) === c.before.trimEndMs
  }

  const handlers: Record<string, StepHandler<never>> = {
    "take.add": {
      async undo(d: TakeAddData) {
        const ids = [d.audioId, ...(d.pieces ?? [])]
        const live = ids.filter((id) => ctx.readTake(d.cellId, id))
        if (live.length === 0) return GONE
        // Someone else's approval is a change: undoing would throw it away.
        for (const id of live) {
          const by = ctx.approvedByOthers?.(d.cellId, id)
          if (by) return { kind: "skipped", reason: "approved", by }
        }
        // Cut, trimmed or partly removed since: someone has worked on it.
        if (live.length !== ids.length) return CHANGED
        const group = ctx.liveGroup?.(d.cellId, d.audioId)
        if (group && group.some((id) => !ids.includes(id))) return CHANGED
        const first = ctx.readTake(d.cellId, d.audioId)
        if (d.window && first && !sameWindow(first, d.window)) return CHANGED
        const playingNow = ctx.selectedIn(d.cellId, d.slot)
        for (const id of ids) {
          markTakeUndone(id)
          await ctx.remove(d.cellId, id)
        }
        // The slot plays what it played before — unless someone has chosen
        // another take since, or that one is gone.
        const before = d.selectedBefore ? ctx.readTake(d.cellId, d.selectedBefore) : null
        if (playingNow === d.audioId && d.selectedBefore && before && (before.slot ?? d.slot) === d.slot) {
          await ctx.select(d.cellId, d.slot, d.selectedBefore)
        }
        ctx.takeRemoved?.(d.cellId, ids)
        return DONE
      },
      async redo(d: TakeAddData) {
        const ids = [d.audioId, ...(d.pieces ?? [])]
        // Somebody brought it back already.
        if (ids.some((id) => ctx.readTake(d.cellId, id))) return CHANGED
        // Choosing a removed take is how it comes back, playing, as the action
        // left it (a cut take's pieces are chosen one by one).
        for (const id of ids) {
          clearTakeUndone(id)
          await ctx.select(d.cellId, d.slot, id)
        }
        ctx.takeRestored?.(d.cellId)
        return DONE
      },
    } as StepHandler<never>,
    "take.window": {
      undo: (d: TakeWindowData) => windowFlip(d, d.after, d.before),
      redo: (d: TakeWindowData) => windowFlip(d, d.before, d.after),
    } as StepHandler<never>,
    "take.place": {
      undo: (d: TakePlaceData) => placeFlip(d, placeAfter(d), placeBefore(d)),
      redo: (d: TakePlaceData) => placeFlip(d, placeBefore(d), placeAfter(d)),
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
        if (d.after && !ctx.readTake(d.cellId, d.after)) return GONE
        await ctx.select(d.cellId, d.slot, d.after)
        return DONE
      },
    } as StepHandler<never>,
    "take.remove": {
      async undo(d: TakeRemoveData) {
        // Deleted takes are not sent to the browser, so "still deleted" is
        // "not live". Somebody who brought it back already wins.
        const ids = [d.audioId, ...(d.pieces ?? [])]
        if (ids.some((id) => ctx.readTake(d.cellId, id))) return CHANGED
        // Choosing a deleted take is how it comes back (the projection
        // un-deletes on select) — and only the piece named, so a split take's
        // pieces are chosen one by one. If it was not the one playing, give the
        // slot its previous choice back straight after.
        const playingNow = ctx.selectedIn(d.cellId, d.slot)
        for (const id of ids) await ctx.select(d.cellId, d.slot, id)
        if (!d.wasSelected) await ctx.select(d.cellId, d.slot, playingNow)
        return DONE
      },
      async redo(d: TakeRemoveData) {
        const live = [d.audioId, ...(d.pieces ?? [])].filter((id) => ctx.readTake(d.cellId, id))
        if (live.length === 0) return GONE
        for (const id of live) await ctx.remove(d.cellId, id)
        return DONE
      },
    } as StepHandler<never>,
    // A name is set, not changed by a delta, and renames are sent in order:
    // so the name the step is going BACK to is as good as the one it left
    // (that read just hasn't caught up with the rename yet — a Cmd+Z right
    // after Enter was skipped as "changed since", slow-network pass
    // 2026-10-13). Any third name is someone else's change.
    "take.rename": {
      async undo(d: TakeRenameData) {
        const att = ctx.readTake(d.cellId, d.audioId)
        if (!att) return GONE
        const label = att.label ?? null
        if (label !== d.after && label !== d.before) return CHANGED
        await ctx.rename(d.cellId, d.audioId, d.before)
        return DONE
      },
      async redo(d: TakeRenameData) {
        const att = ctx.readTake(d.cellId, d.audioId)
        if (!att) return GONE
        const label = att.label ?? null
        if (label !== d.before && label !== d.after) return CHANGED
        await ctx.rename(d.cellId, d.audioId, d.after)
        return DONE
      },
    } as StepHandler<never>,
  }
  return handlers
}

/** What a cell's audio says about which take plays where. */
interface SlotChoices {
  selectedBySlot?: Record<string, string> | null
  selectedAudioId?: string | null
  selectedGeneratedVoiceAudioId?: string | null
  attachments?: Record<string, { pieceOf?: string | null } | undefined> | null
}

/** The take (a cut take's group) playing in `slot` right now, for a step's `selectedBefore`. */
export function playingInSlot(choices: SlotChoices | null | undefined, slot: string): string | null {
  if (!choices) return null
  const bySlot = choices.selectedBySlot ?? {
    ...(choices.selectedAudioId ? { recording: choices.selectedAudioId } : {}),
    ...(choices.selectedGeneratedVoiceAudioId ? { generatedVoice: choices.selectedGeneratedVoiceAudioId } : {}),
  }
  const id = bySlot[slot]
  if (!id) return null
  return choices.attachments?.[id]?.pieceOf ?? id
}

/** The step names for the ways a take is added. */
export const TAKE_ADD_LABELS = {
  record: "editor.history.stepRecordTake",
  upload: "editor.history.stepUploadTake",
  generate: "editor.history.stepGenerateVoice",
  changeVoice: "editor.history.stepChangeVoice",
  denoise: "editor.history.stepRemoveNoise",
} as const

/**
 * Record that an action added a take (decision 11). Called by each action
 * once its attach is queued; `fileId` is the file the CELL lives in (a heard
 * line's take is the cue sibling's).
 */
export function recordTakeAdded(
  how: keyof typeof TAKE_ADD_LABELS,
  data: TakeAddData,
  where: { fileId: string; fileName?: string | null },
): void {
  recordStep<TakeAddData>({
    kind: "take.add",
    data,
    labelKey: TAKE_ADD_LABELS[how],
    fileId: where.fileId,
    ...(where.fileName ? { fileName: where.fileName } : {}),
  })
}

/**
 * Record that an action changed which take plays in a slot as a side effect
 * (making a new voice the one that sounds empties the recording slot). Meant
 * for inside a `withGroup` with the action's own step, so one Undo puts both
 * back.
 */
export function recordSlotChoice(data: TakeSelectData, where: { fileId: string }): void {
  if (data.before === data.after) return
  recordStep<TakeSelectData>({ kind: "take.select", data, labelKey: "editor.history.stepChooseTake", fileId: where.fileId })
}

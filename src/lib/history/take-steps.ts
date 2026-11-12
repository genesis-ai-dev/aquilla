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
import { completeStep, historyView, matchingSteps, recordStep, type StepHandler, type StepOutcome } from "./history"
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
  /**
   * The second half's id. AQU-2492: a Redo names it again, and the server
   * brings that piece back as the Undo left it, approvals and all (a step
   * redone before AQU-2492 stored the fresh id it minted here).
   */
  newAudioId: string
  before: {
    trimEndMs: number | null
    label: string | null
    targetOffsetMs: number | null
    /** AQU-2267: absent on a cut recorded before it (read as null). */
    recordingsOffsetMs?: number | null
    /** AQU-2492: who had approved the take when it was cut. Absent on a cut
     *  recorded before AQU-2492. */
    validators?: string[]
    /**
     * AQU-2492 (review, Nov 9), finding 7: the take's volume and fades before
     * the cut. The server keeps them with the cut and gives them back to the
     * joined take on Undo; the Redo is skipped once the joined take's level
     * changed since. Absent on a cut recorded before it: no level is checked.
     * (The same field, and meaning, as AQU-2494's.)
     */
    level?: TakeLevel
  }
  /** Whether the cut renamed the first piece ("Take 3" → "Take 3 · 1"). */
  renamed: boolean
  /**
   * AQU-2492: who had approved each piece when the cut was undone, noted by
   * the Undo, so the Redo paints them at once. The approvals themselves are
   * kept by the server (`cell.audio.uncut`), which the Redo gives back.
   */
  pieceVoters?: { first: string[]; second: string[] }
}

export interface TakeWindowData { cellId: string; audioId: string; before: TakeWindow; after: TakeWindow }
/** AQU-2327: a take's volume (dB) and fades (ms), as stored (null = none). */
export interface TakeLevel { gainDb: number | null; fadeInMs: number | null; fadeOutMs: number | null }
/** A change to a take's volume or fades (the Station's volume line and corners). */
export interface TakeGainData { cellId: string; audioId: string; before: TakeLevel; after: TakeLevel }
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
  /**
   * AQU-2492 (review, Nov 9), finding 8: who had approved the take, and each
   * piece, when it was deleted (by audio id). A deleted take keeps its
   * approvals and the Undo gives them back with it, so only an approval given
   * since stops the Redo. Absent on a delete recorded before it: no check.
   */
  approvedBy?: Record<string, string[]>
  /**
   * AQU-2492 (review, Nov 9), finding 4: the take that replaced it in the
   * same step (the Station's Save over it). The Undo never hands the slot
   * back to that one: the same step's Undo takes it away, and handing it back
   * left the line playing nothing whenever the app had not read the old take
   * back yet.
   */
  replacedBy?: string
  /**
   * AQU-2492 (review, Nov 12): where each deleted piece sat in its take's
   * recording, by audio id. The browser is never sent a deleted take, so the
   * Undo reads it from here to keep a piece from coming back over a stretch
   * another piece of its take plays now (`PieceStretch`). Absent on a delete
   * recorded before it: no check.
   */
  stretches?: Record<string, PieceStretch>
}
/**
 * AQU-2492 (review, Nov 12): the stretch of a recording a piece of a take
 * plays — `url`, the recording; its kept part there, ms (`endMs` null runs to
 * the recording's end) — and the take it is a piece of (its first piece's id).
 *
 * Review, round 2: only stretches of ONE recording can double. A piece the
 * Station saved is a part of a new, edited recording, whose clock may differ
 * from the original's (audio deleted or inserted before or inside it), so it
 * is never weighed by its own numbers against the original's: it stands for
 * the stretch of the piece it was made from (`referenceAudioId`) whenever
 * that is known, and otherwise against nothing.
 */
export interface PieceStretch { pieceOf: string; url: string | null; startMs: number; endMs: number | null }
export function pieceStretchOf(
  audioId: string,
  att: { url?: string | null; pieceOf?: string | null; trimStartMs?: number | null; trimEndMs?: number | null; durationMs?: number | null },
): PieceStretch {
  return { pieceOf: att.pieceOf ?? audioId, url: att.url ?? null, startMs: att.trimStartMs ?? 0, endMs: att.trimEndMs ?? att.durationMs ?? null }
}
/**
 * The stretch a piece the Station saved stands for, as its Save noted it
 * (`TakeAddData.stretches`) in this person's History; undefined when the
 * History no longer holds that Save. A delete of such a piece can note only
 * the piece's own numbers, on its own recording, since the piece it was made
 * from is never sent to the browser again.
 */
function savedStandIn(audioId: string): PieceStretch | undefined {
  let found: PieceStretch | undefined
  matchingSteps((kind, data) => {
    if (!found && kind === "take.add") found = (data as TakeAddData).stretches?.[audioId]
    return false
  })
  return found
}
/** Two stretches of one recording share more than the rounding a cut leaves
 *  at its seam. */
const SEAM_MS = 2
const sharesStretch = (a: PieceStretch, b: PieceStretch) =>
  a.url === b.url && Math.min(a.endMs ?? Infinity, b.endMs ?? Infinity) - Math.max(a.startMs, b.startMs) > SEAM_MS
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
  /**
   * AQU-2492 (review, round 2): a piece the Station saved over another piece
   * of a cut take: `replaces`, the piece it replaced in the same step (its
   * Redo takes that one away again), and `stretches`, the stretch the new
   * piece stands for — the replaced piece's, in its recording. Its Redo is
   * then held to the same rule as every step that brings a piece back.
   */
  replaces?: string
  stretches?: Record<string, PieceStretch>
  /** The window it was born with, when the action set one. */
  window?: TakeWindow
}

export interface TakeStepContext {
  /** The take as it reads NOW (null when it is gone, or deleted). */
  readTake(cellId: string, audioId: string): CodexCellAttachment | null
  /** Which take plays in a slot right now (the group's first piece for a cut take). */
  selectedIn(cellId: string, slot: string): string | null
  applyTrim(cellId: string, audioId: string, w: TakeWindow): Promise<void>
  /** AQU-2327: a take's volume and fades, all three in one write. */
  applyGain?(cellId: string, audioId: string, level: TakeLevel): Promise<void>
  /** AQU-2267: both places, in one write. */
  applyPlace(cellId: string, audioId: string, place: StoredTakePlace): Promise<void>
  /** Cut `c.audioId` at `c.atMs` into a piece `newAudioId` (AQU-2492: on a
   *  Redo, the piece the Undo removed, which comes back as it was). */
  cut(c: CutRecord, newAudioId: string): Promise<boolean>
  /** Join a cut back: remove the second piece, give the first its end (and
   *  name) back, and (AQU-2492) the take its approvals from before the cut. */
  uncut(c: CutRecord): Promise<void>
  /** Choose a take (null empties the slot). Choosing a deleted take un-deletes it. */
  select(cellId: string, slot: string, audioId: string | null): Promise<void>
  remove(cellId: string, audioId: string): Promise<void>
  rename(cellId: string, audioId: string, label: string | null): Promise<void>
  /** Someone other than you who has approved the take, or null (gap 25).
   *  AQU-2492: `except` names approvals that do not count as new. */
  approvedByOthers?(cellId: string, audioId: string, except?: readonly string[]): string | null
  /** Every live take in the take's group (a cut take's pieces), itself included. */
  liveGroup?(cellId: string, audioId: string): string[]
  /**
   * AQU-2492 (review, Nov 9), finding 9: a deleted take this tab chose again
   * (which brings it back) that the app's copy does not list yet. It counts
   * as live: two quick Undos — the first bringing a take back — must not
   * throw the second away as "gone".
   */
  broughtBack?(cellId: string, audioId: string): boolean
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
  // AQU-2327: the level together — a change since, to any of the three, is
  // someone else's, and the step leaves it alone.
  const gainFlip = async (d: TakeGainData, from: TakeLevel, to: TakeLevel): Promise<StepOutcome> => {
    const att = ctx.readTake(d.cellId, d.audioId)
    if (!att) return GONE
    if (!ctx.applyGain) return { kind: "skipped", reason: "unavailable" }
    if ((att.gainDb ?? null) !== from.gainDb || (att.fadeInMs ?? null) !== from.fadeInMs || (att.fadeOutMs ?? null) !== from.fadeOutMs) return CHANGED
    await ctx.applyGain(d.cellId, d.audioId, to)
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
  // on the pieces since, and joining them would throw that work away.
  // AQU-2492 (review, Nov 9; Sam's call the same day): approvals never stop
  // it. "I would like an approved cut to still be undoable. We just need to
  // remember the approval for if the cut is redone." The server keeps them:
  // the Undo gives the take back the approvals it had before the cut and keeps
  // the pieces' approvals, and the Redo gives those back — the voters' own,
  // as they were, never cast for them.
  // AQU-2492 (Sam, Nov 11): a second half deleted since, by anyone, never
  // stops it. The Undo did the same thing or nothing depending on whether this
  // page had heard of a colleague's delete yet (Safari's engine usually had,
  // Chrome's not yet). The server's undo joins the take on what is left and
  // gives back the whole take's approvals either way, so the cut is undone
  // whenever the take it was made on is still there as the cut left it (and,
  // as for every step that joins or brings back a piece, `doublesUp` below:
  // no other piece of the take plays part of what the join gives back).
  const intact = (c: CutRecord): boolean | null => {
    const first = ctx.readTake(c.cellId, c.audioId)
    if (!first) return null
    const second = ctx.readTake(c.cellId, c.newAudioId)
    return (
      first.trimEndMs === c.atMs &&
      (second == null || (
        second.trimStartMs === c.atMs &&
        (second.trimEndMs ?? null) === c.before.trimEndMs &&
        (second.targetOffsetMs ?? null) === c.before.targetOffsetMs &&
        (second.recordingsOffsetMs ?? null) === (c.before.recordingsOffsetMs ?? null)
      )) &&
      levelsIntact(c, first, second)
    )
  }
  // AQU-2492 (review, Nov 9), finding 7: …and each still has the volume and
  // fades the cut left it — the first piece the take's, the second none (this
  // server's cut gives it no level). A level changed on either since is work
  // the join would throw away: the server gives the joined take the level it
  // had before the cut.
  const sameLevel = (att: CodexCellAttachment, l: TakeLevel) =>
    (att.gainDb ?? null) === l.gainDb && (att.fadeInMs ?? null) === l.fadeInMs && (att.fadeOutMs ?? null) === l.fadeOutMs
  const levelsIntact = (c: CutRecord, first: CodexCellAttachment, second: CodexCellAttachment | null): boolean => {
    if (!c.before.level) return true
    return sameLevel(first, c.before.level) && (second == null || sameLevel(second, { gainDb: null, fadeInMs: null, fadeOutMs: null }))
  }
  const whole = (c: CutRecord): boolean | null => {
    const first = ctx.readTake(c.cellId, c.audioId)
    if (!first) return null
    // Finding 7: the joined take's level changed since the Undo gave it back:
    // cutting it again would bring the second piece back at the old level.
    if (c.before.level && !sameLevel(first, c.before.level)) return false
    return (first.trimEndMs ?? null) === c.before.trimEndMs
  }

  // AQU-2492 (review, Nov 9): the take to CHOOSE when a step goes back to
  // `id`. A take is named by its first piece, and a cut take whose first piece
  // was deleted is still a take: any piece that is left chooses it (the whole
  // group plays; a removed piece stays removed). Null when nothing of it is
  // left. A step never chooses a deleted take: that is how the server brings
  // one back, and it would silently reverse whoever deleted it.
  const liveOf = (cellId: string, id: string): string | null => {
    // Finding 9: …or one this tab just brought back, not read back yet.
    if (ctx.readTake(cellId, id) || ctx.broughtBack?.(cellId, id)) return id
    return (ctx.liveGroup?.(cellId, id) ?? []).find((piece) => ctx.readTake(cellId, piece)) ?? null
  }

  // AQU-2492 (review, Nov 12): ONE RULE for the steps that join a cut take,
  // cut it again or bring a deleted piece back: an Undo or Redo never leaves
  // two pieces of one take over the same stretch of its recording, which
  // would play twice. `after` is what the step will leave — a piece's stretch,
  // or null for a piece it removes — and every other live piece of the take
  // stays as it reads now. A step that would break it is skipped as changed.
  // `known`: stretches the step knows of pieces the browser no longer has
  // (a cut's second half, a deleted piece), for a live piece the Station made
  // from one of them to stand for.
  const doublesUp = (
    cellId: string,
    take: string,
    after: ReadonlyMap<string, PieceStretch | null>,
    known: ReadonlyMap<string, PieceStretch> = new Map(),
  ): boolean => {
    const changed = [...after.values()].filter((x): x is PieceStretch => x != null)
    const live = (ctx.liveGroup?.(cellId, take) ?? []).filter((id) => !after.has(id))
      .map((id) => [id, ctx.readTake(cellId, id)] as const)
      .filter((x): x is readonly [string, CodexCellAttachment] => x[1] != null)
    const own = new Map<string, PieceStretch>([...known, ...live.map(([id, att]) => [id, pieceStretchOf(id, att)] as const)])
    for (const [id, x] of after) if (x) own.set(id, x)
    const others = live.map(([id, att]) => {
      const from = att.referenceAudioId ? own.get(att.referenceAudioId) : undefined
      return from && from.url !== (att.url ?? null) ? from : (own.get(id) as PieceStretch)
    })
    return changed.some((x, i) => [...changed.slice(i + 1), ...others].some((y) => sharesStretch(x, y)))
  }
  // A step that brings pieces back as they were noted (a delete's Undo, a
  // Station Save's Redo); `gone`, the piece the same step takes away.
  const bringsBackDouble = (cellId: string, ids: readonly string[], notes: Record<string, PieceStretch> | undefined, gone?: string) => {
    // A piece the Station saved comes back as the stretch it stands for.
    const noted = notes && Object.fromEntries(Object.entries(notes).map(([id, x]) => [id, savedStandIn(id) ?? x]))
    const returning = new Map<string, PieceStretch | null>()
    for (const id of ids) if (noted?.[id]) returning.set(id, noted[id])
    if (gone) returning.set(gone, null)
    const takeOf = ids.map((id) => noted?.[id]?.pieceOf).find(Boolean)
    return takeOf != null && doublesUp(cellId, takeOf, returning, new Map(Object.entries(noted ?? {})))
  }
  // What a cut's Undo leaves (the first piece whole again, the second gone)
  // and its Redo (both halves, as the cut made them).
  const halves = (c: CutRecord, first: CodexCellAttachment) => {
    const at = { pieceOf: first.pieceOf ?? c.audioId, url: first.url ?? null }
    return {
      whole: { ...at, startMs: first.trimStartMs ?? 0, endMs: c.before.trimEndMs ?? first.durationMs ?? null },
      first: { ...at, startMs: first.trimStartMs ?? 0, endMs: c.atMs },
      second: { ...at, startMs: c.atMs, endMs: c.before.trimEndMs ?? first.durationMs ?? null },
    }
  }
  const joined = (c: CutRecord, first: CodexCellAttachment) =>
    new Map<string, PieceStretch | null>([[c.audioId, halves(c, first).whole], [c.newAudioId, null]])
  const cutAgain = (c: CutRecord, first: CodexCellAttachment) =>
    new Map<string, PieceStretch | null>([[c.audioId, halves(c, first).first], [c.newAudioId, halves(c, first).second]])
  // The cut's second half as the cut made it, for a piece the Station made
  // from it to stand for.
  const secondHalf = (c: CutRecord, first: CodexCellAttachment) => new Map([[c.newAudioId, halves(c, first).second]])
  const firstOf = (c: CutRecord) => ctx.readTake(c.cellId, c.audioId) as CodexCellAttachment

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
        // AQU-2492: a cut take that played before is chosen by a piece that
        // is left, when its first piece has been deleted since.
        const beforeId = d.selectedBefore ? liveOf(d.cellId, d.selectedBefore) : null
        const before = beforeId ? ctx.readTake(d.cellId, beforeId) : null
        if (playingNow === d.audioId && beforeId && before && (before.slot ?? d.slot) === d.slot) {
          await ctx.select(d.cellId, d.slot, beforeId)
        }
        ctx.takeRemoved?.(d.cellId, ids)
        return DONE
      },
      async redo(d: TakeAddData) {
        const ids = [d.audioId, ...(d.pieces ?? [])]
        // Somebody brought it back already.
        if (ids.some((id) => ctx.readTake(d.cellId, id))) return CHANGED
        // AQU-2492 (review, round 2): a piece the Station saved never comes
        // back over a stretch another piece of its take plays now; the piece
        // it replaced goes again in this same step.
        if (bringsBackDouble(d.cellId, ids, d.stretches, d.replaces)) return CHANGED
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
    "take.gain": {
      undo: (d: TakeGainData) => gainFlip(d, d.after, d.before),
      redo: (d: TakeGainData) => gainFlip(d, d.before, d.after),
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
        // Another piece of the take plays part of what the join would give
        // back: a colleague cut the second half again, or saved it in the
        // Station.
        if (d.cuts.some((c) => doublesUp(c.cellId, c.audioId, joined(c, firstOf(c)), secondHalf(c, firstOf(c))))) return CHANGED
        for (const c of d.cuts) {
          // AQU-2492: who approved each piece now, noted with the step (it is
          // saved after this runs, so it lasts a reload) for the Redo.
          c.pieceVoters = {
            first: [...(ctx.readTake(c.cellId, c.audioId)?.validators ?? [])],
            second: [...(ctx.readTake(c.cellId, c.newAudioId)?.validators ?? [])],
          }
          await ctx.uncut(c)
        }
        return DONE
      },
      async redo(d: TakeCutData) {
        const checks = d.cuts.map(whole)
        if (checks.some((x) => x == null)) return GONE
        if (checks.some((x) => !x)) return CHANGED
        // AQU-2492: the piece the Undo removed was brought back since, by
        // someone: the take is no longer as the Undo left it.
        if (d.cuts.some((c) => ctx.readTake(c.cellId, c.newAudioId))) return CHANGED
        // …or another piece of the take plays part of what the cut would
        // bring back: the cut would land on nothing.
        if (d.cuts.some((c) => doublesUp(c.cellId, c.audioId, cutAgain(c, firstOf(c)), secondHalf(c, firstOf(c))))) return CHANGED
        // AQU-2492 (review, Nov 9): someone else approved the joined take
        // after the Undo. Cutting it again would take their approval off it,
        // the same rule as redoing a delete. The approvals the take had before
        // the cut are not new: the Undo gave those back.
        for (const c of d.cuts) {
          if (!c.before.validators) continue
          const by = ctx.approvedByOthers?.(c.cellId, c.audioId, c.before.validators)
          if (by) return { kind: "skipped", reason: "approved", by }
        }
        // AQU-2492: the piece the Undo removed is named again, and comes back
        // as it was, with its approvals; the first piece gets back the
        // approvals it had at the Undo. A cut by hand mints a new piece. The
        // take's approvals now are what the next Undo gives back.
        for (const c of d.cuts) {
          c.before.validators = [...(ctx.readTake(c.cellId, c.audioId)?.validators ?? [])]
          await ctx.cut(c, c.newAudioId)
        }
        return DONE
      },
    } as StepHandler<never>,
    "take.select": {
      async undo(d: TakeSelectData) {
        if (ctx.selectedIn(d.cellId, d.slot) !== d.after) return CHANGED
        // AQU-2492: the take to go back to was deleted since (by anyone).
        // Choosing it would bring it back, so the step is left alone.
        const back = d.before ? liveOf(d.cellId, d.before) : null
        if (d.before && !back) return GONE
        await ctx.select(d.cellId, d.slot, back)
        return DONE
      },
      async redo(d: TakeSelectData) {
        if (ctx.selectedIn(d.cellId, d.slot) !== d.before) return CHANGED
        const again = d.after ? liveOf(d.cellId, d.after) : null
        if (d.after && !again) return GONE
        await ctx.select(d.cellId, d.slot, again)
        return DONE
      },
    } as StepHandler<never>,
    "take.remove": {
      async undo(d: TakeRemoveData) {
        // Deleted takes are not sent to the browser, so "still deleted" is
        // "not live". Somebody who brought it back already wins.
        const ids = [d.audioId, ...(d.pieces ?? [])]
        if (ids.some((id) => ctx.readTake(d.cellId, id))) return CHANGED
        // AQU-2492 (review, Nov 12): a piece never comes back over a stretch
        // another piece of its take plays now (the take was joined since).
        // The take that replaced it in this same step goes with this Undo.
        if (bringsBackDouble(d.cellId, ids, d.stretches, d.replacedBy)) return CHANGED
        // Choosing a deleted take is how it comes back (the projection
        // un-deletes on select) — and only the piece named, so a split take's
        // pieces are chosen one by one. If it was not the one playing, give the
        // slot its previous choice back straight after.
        const playingNow = ctx.selectedIn(d.cellId, d.slot)
        for (const id of ids) await ctx.select(d.cellId, d.slot, id)
        // AQU-2492 (review, Nov 9): undoing a delete brings the take BACK. It
        // plays again only if it was the one playing and the slot is still
        // empty, as the delete left it. A take chosen or recorded since (by
        // anyone) keeps the slot; so does the rest of a cut take whose piece
        // this was. The slot is handed back by a take that is live, never by
        // naming a deleted first piece (choosing it would bring it back).
        if (d.wasSelected && playingNow === null) return DONE
        // Finding 4: nor to the take that replaced it in this step.
        if (d.wasSelected && d.replacedBy && playingNow === d.replacedBy) return DONE
        const back = playingNow === null ? null : liveOf(d.cellId, playingNow)
        if (playingNow === null || back) await ctx.select(d.cellId, d.slot, back)
        return DONE
      },
      async redo(d: TakeRemoveData) {
        const live = [d.audioId, ...(d.pieces ?? [])].filter((id) => ctx.readTake(d.cellId, id))
        if (live.length === 0) return GONE
        // AQU-2492 (review, Nov 9): someone else approved it after the Undo
        // brought it back. Deleting it again would throw their approval away,
        // the same rule as undoing a new take (gap 25). Finding 8: the
        // approvals it had when it was deleted came back with it and are not
        // new (as the cut's Redo); a delete recorded before they were noted
        // redoes as it did then.
        if (d.approvedBy) {
          for (const id of live) {
            const by = ctx.approvedByOthers?.(d.cellId, id, d.approvedBy[id] ?? [])
            if (by) return { kind: "skipped", reason: "approved", by }
          }
        }
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
  // AQU-2327: the Station saved an edited recording as a new version.
  station: "editor.history.stepStationVersion",
  // AQU-2492 (review, Nov 9): "Join into one recording" adds the joined take.
  join: "editor.history.stepJoinTake",
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
  /** AQU-2492 (review, Nov 9): recorded as the action starts, waiting on it
   *  (`recordStep`'s `pending`). */
  opts?: { pending?: Promise<boolean> },
): void {
  recordStep<TakeAddData>({
    kind: "take.add",
    data,
    labelKey: TAKE_ADD_LABELS[how],
    fileId: where.fileId,
    ...(where.fileName ? { fileName: where.fileName } : {}),
  }, undefined, opts)
}

/**
 * AQU-2492 (review, Nov 9), finding 14: how close together two changes to one
 * take's window must be to count as one gesture. Comfortably over a held
 * key's first repeat delay and a steady run of presses.
 */
export const TRIM_RUN_MS = 1000

let trimRun: { key: string; id: string; at: number } | null = null

/**
 * Record a change to a take's window (its trim) — but a run of them on one
 * take, each within {@link TRIM_RUN_MS} of the last and still the newest
 * step, is ONE step, from where the run began to where it ended, as a
 * timeline drag is. Holding an arrow key on a trim line saves on every key
 * repeat, and a step per repeat pushed most older steps out of the history.
 */
export function recordTakeWindowRun(data: TakeWindowData, where: { fileId: string }, now = Date.now()): void {
  const key = `${where.fileId}\u0000${data.cellId}\u0000${data.audioId}`
  const run = trimRun
  if (run && run.key === key && now - run.at <= TRIM_RUN_MS && historyView().nextUndo?.id === run.id) {
    completeStep(run.id, (d) => ({ ...(d as TakeWindowData), after: data.after }))
    run.at = now
    return
  }
  const id = recordStep<TakeWindowData>({ kind: "take.window", data, labelKey: "editor.history.stepTrim", fileId: where.fileId })
  trimRun = id ? { key, id, at: now } : null
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

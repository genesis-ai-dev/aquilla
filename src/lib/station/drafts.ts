// Unsaved sound edits, per recording (AQU-2327, Q5). Deletes and inserts are
// only a list of operations until "Save as new version", so they are kept in
// this browser — through switching recordings and a reload — until saved or
// undone. The bytes of an inserted file go to the audio bytes cache under an
// id of their own; a take inserted is named by its stored object.

import { shiftTime, type EditOp } from "./edit-list"

/** Where an inserted operation's audio comes from, to load it again. */
export type DraftSource =
  | { kind: "take"; url: string; fileId: string; label: string }
  | { kind: "file"; cacheId: string; ext: string; label: string }
  | { kind: "recording"; cacheId: string; ext: string; label: string }

export interface StationDraft {
  ops: EditOp[]
  /** The kept part while sound edits are unsaved, in the edited recording's
   *  seconds; null = the stored trim carried through the edits. */
  trim: { a: number; b: number } | null
  sources: Record<string, DraftSource>
  /**
   * AQU-2493 (review, Nov 9): how far the edits so far moved Start inside the
   * recording, in seconds, each measured from where Start was when it was
   * made; Start moved by hand (a trim, as Keep is) adds nothing. A save moves
   * the clip the other way by this much (hold-place.ts). Absent on a draft
   * from before it was kept: read as the stored Start carried through the
   * edits, as it was.
   */
  startShiftSec?: number
  /** Each earlier state, for Undo before saving (40b keeps 50). */
  undo: Array<{ ops: EditOp[]; trim: StationDraft["trim"]; startShiftSec?: number }>
  /** "This clip only" or "Everywhere" (placed more than once). */
  scope: "clip" | "all"
}

export const EMPTY_DRAFT: StationDraft = { ops: [], trim: null, sources: {}, undo: [], scope: "clip" }
export const DRAFT_UNDO_LIMIT = 50
const KEY = "aquilla:stationDraft:"

export function draftKey(t: { fileId: string; cellId: string; audioId: string }): string {
  return `${t.fileId}|${t.cellId}|${t.audioId}`
}

export function readDraft(key: string): StationDraft | null {
  try {
    const raw = localStorage.getItem(KEY + key)
    if (!raw) return null
    const d = JSON.parse(raw) as Partial<StationDraft>
    if (!Array.isArray(d.ops) || d.ops.length === 0) return null
    return {
      ...EMPTY_DRAFT,
      ...d,
      ops: d.ops,
      undo: Array.isArray(d.undo) ? d.undo : [],
      sources: d.sources ?? {},
      startShiftSec: typeof d.startShiftSec === "number" ? d.startShiftSec : undefined,
    }
  } catch {
    return null
  }
}

export function writeDraft(key: string, d: StationDraft | null): void {
  try {
    if (d && d.ops.length > 0) localStorage.setItem(KEY + key, JSON.stringify(d))
    else localStorage.removeItem(KEY + key)
  } catch {
    // Private mode or full: the draft lives for this visit only.
  }
}

/** One step forward: the state before it is kept for Undo. */
export function pushDraft(d: StationDraft, next: Partial<Pick<StationDraft, "ops" | "trim" | "sources" | "startShiftSec">>): StationDraft {
  const undo = [...d.undo, { ops: d.ops, trim: d.trim, startShiftSec: d.startShiftSec }].slice(-DRAFT_UNDO_LIMIT)
  return { ...d, ...next, undo }
}

/**
 * AQU-2493 (review, Nov 9): the draft's Start shift after a Delete or Insert
 * made while Start is at `startNow` (seconds): what the edit moved it by,
 * added. Unknown stays unknown (a draft from before it was kept).
 */
export function startShiftAfter(d: StationDraft, op: EditOp, startNow: number): number | undefined {
  const was = d.ops.length === 0 ? 0 : d.startShiftSec
  if (was == null) return undefined
  return was + (shiftTime(startNow, op) - startNow)
}

/** Undo the newest unsaved edit; null when there is nothing to undo. */
export function undoDraft(d: StationDraft): StationDraft | null {
  const prev = d.undo[d.undo.length - 1]
  if (!prev) return null
  return { ...d, ops: prev.ops, trim: prev.trim, startShiftSec: prev.startShiftSec, undo: d.undo.slice(0, -1) }
}

// AQU-2153: each editor view resumes where you left it.
//
// The Text and Media views share ONE mounted editor table, so toggling
// between those two keeps its scroll by itself — and on a time-ordered file
// Media → Text deliberately re-centres on the timeline's selected line
// (the AQU-646 trace). The Transcribe view replaces that table with its own
// list, so a switch into or out of it tears the view you leave down and
// builds the one you land on from scratch, at row 1. Those are the only
// switches that need a remembered row, which is why `viewSwitchRebuilds` is
// the gate rather than "every switch": remembering a row for Text ↔ Media
// would put the table back where it was two visits ago instead of leaving
// the place it already holds.
//
// The memory is keyed by file AND view, so two file tabs never inherit each
// other's place and a first visit to a view still opens at the top. It lives
// for the session only — a reload resumes through the per-file last-cell
// memory, as before.

import type { EditorLens } from "@/components/EditorModeToggle"

/** Does switching from `from` to `to` tear the editor surface down? */
export function viewSwitchRebuilds(from: EditorLens, to: EditorLens): boolean {
  return from !== to && (from === "transcribe" || to === "transcribe")
}

export interface ViewScrollMemory {
  /** Record the row at the top of `lens` for `fileId`; a null row forgets it. */
  remember(fileId: string | null, lens: EditorLens, cellId: string | null): void
  /** The row to put back at the top, or null on a first visit to that view. */
  recall(fileId: string | null, lens: EditorLens): string | null
}

/**
 * The line Media opens on when leaving Text.
 *
 * The row at the top of the text is the chapter the reader is on. The
 * virtualizer's current index is only a fallback: a row it has not measured
 * reports position 0, and that 0 is the start of the file — Media then opens
 * on chapter 1 and the text follows it there. A missing top row together
 * with index 0 therefore leaves the timeline where it is, instead of
 * selecting the first line.
 */
export function cellIdForMediaTrace(
  topVisibleCellId: string | null,
  currentIndex: number,
  cellIdAtIndex: (index: number) => string | undefined,
): string | null {
  if (topVisibleCellId) return topVisibleCellId
  if (currentIndex > 0) return cellIdAtIndex(currentIndex) ?? null
  return null
}

export function createViewScrollMemory(): ViewScrollMemory {
  const topRowByFileAndLens = new Map<string, string>()
  const key = (fileId: string, lens: EditorLens) => `${fileId}|${lens}`
  return {
    remember(fileId, lens, cellId) {
      if (!fileId) return
      if (cellId) topRowByFileAndLens.set(key(fileId, lens), cellId)
      else topRowByFileAndLens.delete(key(fileId, lens))
    },
    recall(fileId, lens) {
      return fileId ? topRowByFileAndLens.get(key(fileId, lens)) ?? null : null
    },
  }
}

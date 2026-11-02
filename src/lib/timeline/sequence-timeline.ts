// AQU-1758 (Oct 27): what a SEQUENCE-ORDERED file — a Bible book, a document —
// puts on the timeline, now that the Audio view is gone and every file opens on
// the timeline in Media.
//
// Two rules, decided with the removal:
//
//   - ONE CHAPTER AT A TIME. Genesis has about 1,500 verses; one timeline for
//     the whole book is unreadable and slow. The timeline shows the chapter the
//     chapter picker (and the table under it) is on. While playback runs, it
//     shows the chapter being played instead, so a run that crosses into the
//     next chapter carries the timeline with it.
//   - HEADINGS FOLLOW THE PROJECT'S "Count headings as translatable content"
//     (`countStructuralCells`; Sam's decision 2): counted, a heading or
//     section break sits on the timeline like any line — its take, or a dashed
//     stand-in from its words. Not counted, it stays off unless recorded.
//     HIDDEN (parked) lines stay off unless recorded, whatever the setting.
//   - A FILE WITH NO CHAPTERS SHOWS WHOLE, however long (Sam, Oct 28: the
//     long-file parts are dropped). The timeline draws only the clips in view
//     and caches their waveforms, so length costs nothing; parts only added
//     moving pieces. Only divisions that came from the file are chapters —
//     the 50-line "Part"s the table pages a file with none by are not.
//
// Pure. The workspace feeds the chapters from the cell store's own navigation
// index (the one the chapter picker reads) and the cells from the merged read.

import { resolveTargetPieces } from "@/lib/audio/track-audio"
import { isHiddenCell } from "@/lib/cells/hidden"
import { isStructuralCell } from "@/lib/cells/structural"
import type { CellData } from "@/hooks/useCells"

/** One division of the file, as the chapter picker lists it. */
export interface TimelineChapter {
  key: string
  cellIds: readonly string[]
}

/**
 * True for a line that is not drawn on a sequence file's timeline: a hidden
 * line, or — when the project does not count headings — a heading or section
 * break, with no recording of its own. `countStructural` is the project's
 * "Count headings as translatable content" (project, else org, else true).
 */
export function staysOffSequenceTimeline(cell: CellData, countStructural = true): boolean {
  const structuralOff = !countStructural && isStructuralCell(cell.type)
  if (!structuralOff && !isHiddenCell(cell)) return false
  return resolveTargetPieces(cell).length === 0
}

/**
 * Whether a file's divisions are CHAPTERS — divisions that came from the file
 * (chapters, stories, sections) — rather than ones the app invented to page a
 * file that has none (50-line "Part"s, 5-minute time ranges).
 */
export function hasRealChapters(entries: readonly { kind?: string }[]): boolean {
  return entries.length > 0 && entries.every((entry) => entry.kind !== "part" && entry.kind !== "time-range")
}

/**
 * The chapters a sequence file's timeline goes one at a time through: its own
 * chapters, from the table's navigation index — or none, when it has no real
 * chapters, and the timeline shows the whole file however long it is.
 */
export function timelineChaptersOf(entries: readonly { key: string; cellIds: readonly string[]; kind?: string }[]): TimelineChapter[] {
  return hasRealChapters(entries) ? entries.map((entry) => ({ key: entry.key, cellIds: entry.cellIds })) : []
}

/** The chapter holding `cellId`, or null when no chapter lists it. */
export function chapterOfCell(
  chapters: readonly TimelineChapter[],
  cellId: string | null | undefined,
): TimelineChapter | null {
  if (!cellId) return null
  return chapters.find((chapter) => chapter.cellIds.includes(cellId)) ?? null
}

/**
 * The chapter the timeline shows: the one playback is on (`queueCellId`, the
 * line playing or paused on this file), else the one the person is on
 * (`chosenKey`), else the first. Null for a file with no chapters, which the
 * caller reads as "the whole file".
 */
export function resolveTimelineChapter({
  chapters,
  chosenKey,
  queueCellId,
}: {
  chapters: readonly TimelineChapter[]
  chosenKey: string | null
  queueCellId: string | null
}): TimelineChapter | null {
  if (chapters.length === 0) return null
  const playing = chapterOfCell(chapters, queueCellId)
  if (playing) return playing
  return chapters.find((chapter) => chapter.key === chosenKey) ?? chapters[0]
}

/** The lines a sequence file's timeline draws for `chapter` (the whole file
 *  when null), in the file's own order. */
export function sequenceTimelineCells<T extends CellData>(
  cells: readonly T[],
  chapter: TimelineChapter | null,
  countStructural = true,
): T[] {
  const inChapter = chapter ? new Set(chapter.cellIds) : null
  return cells.filter((cell) => (inChapter == null || inChapter.has(cell.id)) && !staysOffSequenceTimeline(cell, countStructural))
}

/** The lines of one chapter (the whole list when null), in order. */
export function scopeCells<T extends CellData>(cells: readonly T[], scope: TimelineChapter | null): T[] {
  if (!scope) return cells as T[]
  const inScope = new Set(scope.cellIds)
  return cells.filter((cell) => inScope.has(cell.id))
}

/**
 * Where Play all goes once a chapter has played to its end: the next chapter
 * after `key` with anything to play (`hasPlayable` decides), or null at the
 * end of the file. A chapter nobody has recorded yet is stepped over, as
 * playback steps over an unrecorded verse.
 */
export function nextPlayableChapter(
  chapters: readonly TimelineChapter[],
  key: string,
  hasPlayable: (chapter: TimelineChapter) => boolean,
): TimelineChapter | null {
  const at = chapters.findIndex((chapter) => chapter.key === key)
  if (at < 0) return null
  for (let i = at + 1; i < chapters.length; i++) {
    if (hasPlayable(chapters[i])) return chapters[i]
  }
  return null
}

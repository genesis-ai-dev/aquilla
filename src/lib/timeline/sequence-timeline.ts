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
//   - A LONG FILE WITH NO CHAPTERS SHOWS IN PARTS (Sam's decision 1): over 90
//     minutes, it is cut at line boundaries into the fewest roughly equal
//     parts of 90 minutes or less, and a part behaves like a chapter. 90 is the
//     longest film we have (71:59) plus about a fifth, rounded up.
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

/** The longest a timeline shows at once, in seconds, before a file with no
 *  chapters is shown in parts. */
export const PART_MAX_SEC = 90 * 60

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

/** A line's place on a laid-out timeline: where it starts and how long it is. */
export interface TimelineLineSpan {
  cellId: string
  startSec: number
  lenSec: number
}

/** One part of a long file: its lines, and where it runs on the whole file. */
export interface TimelinePart extends TimelineChapter {
  index: number
  count: number
  startSec: number
  endSec: number
}

/**
 * The parts a file with no chapters shows in: none (the whole file) at
 * `maxSec` or less; otherwise the FEWEST roughly equal parts, cut at line
 * boundaries, each `maxSec` or less. A single line longer than `maxSec` is a
 * part of its own — a line is never cut.
 */
export function splitIntoParts(lines: readonly TimelineLineSpan[], maxSec = PART_MAX_SEC): TimelinePart[] {
  if (lines.length < 2) return []
  const first = lines[0].startSec
  const endOf = (i: number) => lines[i].startSec + lines[i].lenSec
  const total = endOf(lines.length - 1) - first
  if (!(total > maxSec)) return []
  for (let count = Math.ceil(total / maxSec); count <= lines.length; count++) {
    // The cut before part k is the line boundary nearest k/count of the way.
    const cuts: number[] = [0]
    for (let k = 1; k < count; k++) {
      const target = first + (total * k) / count
      let best = -1
      for (let i = cuts[cuts.length - 1] + 1; i < lines.length; i++) {
        if (best < 0 || Math.abs(lines[i].startSec - target) < Math.abs(lines[best].startSec - target)) best = i
        if (lines[i].startSec > target) break
      }
      if (best < 0) break
      cuts.push(best)
    }
    if (cuts.length !== count) continue
    const parts: TimelinePart[] = cuts.map((from, k) => {
      const to = k + 1 < cuts.length ? cuts[k + 1] : lines.length
      return {
        key: `part:${k + 1}`,
        index: k,
        count,
        startSec: lines[from].startSec,
        endSec: endOf(to - 1),
        cellIds: lines.slice(from, to).map((line) => line.cellId),
      }
    })
    const fits = parts.every((part) => part.endSec - part.startSec <= maxSec || part.cellIds.length === 1)
    if (fits) return parts
  }
  return []
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

/** The lines of one chapter or part (the whole list when null), in order. */
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

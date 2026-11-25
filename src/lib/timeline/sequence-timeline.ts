// AQU-1758 (Oct 27): what a SEQUENCE-ORDERED file — a Bible book, a document —
// puts on the timeline, now that the Audio view is gone and every file opens on
// the timeline in Media.
//
// Two rules, decided with the removal, and the later one for the drawing:
//
//   - THE WHOLE FILE, EVERY CHAPTER, unless Split into milestones is on.
//     Off, the timeline lays the book out end to end, so scrolling carries
//     you into the next chapter. On, it draws only the milestone the table
//     is on (`timelineCellsForMilestoneSplit`). The chapter picker still
//     names a chapter: a pick while playback is running jumps the playhead
//     to that chapter's first line.
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
//     Split into milestones is the exception: the timeline then shows the
//     part, time range, or chapter the table is on.
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
 * The chapter the reader is on: the one playback is on (`queueCellId`, the
 * line playing or paused on this file), else the one the person is on
 * (`chosenKey`), else the first. Null for a file with no chapters. The
 * timeline draws the whole file either way; this names the chapter, it does
 * not choose which lines are drawn.
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

/** One milestone the table can page to, including a part or a time range. */
export interface MilestoneTimelinePage {
  key: string
  cellIds: readonly string[]
}

/**
 * Lines the timeline draws.
 *
 * Split into milestones off: `cells` itself. A book stays one clock from
 * the first chapter through the last, and a file with no milestones is
 * unchanged.
 * Split into milestones on: only the milestone the table is on. A missing
 * or unknown key opens the first milestone, the page the table opens on.
 * The same array comes back when every drawn line is already on that page.
 */
export function timelineCellsForMilestoneSplit<T extends { id: string }>(
  cells: readonly T[],
  options: {
    split: boolean
    milestones: readonly MilestoneTimelinePage[]
    milestoneKey: string | null
  },
): T[] {
  if (!options.split || options.milestones.length === 0) return cells as T[]
  const known = options.milestoneKey != null
    && options.milestones.some((page) => page.key === options.milestoneKey)
  const key = known ? options.milestoneKey : options.milestones[0]?.key
  const page = options.milestones.find((entry) => entry.key === key)
  if (!page) return cells as T[]
  const ids = new Set(page.cellIds)
  const kept: T[] = []
  let dropped = false
  for (const cell of cells) {
    if (ids.has(cell.id)) kept.push(cell)
    else dropped = true
  }
  return dropped ? kept : cells as T[]
}

type TimedLine = { id: string; startTime?: number | null; endTime?: number | null }

/**
 * AQU-2711 x AQU-2253 (review, Nov 25): a subtitle file's heard lines (its
 * audio cue file's) for the milestone on the timeline, with Split into
 * milestones on. Every heard line belongs to exactly one milestone (`pages`,
 * in the file's order):
 *  - one paired with subtitle lines, to the milestone of its earliest paired
 *    line;
 *  - one paired with none (or with none on any milestone, or while the pairs
 *    are still loading, `pairsPending`), by where it starts: to the milestone
 *    whose time range it starts in; in a gap, to the next one; after the last,
 *    to the last; with no times at all, to the first.
 * With the whole file on the timeline (`milestone` is `all`: the split off, or
 * one milestone holding everything) the heard lines come back as they are.
 */
export function heardLinesOfMilestone<T extends TimedLine>(
  heard: T[] | null,
  milestone: readonly TimedLine[],
  all: readonly TimedLine[],
  pages: readonly (readonly TimedLine[])[],
  textForCue: ReadonlyMap<string, readonly string[]>,
  pairsPending = false,
): T[] | null {
  if (!heard || milestone === all) return heard
  const pageOf = new Map<string, number>()
  pages.forEach((page, i) => { for (const line of page) if (!pageOf.has(line.id)) pageOf.set(line.id, i) })
  const target = milestone.length > 0 ? pageOf.get(milestone[0].id) ?? -1 : -1
  if (target < 0) return []
  // Where each milestone's time range ends (-Infinity: no times).
  const ends = pages.map((page) => {
    let end = -Infinity
    for (const line of page) {
      const e = typeof line.endTime === "number" && Number.isFinite(line.endTime) ? line.endTime : line.startTime
      if (typeof e === "number" && Number.isFinite(e)) end = Math.max(end, e)
    }
    return end
  })
  const byTime = (at: number | null | undefined): number => {
    if (typeof at !== "number" || !Number.isFinite(at)) return 0
    // The first milestone that has not ended by the time it starts: its own
    // range, or the next one after a gap; after the last, the last.
    let lastTimed = 0
    for (let i = 0; i < ends.length; i++) {
      if (ends[i] === -Infinity) continue
      lastTimed = i
      if (at < ends[i]) return i
    }
    return lastTimed
  }
  const placeOf = (cue: T): number => {
    if (!pairsPending) {
      let earliest = Infinity
      for (const id of textForCue.get(cue.id) ?? []) {
        const i = pageOf.get(id)
        if (i != null) earliest = Math.min(earliest, i)
      }
      if (Number.isFinite(earliest)) return earliest
    }
    return byTime(cue.startTime)
  }
  return heard.filter((cue) => placeOf(cue) === target)
}

/**
 * AQU-2711 x AQU-2253 (review, Nov 25): is only part of the file on the
 * timeline? `timelineCellsForMilestoneSplit` hands back the file's own list
 * whenever it keeps every line (the split off, no milestones, one milestone
 * holding everything), so a different list is a part.
 */
export function showsPartOfFile(shown: readonly unknown[], all: readonly unknown[]): boolean {
  return shown !== all
}

/**
 * AQU-2711 x AQU-2253 (review, Nov 25): the lines the recorder walks. The
 * milestone's heard lines (`cut`); opened on a line the cut does not hold (a
 * milestone with none, or the table's own record button on a line elsewhere),
 * the whole cue file, so the line it was opened on is there to record. With
 * no cue file, the file's own lines.
 */
export function recorderLinesFor<T extends { id: string }>(
  cut: T[] | null,
  whole: T[] | null,
  plain: T[],
  openedOn: string | null,
): T[] {
  if (cut && (openedOn == null || cut.some((c) => c.id === openedOn))) return cut
  return whole ?? plain
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

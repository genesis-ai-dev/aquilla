/**
 * AQU-2673: a batch on the open book can stop at one chapter.
 *
 * The book is the file that is open. A chapter is the label `chapterLabelForCell`
 * already derives from the cell's canonical ref ("GEN 1:1" → "GEN 1"). The
 * editor reports the chapter on screen as a milestone key (`scripture:GEN:1`),
 * which is a different spelling of that same label.
 */
import { chapterLabelForCell } from "@/lib/export/chapter-scope"

/** Select value for "every chapter of this book". */
export const WHOLE_BOOK = "whole"

export function chapterLabelForMilestoneKey(key: string | null | undefined): string | null {
  if (!key) return null
  const scripture = /^scripture:([1-3]?[A-Z]{2,3}):(\d+)$/i.exec(key)
  if (scripture) return `${scripture[1].toUpperCase()} ${Number(scripture[2])}`
  const story = /^story:OBS:(\d+)$/i.exec(key)
  if (story) return `OBS ${Number(story[1])}`
  return null
}

/**
 * The chapter the dialog opens on.
 *
 * The milestone the editor is showing wins when it names a chapter of this
 * file. Otherwise the first chapter, so a book never opens already set to
 * the whole book. A file with no chapters has nothing to choose.
 */
export function initialChapterScope(
  chapters: readonly string[],
  activeMilestoneKey: string | null | undefined,
): string {
  if (chapters.length === 0) return WHOLE_BOOK
  const fromKey = chapterLabelForMilestoneKey(activeMilestoneKey)
  if (fromKey && chapters.includes(fromKey)) return fromKey
  if (activeMilestoneKey && chapters.includes(activeMilestoneKey)) return activeMilestoneKey
  return chapters[0]
}

export function applyChapterScope<T extends { group?: string | null }>(
  cells: readonly T[],
  chapter: string | null | undefined,
): readonly T[] {
  if (!chapter || chapter === WHOLE_BOOK) return cells
  return cells.filter((cell) => chapterLabelForCell({ group: cell.group ?? "" }) === chapter)
}

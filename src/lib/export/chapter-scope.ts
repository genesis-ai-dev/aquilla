// AQU-465: chapter-level export scope.
//
// Export scope used to be all-or-nothing — the current file or the whole
// project — with nothing in between. Peggy's ask (Biblica/Kilisusu demo) was
// the obvious middle: hand me just this chapter.
//
// A chapter is not stored on the cell. `buildCellData` puts the canonical ref
// on `group` ("GEN 1:1") and leaves the parser's own `section` behind, so the
// chapter has to be re-derived at the read boundary the same way
// `sectionLabelFromCanonical` does it in the cell store: everything before the
// first colon.
//
// The `looksLikeChapter` guard is what keeps this from firing on files that
// have no chapters at all. A subtitle or timeline file's `group` is a cue id
// or a timestamp, and without the guard every single cue would come back as
// its own "chapter" — a picker with 400 entries and no meaning. Requiring the
// label to end in a small number after a separator ("GEN 1", "1CO 3",
// "Story 4") admits real milestones and rejects uuids and timecodes.

import type { CellData } from "@/hooks/useCells"

/** A name followed by a 1–3 digit number — "GEN 1", "1 Corinthians 3". */
const CHAPTER_LABEL = /^(?:.*\S)[ .]+\d{1,3}$/

/** True when a milestone label reads as a chapter rather than a cue id. */
export function looksLikeChapter(label: string): boolean {
  return CHAPTER_LABEL.test(label)
}

/**
 * The chapter a cell belongs to, or "" when it has none.
 *
 * A verse ref yields its chapter ("GEN 1:1" → "GEN 1"); a cell already
 * anchored at the chapter (a heading) yields itself.
 */
export function chapterLabelForCell(cell: Pick<CellData, "group">): string {
  const ref = cell.group ?? ""
  const colonIdx = ref.indexOf(":")
  const label = (colonIdx >= 0 ? ref.slice(0, colonIdx) : ref).trim()
  return looksLikeChapter(label) ? label : ""
}

/**
 * The distinct chapters in a file, in document order.
 *
 * Document order, not sorted: "GEN 10" sorts before "GEN 2" alphabetically,
 * and the cells already arrive in the source chain's order.
 */
export function listChapterLabels(cells: readonly Pick<CellData, "group">[]): string[] {
  const seen = new Set<string>()
  const labels: string[] = []
  for (const cell of cells) {
    const label = chapterLabelForCell(cell)
    if (!label || seen.has(label)) continue
    seen.add(label)
    labels.push(label)
  }
  return labels
}

/**
 * Keep only the cells in `label`. An empty `label` means "all chapters" and
 * returns the input untouched — the same contract as the voice filter.
 */
export function filterCellsByChapter<T extends Pick<CellData, "group">>(
  cells: readonly T[],
  label: string,
): readonly T[] {
  if (!label) return cells
  return cells.filter((cell) => chapterLabelForCell(cell) === label)
}

/**
 * The filename fragment for a chapter, sanitised the way `buildExportStem`
 * sanitises a project name. Without it two chapters of the same file would
 * both download as `<file>.tsv` and the second would land as `(1)`.
 */
export function chapterFilenameSuffix(label: string): string {
  const safe = label.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "")
  return safe ? `_${safe}` : ""
}

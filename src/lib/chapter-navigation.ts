export interface ChapterRowBounds {
  index: number
  top: number
  bottom: number
}

function normalizeChapterHeading(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "")
}

export function rowMatchesChapterHeading(
  values: readonly (string | null | undefined)[],
  chapterDisplayLabel: string,
): boolean {
  const expected = normalizeChapterHeading(chapterDisplayLabel)
  return expected.length > 0 && values.some(
    (value) => normalizeChapterHeading(value ?? "") === expected,
  )
}

/** Find the top rendered row that crosses into the list's visible content area. */
export function firstActuallyVisibleIndex(
  rows: readonly ChapterRowBounds[],
  viewportTop: number,
  fallbackIndex: number,
): number {
  let visibleIndex = fallbackIndex
  let nearestTop = Number.POSITIVE_INFINITY

  for (const row of rows) {
    if (row.bottom <= viewportTop + 1 || row.top >= nearestTop) continue
    visibleIndex = row.index
    nearestTop = row.top
  }

  return visibleIndex
}

/** Resolve the section at the viewport's actual top edge. */
export function sectionLabelAtViewportStart(
  cellIds: readonly string[],
  firstVisibleIndex: number,
  getSectionLabel: (cellId: string) => string,
): string {
  const cellId = cellIds[firstVisibleIndex]
  return cellId ? getSectionLabel(cellId) : ""
}

/**
 * Keep an explicit picker/arrow selection authoritative until the user takes
 * over scrolling. This matters for a short final chapter whose first row
 * cannot physically reach the viewport's top edge.
 */
export function resolveActiveChapterLabel(
  chapterLabels: readonly string[],
  viewportLabel: string,
  selectedLabel: string | null,
): string {
  if (selectedLabel && chapterLabels.includes(selectedLabel)) return selectedLabel
  if (chapterLabels.includes(viewportLabel)) return viewportLabel
  return chapterLabels[0] ?? ""
}

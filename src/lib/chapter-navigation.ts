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
 * While a programmatic chapter jump is animating, viewport-derived indices
 * briefly report intermediate chapters. Keep accepting only once the top
 * visible row lands inside the destination chapter's index range.
 */
export function shouldAcceptChapterVisibleIndex(
  pendingJump: { index: number; endIndex: number } | null,
  nextIndex: number,
): boolean {
  if (!pendingJump) return true
  return nextIndex >= pendingJump.index && nextIndex < pendingJump.endIndex
}

/** Prefer a pinned jump target over a transient viewport section label. */
export function resolveActiveChapterLabel(
  chapterLabels: readonly string[],
  currentSectionLabel: string,
  pinnedLabel: string | null,
): string {
  if (pinnedLabel && chapterLabels.includes(pinnedLabel)) return pinnedLabel
  if (chapterLabels.includes(currentSectionLabel)) return currentSectionLabel
  return chapterLabels[0] ?? ""
}

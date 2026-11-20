/** Which cells Select All should mark.
 *
 * A browser selection only includes rows the virtualized list currently has
 * mounted. Select All on the text therefore cannot cover a chapter. This
 * picks the cells instead: the chapter on screen, the filtered rows when a
 * filter is showing a subset, or every displayed row when the file has no
 * chapter. */
export function idsForSelectAll(input: {
  displayedIds: readonly string[]
  /** A filter is listing a subset. Select that subset, not the whole chapter. */
  filtered: boolean
  /** Cells of the division currently on screen. Absent when the file has none. */
  chapterIds?: readonly string[] | null
}): readonly string[] {
  if (input.displayedIds.length === 0) return []
  if (input.filtered) return input.displayedIds
  if (input.chapterIds && input.chapterIds.length > 0) return input.chapterIds
  return input.displayedIds
}

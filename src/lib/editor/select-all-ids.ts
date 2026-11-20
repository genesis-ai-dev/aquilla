/** Which cells Select All should mark.
 *
 * A browser selection only includes rows the virtualized list currently has
 * mounted, and the table often shows one chapter at a time. Select All marks
 * the cells themselves: every cell in the file, or the filtered rows when a
 * filter is showing a subset. */
export function idsForSelectAll(input: {
  fileIds: readonly string[]
  /** Rows a filter is showing. Null when no filter is on. */
  filteredIds: readonly string[] | null
}): readonly string[] {
  if (input.filteredIds) return input.filteredIds
  return input.fileIds
}

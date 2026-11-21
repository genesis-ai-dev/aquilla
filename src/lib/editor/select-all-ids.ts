/** Which cells Select All should mark.
 *
 * A browser selection only includes rows the virtualized list currently has
 * mounted. Select All marks the cells themselves: the milestone on the page
 * when Split into milestones is on, the filtered rows when a filter is
 * showing a subset, and every cell in the file when the list is continuous.
 * A filter wins over the milestone page, because that list is what the table
 * is showing. */
export function idsForSelectAll(input: {
  fileIds: readonly string[]
  /** Rows a filter is showing. Null when no filter is on. */
  filteredIds: readonly string[] | null
  /** Cells on the current milestone page. Null when the file is one continuous list. */
  milestoneIds: readonly string[] | null
}): readonly string[] {
  if (input.filteredIds) return input.filteredIds
  if (input.milestoneIds) return input.milestoneIds
  return input.fileIds
}

/** Which row a checkbox drag should include.
 *
 * The list only mounts rows inside its draw window, so a pointer can never
 * land on a row that has not been rendered. Inside that window the row under
 * the pointer is the target. In the top or bottom edge of the scrollport the
 * drag runs through the start or the end of the list, mounted or not. */
export function dragSelectionIndex(input: {
  clientY: number
  viewTop: number
  viewBottom: number
  edgeZone: number
  /** Index of the mounted row under the pointer. Negative when there is none. */
  rowIndex: number
  count: number
}): number {
  if (input.count <= 0) return -1
  const zone = Math.max(0, input.edgeZone)
  if (input.clientY >= input.viewBottom - zone) return input.count - 1
  if (input.clientY <= input.viewTop + zone) return 0
  if (input.rowIndex >= 0 && input.rowIndex < input.count) return input.rowIndex
  return -1
}

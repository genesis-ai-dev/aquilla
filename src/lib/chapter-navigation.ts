/** Resolve the section at the viewport's top edge, not its middle or overscan. */
export function sectionLabelAtViewportStart(
  cellIds: readonly string[],
  firstVisibleIndex: number,
  getSectionLabel: (cellId: string) => string,
): string {
  const cellId = cellIds[firstVisibleIndex]
  return cellId ? getSectionLabel(cellId) : ""
}

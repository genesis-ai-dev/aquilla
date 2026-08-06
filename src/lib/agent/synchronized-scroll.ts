/**
 * Cell-aware scroll synchronization for the agent workbench.
 *
 * Source and target verses rarely have equal rendered heights, so mirroring
 * raw scrollTop pixels drifts almost immediately. Instead we identify the
 * cell crossing the viewport's top edge and preserve the reader's relative
 * progress through that cell in the opposite pane.
 */

export interface CellScrollAnchor {
  cellId: string
  progress: number
}

function cellElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>("[data-cell-id]"))
}

export function readCellScrollAnchor(container: HTMLElement): CellScrollAnchor | null {
  const cells = cellElements(container)
  if (cells.length === 0) return null

  const top = container.scrollTop
  const cell = cells.find((candidate) => candidate.offsetTop + candidate.offsetHeight > top)
    ?? cells[cells.length - 1]
  const height = Math.max(cell.offsetHeight, 1)

  return {
    cellId: cell.dataset.cellId ?? "",
    progress: Math.min(Math.max((top - cell.offsetTop) / height, 0), 1),
  }
}

export function applyCellScrollAnchor(
  container: HTMLElement,
  anchor: CellScrollAnchor,
): boolean {
  const cell = cellElements(container).find((candidate) => candidate.dataset.cellId === anchor.cellId)
  if (!cell) return false

  const desired = cell.offsetTop + Math.max(cell.offsetHeight, 1) * anchor.progress
  const maxScroll = Math.max(container.scrollHeight - container.clientHeight, 0)
  container.scrollTop = Math.min(Math.max(desired, 0), maxScroll)
  return true
}

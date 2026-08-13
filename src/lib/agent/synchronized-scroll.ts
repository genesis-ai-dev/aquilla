/** Cell-aware synchronization for source and target panes with unequal row heights. */

interface CellScrollAnchor {
  cellId: string
  progress: number
}

function cellsIn(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>("[data-cell-id]"))
}

export function readCellScrollAnchor(container: HTMLElement): CellScrollAnchor | null {
  const cells = cellsIn(container)
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

export function applyCellScrollAnchor(container: HTMLElement, anchor: CellScrollAnchor): boolean {
  const cell = cellsIn(container).find((candidate) => candidate.dataset.cellId === anchor.cellId)
  if (!cell) return false
  const desired = cell.offsetTop + Math.max(cell.offsetHeight, 1) * anchor.progress
  const maxScroll = Math.max(container.scrollHeight - container.clientHeight, 0)
  container.scrollTop = Math.min(Math.max(desired, 0), maxScroll)
  return true
}

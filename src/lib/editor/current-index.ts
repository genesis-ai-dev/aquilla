// Pure resolution of "which cell is the user at right now?" for viewport-
// relative navigation ("Next unfinished"). Kept out of EditorTable so the
// index math is trivially testable — the component binds it to LegendList
// state and mirror refs (same split as useNextUnfinished's pure search).
//
// Returns an index into `cells` (the prop order ProjectWorkspace's search
// indexes into), which differs from `displayCells` (the rendered order) in
// time-ordered mode.

export interface VirtualListMeasurements {
  scroll: number
  positionAtIndex: (index: number) => number
  sizeAtIndex: (index: number) => number
}

export interface ResolveCurrentCellIndexArgs {
  /** Rows in rendered (display) order — filtered/re-sorted in time-ordered mode. */
  displayCells: ReadonlyArray<{ id: string }>
  /** The `cells` prop order that the returned index points into. */
  cells: ReadonlyArray<{ id: string }>
  /** Cell whose editor was most recently active (last jump target or
   *  clicked-into cell). May already be blurred — clicking the "Next
   *  unfinished" control itself blurs the editor. */
  activeCellId: string | null
  /** Display-space indexes currently on screen (LegendList viewability). */
  viewableIndexes: ReadonlyArray<number>
  /** Virtual-list measurements; null when the list isn't mounted. */
  measurements: VirtualListMeasurements | null
  /** scrollTop fallback when measurements are unavailable. */
  fallbackScrollTop: number
  estimatedRowHeight: number
}

export function resolveCurrentCellIndex(args: ResolveCurrentCellIndexArgs): number {
  const {
    displayCells,
    cells,
    activeCellId,
    viewableIndexes,
    measurements,
    fallbackScrollTop,
    estimatedRowHeight,
  } = args
  if (displayCells.length === 0) return 0

  // Prefer the active editor cell while it's still on screen: a jump centers
  // its target (viewPosition 0.5), so the first *visible* row sits above it —
  // resolving from the viewport would re-find the same unfinished cell and
  // repeat-clicks could never skip past it. Once the user scrolls the active
  // cell away, fall back to the viewport.
  if (activeCellId) {
    const activeDisplayIdx = displayCells.findIndex((c) => c.id === activeCellId)
    if (activeDisplayIdx >= 0 && viewableIndexes.includes(activeDisplayIdx)) {
      const activeCellIdx = cells.findIndex((c) => c.id === activeCellId)
      if (activeCellIdx >= 0) return activeCellIdx
    }
  }

  // First visible row: the first whose bottom edge clears the scroll offset.
  const scroll = measurements?.scroll ?? fallbackScrollTop
  let displayIdx = 0
  if (measurements) {
    for (let index = 0; index < displayCells.length; index += 1) {
      const start = measurements.positionAtIndex(index)
      const size = measurements.sizeAtIndex(index) || estimatedRowHeight
      if (start + size > scroll) {
        displayIdx = index
        break
      }
    }
  } else {
    displayIdx = Math.min(
      displayCells.length - 1,
      Math.max(0, Math.round(scroll / estimatedRowHeight)),
    )
  }
  const id = displayCells[displayIdx]?.id
  const cellIdx = id ? cells.findIndex((c) => c.id === id) : -1
  return cellIdx >= 0 ? cellIdx : 0
}

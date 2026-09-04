/**
 * workbench-window.ts — which cells the agent workbench's working set shows.
 *
 * The workbench renders a fixed-size window of the open file centred on the
 * focused cell. The health ribbon it draws is smoothed with an exponential
 * kernel (decay 0.78, see health-ribbon.ts), so a cell's smoothed score only
 * depends on its near neighbours: at 64 cells away the contribution is below
 * 1e-6. Reading a padded window therefore reproduces the full-file ribbon for
 * every cell inside the window, without walking the whole file (AQU-1104).
 */

export interface WorkbenchWindow {
  /** First index shown in the working set (inclusive). */
  start: number
  /** One past the last index shown. */
  end: number
  /** First index to read so the ribbon can smooth into the window. */
  readStart: number
  /** One past the last index to read. */
  readEnd: number
}

export const WORKBENCH_WINDOW_SIZE = 80
export const WORKBENCH_RIBBON_PADDING = 64

export function resolveWorkbenchWindow(
  totalCells: number,
  focusIndex: number,
  windowSize = WORKBENCH_WINDOW_SIZE,
  padding = WORKBENCH_RIBBON_PADDING,
): WorkbenchWindow {
  const total = Math.max(0, totalCells)
  const focus = Math.max(0, Math.min(focusIndex, Math.max(0, total - 1)))
  const start = Math.max(0, Math.min(focus - Math.floor(windowSize / 2), total - windowSize))
  const end = Math.min(total, start + windowSize)
  return {
    start,
    end,
    readStart: Math.max(0, start - padding),
    readEnd: Math.min(total, end + padding),
  }
}

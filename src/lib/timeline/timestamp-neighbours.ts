interface TimingReader {
  getCellView(id: string): { startTime?: number } | null
}

const NO_NEIGHBOURS = { prevStartSec: null, nextStartSec: null }

/** Bounds for the timestamp editor, in the displayed order and in seconds.
 * Untimed rows do not bound a timed row, so walk past them. If the control
 * cannot be shown, do no reads: an untimed Bible otherwise scans the entire
 * file for every visible row, on every render.
 */
export function timestampNeighbours(
  index: number,
  displayCellIds: readonly string[],
  cellStore: TimingReader,
  enabled: boolean,
): { prevStartSec: number | null; nextStartSec: number | null } {
  if (!enabled) return NO_NEIGHBOURS
  const scan = (step: -1 | 1): number | null => {
    for (let at = index + step; at >= 0 && at < displayCellIds.length; at += step) {
      const sec = cellStore.getCellView(displayCellIds[at])?.startTime
      if (typeof sec === "number") return sec
    }
    return null
  }
  return { prevStartSec: scan(-1), nextStartSec: scan(1) }
}

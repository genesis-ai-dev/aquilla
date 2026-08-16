// The media cursor: which cell the TIMELINE currently points at, published as
// a tiny module store (the selection.ts pattern) so the text table's rows can
// highlight it without threading a prop through MemoizedRow's memo surface.
// TimelineEditor writes it while mounted and clears it on unmount, so a table
// in the Text lens (or on a voice-over file) never shows a stale highlight.

import { useSyncExternalStore } from "react"

let active = false
let cursorCellId: string | null = null
const listeners = new Set<() => void>()

function notify(): void {
  for (const l of listeners) l()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** TimelineEditor's mount effect: true while the timeline is stacked above
 *  the table. Turning it off also drops the cursor. */
export function setMediaSyncActive(next: boolean): void {
  if (active === next) return
  active = next
  if (!next) cursorCellId = null
  notify()
}

/** TimelineEditor publishes its chip selection here (null = none). */
export function setMediaCursorCell(cellId: string | null): void {
  if (cursorCellId === cellId) return
  cursorCellId = cellId
  notify()
}

export function getMediaCursorCell(): string | null {
  return cursorCellId
}

/** Table-root gate — flips rarely (lens/file switches). */
export function useMediaSyncActive(): boolean {
  return useSyncExternalStore(subscribe, () => active, () => false)
}

/** Per-row subscription: exactly the two affected rows re-render on a move. */
export function useIsMediaCursorCell(cellId: string | undefined): boolean {
  return useSyncExternalStore(
    subscribe,
    () => (cellId != null && active ? cursorCellId === cellId : false),
    () => false,
  )
}

export function resetMediaCursorForTests(): void {
  active = false
  cursorCellId = null
  notify()
}

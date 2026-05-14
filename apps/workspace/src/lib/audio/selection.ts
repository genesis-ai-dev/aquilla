// Module-level cell selection. Lives outside React so the selection bar
// (a sibling of the editor) and the editor's row click handler can both
// read/write it without prop drilling. Keeps an anchor for range selection
// while the editor supplies document order. Capped at MAX_SELECTED to keep
// bulk operations from spawning runaway batches.

import { useSyncExternalStore } from "react"

export const MAX_SELECTED = 20

let selected: ReadonlySet<string> = new Set()
let anchorId: string | null = null
const listeners = new Set<() => void>()

function notify(): void { for (const l of listeners) l() }

export function getSelectedIds(): ReadonlySet<string> { return selected }

export function isSelected(cellId: string): boolean { return selected.has(cellId) }

export function getSelectionAnchorId(): string | null { return anchorId }

/** Replace the entire selection (used on plain click → no modifier). */
export function setSelection(ids: Iterable<string>, anchor?: string | null): void {
  const next = new Set<string>()
  for (const id of ids) {
    if (next.size >= MAX_SELECTED) break
    next.add(id)
  }
  const nextAnchor = next.size === 0
    ? null
    : anchor !== undefined
      ? (anchor && next.has(anchor) ? anchor : next.values().next().value ?? null)
      : anchorId && next.has(anchorId)
        ? anchorId
        : next.values().next().value ?? null
  if (sameSet(next, selected) && nextAnchor === anchorId) return
  selected = next
  anchorId = nextAnchor
  notify()
}

/** Add or remove a cell from the selection. Cap enforced. */
export function toggleSelected(cellId: string): void {
  const next = new Set(selected)
  let nextAnchor = anchorId
  if (next.has(cellId)) {
    next.delete(cellId)
    if (nextAnchor === cellId) nextAnchor = next.values().next().value ?? null
  } else {
    if (next.size >= MAX_SELECTED) return // silently ignore over-cap additions
    next.add(cellId)
    nextAnchor = cellId
  }
  if (next.size === 0) nextAnchor = null
  selected = next
  anchorId = nextAnchor
  notify()
}

export function clearSelection(): void {
  if (selected.size === 0 && anchorId === null) return
  selected = new Set()
  anchorId = null
  notify()
}

export function selectionSize(): number { return selected.size }

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false
  for (const v of a) if (!b.has(v)) return false
  return true
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function useSelectedIds(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, () => selected, () => selected)
}

export function useIsSelected(cellId: string | undefined): boolean {
  return useSyncExternalStore(
    subscribe,
    () => (cellId ? selected.has(cellId) : false),
    () => false,
  )
}

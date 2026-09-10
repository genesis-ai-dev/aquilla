// AQU-1016: scroll-driven viewport signals (visible cell ids, the tracked
// canonical ref for the parallel-bibles panel) used to live as ProjectWorkspace
// `useState`. Every virtualized scroll step called `setState`, which
// re-rendered the entire ~11.5k-line workspace shell (twice — once per
// setter) even when nothing on screen actually depended on the new value.
//
// This module holds both signals in a small store outside React state.
// Writers (EditorTable's visible-range reporting callbacks) push updates
// here directly. Readers subscribe via `useVisibleCellIds`/`useTrackedCellRef`,
// each taking an `active` flag: when the calling component doesn't currently
// need live updates (translate-as-read off and the agent workbench closed;
// the parallel-bibles panel not shown), the hook's snapshot pins to a stable
// constant so React's `useSyncExternalStore` equality check sees no change
// and skips the re-render entirely — the store still receives every scroll
// update, but nothing re-renders until a real consumer goes active.
import { useSyncExternalStore } from "react"

type Listener = () => void

function createStore<T>(initial: T, isEqual: (a: T, b: T) => boolean) {
  let value = initial
  const listeners = new Set<Listener>()
  const get = (): T => value
  const set = (next: T): void => {
    if (isEqual(value, next)) return
    value = next
    for (const listener of listeners) listener()
  }
  const subscribe = (listener: Listener): (() => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }
  return { get, set, subscribe }
}

function stringArraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

const EMPTY_VISIBLE_IDS: readonly string[] = []

const visibleCellIdsStore = createStore<readonly string[]>(EMPTY_VISIBLE_IDS, stringArraysEqual)
const trackedCellRefStore = createStore<string | null>(null, (a, b) => a === b)

/** Non-reactive write — call from the (already throttled/no-op-skipped) EditorTable reporting callback. */
export function setVisibleCellIds(next: readonly string[]): void {
  visibleCellIdsStore.set(next)
}

/** Non-reactive read — safe to call outside React render (e.g. inside an effect). */
export function getVisibleCellIds(): readonly string[] {
  return visibleCellIdsStore.get()
}

/**
 * Subscribe to visible-cell-id updates. Pass `active: false` when the caller
 * has no live consumer for the value right now — the hook then always
 * returns the same empty-array reference, so `useSyncExternalStore` never
 * reports a change and the calling component does not re-render on scroll.
 */
export function useVisibleCellIds(active: boolean): readonly string[] {
  const getSnapshot = active ? visibleCellIdsStore.get : (): readonly string[] => EMPTY_VISIBLE_IDS
  return useSyncExternalStore(visibleCellIdsStore.subscribe, getSnapshot, getSnapshot)
}

/** Non-reactive write — call from cell-click focus and the EditorTable visible-ref callback. */
export function setTrackedCellRef(next: string | null): void {
  trackedCellRefStore.set(next)
}

/** Non-reactive read — safe to call outside React render. */
export function getTrackedCellRef(): string | null {
  return trackedCellRefStore.get()
}

/**
 * Subscribe to the tracked canonical-ref updates (parallel-bibles panel).
 * Same `active`-gated bail-out as `useVisibleCellIds`.
 */
export function useTrackedCellRef(active: boolean): string | null {
  const getSnapshot = active ? trackedCellRefStore.get : (): null => null
  return useSyncExternalStore(trackedCellRefStore.subscribe, getSnapshot, getSnapshot)
}

/** Call when switching files/projects so stale viewport state doesn't leak forward. */
export function resetEditorViewportStores(): void {
  visibleCellIdsStore.set(EMPTY_VISIBLE_IDS)
  trackedCellRefStore.set(null)
}

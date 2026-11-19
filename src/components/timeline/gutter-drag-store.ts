// The gutter's in-the-air drag state: the room a cross-folder drag is opening
// and the folder a dragged track would enter or leave. Only the gutter's rows
// read it, so it lives outside the editor's state — as editor state, every
// change re-rendered the whole editor and redrew every lane beside it, which
// is what made dragging in and around an open folder lag.

import { useSyncExternalStore } from "react"
import type { TrackDragGap } from "./track-gutter-dnd"

export type GutterDragGap = TrackDragGap & { trackId: string }

export interface FolderPreview {
  kind: "leave" | "enter"
  trackId: string
  folderId: string
  edge: "above" | "below" | null
  order: number
}

interface GutterDragState {
  gap: GutterDragGap | null
  preview: FolderPreview | null
}

export interface GutterDragStore {
  get(): GutterDragState
  setGap(gap: GutterDragGap | null): void
  setPreview(preview: FolderPreview | null): void
  subscribe(listener: () => void): () => void
}

export function createGutterDragStore(): GutterDragStore {
  let state: GutterDragState = { gap: null, preview: null }
  const listeners = new Set<() => void>()
  const set = (next: GutterDragState) => {
    state = next
    for (const listener of listeners) listener()
  }
  return {
    get: () => state,
    setGap: (gap) => { if (gap !== state.gap) set({ ...state, gap }) },
    setPreview: (preview) => { if (preview !== state.preview) set({ ...state, preview }) },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

const noSubscribe = () => () => {}

/** How far the gap slides this row, or 0. */
export function useGutterGapShift(store: GutterDragStore, id: string | null): number {
  const read = () => (id == null ? 0 : store.get().gap?.shifts.get(id) ?? 0)
  return useSyncExternalStore(store.subscribe, read, read)
}

/** Whether a row shows indented: where the drag would put it while it is in
 *  the air, its own depth otherwise. */
export function useGutterIndent(
  drag: { store: GutterDragStore; trackId: string } | undefined,
  resting: boolean,
): boolean {
  const read = () => {
    if (!drag) return resting
    const { gap, preview } = drag.store.get()
    if (gap?.trackId === drag.trackId) return gap.groupId != null
    if (preview?.trackId === drag.trackId) return preview.kind === "enter"
    return resting
  }
  return useSyncExternalStore(drag ? drag.store.subscribe : noSubscribe, read, read)
}

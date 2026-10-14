// Who's Who, which participant is lit (AQU-1689).
//
// One store per editor table. Hovering or focusing a mention lights its
// participant, and every mention of that participant in the rendered rows
// tints. Each mention reads the store through a yes/no selector, so a hover
// re-renders only the mentions whose state flips: never the table, never a
// row. The list is virtualized, so "in view" is exactly "rendered".
//
// It also carries a jump's wish for keyboard focus: after "Next mention",
// focus should land on that participant's word in the cell the jump reached,
// not on the page.

import { useCallback, useSyncExternalStore } from "react"
import type { BkpEntityId } from "@/lib/bible-data/pack-types"

export type LightSource = "hover" | "focus"

export interface FocusRequest {
  cellId: string
  entity: BkpEntityId
}

export interface MentionHighlightStore {
  /** The lit participant: the one under the pointer, else the one with focus. */
  lit(): BkpEntityId | null
  light(entity: BkpEntityId, source: LightSource): void
  /** Turn off `source`'s light, if it is still on `entity`. */
  unlight(entity: BkpEntityId, source: LightSource): void
  subscribe(listener: () => void): () => void
  requestFocus(request: FocusRequest): void
  /** The pending focus request for this cell, removed as it is taken. */
  takeFocusRequest(cellId: string): BkpEntityId | null
}

export function createMentionHighlightStore(): MentionHighlightStore {
  const lights: Record<LightSource, BkpEntityId | null> = { hover: null, focus: null }
  let focusRequest: FocusRequest | null = null
  const listeners = new Set<() => void>()
  const emit = () => {
    for (const listener of listeners) listener()
  }
  return {
    lit: () => lights.hover ?? lights.focus,
    light(entity, source) {
      if (lights[source] === entity) return
      lights[source] = entity
      emit()
    },
    unlight(entity, source) {
      if (lights[source] !== entity) return
      lights[source] = null
      emit()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    requestFocus(request) {
      focusRequest = request
      emit()
    },
    takeFocusRequest(cellId) {
      if (!focusRequest || focusRequest.cellId !== cellId) return null
      const { entity } = focusRequest
      focusRequest = null
      return entity
    },
  }
}

/** True while `entity` is lit. Re-renders the caller only when that answer changes. */
export function useIsLit(store: MentionHighlightStore, entity: BkpEntityId): boolean {
  const snapshot = useCallback(() => store.lit() === entity, [store, entity])
  return useSyncExternalStore(store.subscribe, snapshot, snapshot)
}

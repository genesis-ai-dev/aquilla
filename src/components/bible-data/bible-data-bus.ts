// Bible data, the Who's Who panel talking to the editor (AQU-1689).
//
// The panel lives in the workspace's right rail; the cell filter and the
// list it scrolls live in EditorTable. Rather than thread state through the
// workspace, the panel sends requests for a file, and the editor that shows
// that file acts on them. A request nobody listens for is dropped, never
// queued, so it cannot surprise a table that mounts later. The editor also
// publishes its current filter, so the panel can show which participant is
// filtering; the editor clears it when it unmounts.

import { useCallback, useSyncExternalStore } from "react"
import type { BkpEntityId, BkpRef } from "@/lib/bible-data/pack-types"

export type BibleFilterKind = "speaker" | "mentions"

/** "Show every line by …" (a speaker) or "Show cells that mention …". */
export interface BibleFilterSpec {
  kind: BibleFilterKind
  entity: BkpEntityId
}

type Listener<T> = (value: T) => void

function channel<T>() {
  const byFile = new Map<string, Set<Listener<T>>>()
  return {
    send(fileId: string, value: T): boolean {
      const listeners = byFile.get(fileId)
      if (!listeners || listeners.size === 0) return false
      for (const listener of listeners) listener(value)
      return true
    },
    listen(fileId: string, listener: Listener<T>): () => void {
      let listeners = byFile.get(fileId)
      if (!listeners) {
        listeners = new Set()
        byFile.set(fileId, listeners)
      }
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) byFile.delete(fileId)
      }
    },
  }
}

const filterRequests = channel<BibleFilterSpec | null>()
const jumpRequests = channel<BkpRef>()

/** Ask the editor showing `fileId` to filter (or, with null, to stop). False when no editor took it. */
export function requestBibleFilter(fileId: string, filter: BibleFilterSpec | null): boolean {
  return filterRequests.send(fileId, filter)
}

export function onBibleFilterRequest(fileId: string, listener: Listener<BibleFilterSpec | null>): () => void {
  return filterRequests.listen(fileId, listener)
}

/** Ask the editor showing `fileId` to scroll to the first cell of a verse. False when no editor took it. */
export function requestMentionJump(fileId: string, ref: BkpRef): boolean {
  return jumpRequests.send(fileId, ref)
}

export function onMentionJumpRequest(fileId: string, listener: Listener<BkpRef>): () => void {
  return jumpRequests.listen(fileId, listener)
}

// ── The active filter, as the editor publishes it ───────────────────────────

const activeFilters = new Map<string, BibleFilterSpec>()
const activeListeners = new Set<() => void>()

export function publishBibleFilter(fileId: string, filter: BibleFilterSpec | null): void {
  const current = activeFilters.get(fileId)
  if (current?.kind === filter?.kind && current?.entity === filter?.entity) return
  if (filter) activeFilters.set(fileId, filter)
  else activeFilters.delete(fileId)
  for (const listener of activeListeners) listener()
}

function subscribeActive(listener: () => void): () => void {
  activeListeners.add(listener)
  return () => {
    activeListeners.delete(listener)
  }
}

/** The filter the editor showing `fileId` applies now, or null. */
export function useActiveBibleFilter(fileId: string | null): BibleFilterSpec | null {
  const snapshot = useCallback(() => (fileId ? (activeFilters.get(fileId) ?? null) : null), [fileId])
  return useSyncExternalStore(subscribeActive, snapshot, snapshot)
}

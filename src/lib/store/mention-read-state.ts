/**
 * Which mention notifications this reader has opened or dismissed, on this
 * device.
 *
 * Keyed per project and reader, then wrapped in the account-scoped storage
 * key, so one person's marks never apply to another account on the same
 * browser. A missing, unparseable, or blocked store reads as empty.
 * Dismissing hides a row from the inbox. It does not delete the comment.
 */

import { useSyncExternalStore } from "react"
import {
  ownerScopedLocalStorageKey,
  subscribeClientLocalStorageOwner,
} from "@/lib/frontier/client-local-storage"

const MAX_IDS = 400
const EMPTY: ReadonlySet<string> = new Set()

interface IdSnapshot {
  storageKey: string
  ids: ReadonlySet<string>
}

function createIdSetStore(legacyKey: (projectId: string, reader: string) => string) {
  let snapshot: IdSnapshot = { storageKey: "", ids: EMPTY }
  const listeners = new Set<() => void>()

  function notify(): void {
    for (const listener of listeners) listener()
  }

  function readStored(key: string): ReadonlySet<string> {
    if (typeof localStorage === "undefined") return EMPTY
    try {
      const raw = localStorage.getItem(key)
      if (!raw) return EMPTY
      const parsed: unknown = JSON.parse(raw)
      if (!Array.isArray(parsed)) return EMPTY
      const ids = parsed.filter((id): id is string => typeof id === "string").slice(-MAX_IDS)
      return ids.length === 0 ? EMPTY : new Set(ids)
    } catch {
      return EMPTY
    }
  }

  function get(projectId: string, reader: string): ReadonlySet<string> {
    const key = legacyKey(projectId, reader)
    if (snapshot.storageKey !== key) {
      snapshot = { storageKey: key, ids: readStored(key) }
    }
    return snapshot.ids
  }

  function add(projectId: string, reader: string, commentIds: readonly string[]): void {
    if (commentIds.length === 0) return
    const key = legacyKey(projectId, reader)
    const next = new Set(get(projectId, reader))
    let changed = false
    for (const id of commentIds) {
      if (!id || next.has(id)) continue
      next.add(id)
      changed = true
    }
    if (!changed) return
    const trimmed = [...next].slice(-MAX_IDS)
    const stored = new Set(trimmed)
    if (typeof localStorage !== "undefined") {
      try {
        localStorage.setItem(key, JSON.stringify(trimmed))
      } catch {
        // Quota or a blocked store: the in-memory snapshot still updates.
      }
    }
    snapshot = { storageKey: key, ids: stored }
    notify()
  }

  function remove(projectId: string, reader: string, commentIds: readonly string[]): void {
    if (commentIds.length === 0) return
    const key = legacyKey(projectId, reader)
    const next = new Set(get(projectId, reader))
    let changed = false
    for (const id of commentIds) {
      if (!id || !next.delete(id)) continue
      changed = true
    }
    if (!changed) return
    const trimmed = [...next]
    const stored = trimmed.length === 0 ? EMPTY : new Set(trimmed)
    if (typeof localStorage !== "undefined") {
      try {
        if (trimmed.length === 0) localStorage.removeItem(key)
        else localStorage.setItem(key, JSON.stringify(trimmed))
      } catch {
        // Quota or a blocked store: the in-memory snapshot still updates.
      }
    }
    snapshot = { storageKey: key, ids: stored }
    notify()
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener)
    const unsubOwner = subscribeClientLocalStorageOwner(() => {
      snapshot = { storageKey: "", ids: EMPTY }
      listener()
    })
    return () => {
      listeners.delete(listener)
      unsubOwner()
    }
  }

  function useIds(projectId: string, reader: string): ReadonlySet<string> {
    return useSyncExternalStore(
      subscribe,
      () => get(projectId, reader),
      () => EMPTY,
    )
  }

  function reset(): void {
    snapshot = { storageKey: "", ids: EMPTY }
  }

  return { get, add, remove, useIds, reset }
}

const readStore = createIdSetStore((projectId, reader) =>
  ownerScopedLocalStorageKey(`aq.mention-read.v1:${projectId}:${reader}`),
)
const dismissedStore = createIdSetStore((projectId, reader) =>
  ownerScopedLocalStorageKey(`aq.mention-dismissed.v1:${projectId}:${reader}`),
)

/** Ids this reader has opened for the project. Stable until the next write. */
export function getMentionReadIds(projectId: string, reader: string): ReadonlySet<string> {
  return readStore.get(projectId, reader)
}

/** Remember these comment ids as read. Later ids win when the cap is hit. */
export function markMentionsRead(
  projectId: string,
  reader: string,
  commentIds: readonly string[],
): void {
  readStore.add(projectId, reader, commentIds)
}

/** Forget these comment ids so the notifications read as unread again. */
export function markMentionsUnread(
  projectId: string,
  reader: string,
  commentIds: readonly string[],
): void {
  readStore.remove(projectId, reader, commentIds)
}

/** Reactive read marks for one project and reader. */
export function useMentionReadIds(projectId: string, reader: string): ReadonlySet<string> {
  return readStore.useIds(projectId, reader)
}

/** Ids this reader has removed from the inbox. The comment itself stays. */
export function getMentionDismissedIds(projectId: string, reader: string): ReadonlySet<string> {
  return dismissedStore.get(projectId, reader)
}

/** Hide these notifications from the inbox on this device. */
export function dismissMentions(
  projectId: string,
  reader: string,
  commentIds: readonly string[],
): void {
  dismissedStore.add(projectId, reader, commentIds)
}

/** Put dismissed notifications back. Used by the undo toast. */
export function restoreMentions(
  projectId: string,
  reader: string,
  commentIds: readonly string[],
): void {
  dismissedStore.remove(projectId, reader, commentIds)
}

/** Reactive dismissed marks for one project and reader. */
export function useMentionDismissedIds(projectId: string, reader: string): ReadonlySet<string> {
  return dismissedStore.useIds(projectId, reader)
}

/** Test helper: drop the cached snapshots so the next read hits storage. */
export function resetMentionReadStateForTests(): void {
  readStore.reset()
  dismissedStore.reset()
}

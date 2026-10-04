/**
 * Which mention notifications this reader has already opened, on this device.
 *
 * Keyed per project and reader, then wrapped in the account-scoped storage
 * key, so one person's read marks never apply to another account on the same
 * browser. A missing, unparseable, or blocked store reads as "nothing read".
 */

import { useSyncExternalStore } from "react"
import {
  ownerScopedLocalStorageKey,
  subscribeClientLocalStorageOwner,
} from "@/lib/frontier/client-local-storage"

const MAX_READ_IDS = 400
const EMPTY: ReadonlySet<string> = new Set()

interface ReadSnapshot {
  storageKey: string
  ids: ReadonlySet<string>
}

let snapshot: ReadSnapshot = { storageKey: "", ids: EMPTY }
const listeners = new Set<() => void>()

function storageKeyFor(projectId: string, reader: string): string {
  return ownerScopedLocalStorageKey(`aq.mention-read.v1:${projectId}:${reader}`)
}

function notify(): void {
  for (const listener of listeners) listener()
}

function readIds(key: string): ReadonlySet<string> {
  if (typeof localStorage === "undefined") return EMPTY
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return EMPTY
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return EMPTY
    const ids = parsed.filter((id): id is string => typeof id === "string").slice(-MAX_READ_IDS)
    return ids.length === 0 ? EMPTY : new Set(ids)
  } catch {
    return EMPTY
  }
}

function publish(key: string, ids: ReadonlySet<string>): void {
  snapshot = { storageKey: key, ids }
  notify()
}

/** Ids this reader has opened for the project. Stable until the next write. */
export function getMentionReadIds(projectId: string, reader: string): ReadonlySet<string> {
  const key = storageKeyFor(projectId, reader)
  if (snapshot.storageKey !== key) {
    snapshot = { storageKey: key, ids: readIds(key) }
  }
  return snapshot.ids
}

/** Remember these comment ids as read. Later ids win when the cap is hit. */
export function markMentionsRead(
  projectId: string,
  reader: string,
  commentIds: readonly string[],
): void {
  if (commentIds.length === 0) return
  const key = storageKeyFor(projectId, reader)
  const next = new Set(getMentionReadIds(projectId, reader))
  let changed = false
  for (const id of commentIds) {
    if (!id || next.has(id)) continue
    next.add(id)
    changed = true
  }
  if (!changed) return
  const trimmed = [...next].slice(-MAX_READ_IDS)
  const stored = new Set(trimmed)
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.setItem(key, JSON.stringify(trimmed))
    } catch {
      // Quota or a blocked store: the in-memory snapshot still updates.
    }
  }
  publish(key, stored)
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

/** Reactive read marks for one project and reader. */
export function useMentionReadIds(projectId: string, reader: string): ReadonlySet<string> {
  return useSyncExternalStore(
    subscribe,
    () => getMentionReadIds(projectId, reader),
    () => EMPTY,
  )
}

/** Test helper: drop the cached snapshot so the next read hits storage. */
export function resetMentionReadStateForTests(): void {
  snapshot = { storageKey: "", ids: EMPTY }
}

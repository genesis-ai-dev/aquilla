// IndexedDB cache for the cells projection.
//
// Phase 1 of the cells caching plan: on file open, hydrate the rows from
// IDB so the editor paints in <50ms instead of waiting for ~60 round trips
// of `streamFileCells`. The network fetch still runs in the background and
// replaces the cached entry once it finishes, so the cache only ever shows
// rows that the server returned at some point — staleness window is bounded
// by how long the full refetch takes.
//
// Stored full-list (not deltas) so deletions and reorderings on the server
// are handled correctly by the eventual atomic swap. Phase 2 will add a
// `?since=lastEditAt` server endpoint and merge instead of replace.

import type { CellRow } from "./cells-read-types"

const DB_NAME = "aquilla-cells-cache"
const DB_VERSION = 1
const STORE = "cells"

export interface CellsCacheEntry {
  /** Composite key: `${projectId}:${fileId}`. */
  key: string
  rows: CellRow[]
  /** Max `lastEditAt` across rows — basis for the Phase 2 `since` cursor. */
  maxLastEditAt: number
  /** Wallclock of the fetch that produced this snapshot. */
  cachedAt: number
}

let dbPromise: Promise<IDBDatabase> | null = null

function cacheKey(projectId: string, fileId: string): string {
  return `${projectId}:${fileId}`
}

async function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("indexedDB unavailable"))
  }
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onerror = () => reject(req.error ?? new Error("IDB open failed"))
      req.onsuccess = () => resolve(req.result)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: "key" })
        }
      }
    })
  }
  return dbPromise
}

/** Closes the singleton connection (tests only). */
export async function resetCellsCacheConnectionForTests(): Promise<void> {
  if (!dbPromise) return
  try {
    const db = await dbPromise
    db.close()
  } catch {
    /* ignore */
  }
  dbPromise = null
}

export async function readCellsCache(
  projectId: string,
  fileId: string,
): Promise<CellsCacheEntry | null> {
  try {
    const db = await openDb()
    return await new Promise<CellsCacheEntry | null>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly")
      const store = tx.objectStore(STORE)
      const req = store.get(cacheKey(projectId, fileId))
      req.onsuccess = () => resolve((req.result as CellsCacheEntry | undefined) ?? null)
      req.onerror = () => reject(req.error ?? new Error("IDB get failed"))
    })
  } catch {
    return null
  }
}

export async function writeCellsCache(
  projectId: string,
  fileId: string,
  rows: CellRow[],
): Promise<void> {
  try {
    const db = await openDb()
    let maxLastEditAt = 0
    for (const r of rows) {
      if (r.lastEditAt > maxLastEditAt) maxLastEditAt = r.lastEditAt
    }
    const entry: CellsCacheEntry = {
      key: cacheKey(projectId, fileId),
      rows,
      maxLastEditAt,
      cachedAt: Date.now(),
    }
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite")
      tx.objectStore(STORE).put(entry)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error("IDB put failed"))
      tx.onabort = () => reject(tx.error ?? new Error("IDB put aborted"))
    })
  } catch {
    /* cache write is best-effort; a failed write must not break the load */
  }
}

/** Drop a single file's cache entry. */
export async function deleteCellsCache(
  projectId: string,
  fileId: string,
): Promise<void> {
  try {
    const db = await openDb()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite")
      tx.objectStore(STORE).delete(cacheKey(projectId, fileId))
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error("IDB delete failed"))
      tx.onabort = () => reject(tx.error ?? new Error("IDB delete aborted"))
    })
  } catch {
    /* best effort */
  }
}

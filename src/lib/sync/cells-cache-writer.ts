import type { CellsCacheEntry } from "./cells-cache"
import type { CellRow } from "./cells-read-types"

// Keep the on-disk representation unchanged: rows and their cursor commit as
// one snapshot. Large structured clones belong on a worker, not the input thread.
export const CELLS_CACHE_DB = "aquilla-cells-cache"
/** v3 (AQU-1865): sibling `cells-meta` store carrying each snapshot's size +
 *  last access, so the byte budget can be enforced without deserializing every
 *  snapshot. The upgrade drops the old store — a cold cache refetches. */
export const CELLS_CACHE_VERSION = 3
export const CELLS_CACHE_STORE = "cells"
export const CELLS_CACHE_META_STORE = "cells-meta"
export const CELLS_CACHE_BATCH_ROWS = 500

/** Fixed per-row cost: ids, event ids, flags and numbers, structured-clone tags. */
const ROW_OVERHEAD_BYTES = 256

/**
 * Approximate on-disk size of a snapshot. Deliberately approximate: an exact
 * number would cost a serialization pass as expensive as the write itself, and
 * the budget only needs to be right to within a snapshot or two. Text is counted
 * at 2 bytes/char (UTF-16, the clone's own encoding), which over-counts ASCII —
 * erring towards a smaller effective cache, never a larger one.
 */
export function estimateCellsSnapshotBytes(rows: readonly CellRow[]): number {
  let bytes = 0
  for (const row of rows) {
    bytes += ROW_OVERHEAD_BYTES
    bytes += row.value.length * 2
    if (row.valueHtml) bytes += row.valueHtml.length * 2
    if (row.transcription) bytes += row.transcription.length * 2
  }
  return bytes
}

/**
 * Commit a snapshot and its meta row in ONE transaction. Writing the two stores
 * together is what keeps the budget honest: a snapshot with no meta row is
 * invisible to eviction (unevictable, uncounted), and a meta row with no
 * snapshot makes the cache look fuller than it is.
 */
export function putCellsCacheSnapshot(db: IDBDatabase, entry: CellsCacheEntry): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([CELLS_CACHE_STORE, CELLS_CACHE_META_STORE], "readwrite")
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error("IDB put failed"))
    tx.onabort = () => reject(tx.error ?? new Error("IDB put aborted"))
    tx.objectStore(CELLS_CACHE_STORE).put(entry)
    tx.objectStore(CELLS_CACHE_META_STORE).put({
      key: entry.key,
      sizeBytes: estimateCellsSnapshotBytes(entry.rows),
      lastAccessAt: Date.now(),
    })
  })
}

export type CacheWriterMessage =
  | { type: "start"; header: Omit<CellsCacheEntry, "rows"> }
  | { type: "rows"; rows: CellsCacheEntry["rows"] }
  | { type: "commit" }

/** One writer per snapshot. Exported so tests exercise the real receiver. */
export function createCacheWriterReceiver() {
  let entry: CellsCacheEntry | undefined
  return async (message: CacheWriterMessage): Promise<void> => {
    if (message.type === "start") {
      if (entry) throw new Error("Cache snapshot already started")
      entry = { ...message.header, rows: [] }
      return
    }
    if (!entry) throw new Error("Cache snapshot not started")
    if (message.type === "rows") {
      for (const row of message.rows) entry.rows.push(row)
      return
    }
    // The caller has already opened/upgraded the DB. Never silently create
    // an empty database here if it was deleted while the worker was starting.
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(CELLS_CACHE_DB, CELLS_CACHE_VERSION)
      request.onupgradeneeded = () => request.transaction?.abort()
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error("Cache database unavailable"))
      request.onblocked = () => reject(new Error("Cache database blocked"))
    })
    try { await putCellsCacheSnapshot(db, entry) }
    finally { entry = undefined; db.close() }
  }
}


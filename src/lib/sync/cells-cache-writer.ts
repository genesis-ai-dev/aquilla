import type { CellsCacheEntry } from "./cells-cache"

// Keep the on-disk representation unchanged: rows and their cursor commit as
// one snapshot. Large structured clones belong on a worker, not the input thread.
export const CELLS_CACHE_DB = "aquilla-cells-cache"
export const CELLS_CACHE_VERSION = 2
export const CELLS_CACHE_STORE = "cells"
export const CELLS_CACHE_BATCH_ROWS = 500

export function putCellsCacheSnapshot(db: IDBDatabase, entry: CellsCacheEntry): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CELLS_CACHE_STORE, "readwrite")
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error("IDB put failed"))
    tx.onabort = () => reject(tx.error ?? new Error("IDB put aborted"))
    tx.objectStore(CELLS_CACHE_STORE).put(entry)
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


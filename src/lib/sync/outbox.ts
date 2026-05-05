/**
 * IndexedDB-backed outbox for CQRS events (Phase 2). Survives tab close;
 * drained by the flusher hook with idempotent POST /events retries.
 */

import type { CqrsRawEvent } from "./cqrs-types"

const DB_NAME = "codex-cqrs-outbox"
const DB_VERSION = 1
const STORE = "outbox"

export interface OutboxRecord {
  id: string
  enqueuedAt: number
  event: CqrsRawEvent
}

let dbPromise: Promise<IDBDatabase> | null = null

/** Closes the singleton connection (tests only). */
export async function resetOutboxConnectionForTests(): Promise<void> {
  if (!dbPromise) return
  try {
    const db = await dbPromise
    db.close()
  } catch {
    /* ignore */
  }
  dbPromise = null
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
          const store = db.createObjectStore(STORE, { keyPath: "id" })
          store.createIndex("enqueuedAt", "enqueuedAt", { unique: false })
        }
      }
    })
  }
  return dbPromise
}

export async function enqueueOutboxEvent(event: CqrsRawEvent): Promise<void> {
  const db = await openDb()
  const rec: OutboxRecord = {
    id: event.id,
    enqueuedAt: Date.now(),
    event,
  }
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite")
    tx.onerror = () => reject(tx.error ?? new Error("enqueue tx failed"))
    tx.oncomplete = () => resolve()
    tx.objectStore(STORE).put(rec)
  })
}

/** Oldest-first pending rows, at most `limit`. */
export async function peekOutboxBatch(limit: number): Promise<OutboxRecord[]> {
  try {
    const db = await openDb()
    return await new Promise((resolve, reject) => {
      const out: OutboxRecord[] = []
      const tx = db.transaction(STORE, "readonly")
      tx.onerror = () => reject(tx.error ?? new Error("peek tx failed"))
      const store = tx.objectStore(STORE)
      const idx = store.index("enqueuedAt")
      const req = idx.openCursor()
      req.onsuccess = () => {
        const cursor = req.result
        if (!cursor || out.length >= limit) {
          resolve(out)
          return
        }
        out.push(cursor.value as OutboxRecord)
        cursor.continue()
      }
    })
  } catch {
    return []
  }
}

export async function removeOutboxEvents(ids: string[]): Promise<void> {
  if (ids.length === 0) return
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite")
    tx.onerror = () => reject(tx.error ?? new Error("remove tx failed"))
    tx.oncomplete = () => resolve()
    const store = tx.objectStore(STORE)
    for (const id of ids) {
      store.delete(id)
    }
  })
}

export async function outboxPendingCount(): Promise<number> {
  try {
    const db = await openDb()
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly")
      tx.onerror = () => reject(tx.error ?? new Error("count tx failed"))
      const req = tx.objectStore(STORE).count()
      req.onsuccess = () => resolve(req.result)
    })
  } catch {
    return 0
  }
}

/**
 * Where the edit history is kept between sessions: this browser's IndexedDB,
 * one entry per (project, user). (AQU-1767 phase 2)
 *
 * Best-effort throughout, like the other local caches (export-cache.ts): a
 * history that cannot be saved or read is an empty history, never a broken
 * editor. Entries are keyed by username as well as project, and a read checks
 * both, so a browser shared by two accounts never offers one person the
 * other's steps.
 */
import type { SkipLogEntry, StepRecord } from "./history"

const DB_NAME = "aquilla-edit-history"
const DB_VERSION = 1
const STORE = "stacks"

export interface StoredHistory {
  undo: StepRecord[]
  redo: StepRecord[]
  log: SkipLogEntry[]
}

interface Row extends StoredHistory {
  key: string
  projectId: string
  username: string
  savedAt: number
}

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("indexedDB unavailable"))
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onerror = () => {
        dbPromise = null
        reject(req.error ?? new Error("IDB open failed"))
      }
      req.onsuccess = () => resolve(req.result)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "key" })
      }
    })
  }
  return dbPromise
}

const keyOf = (projectId: string, username: string) => `${projectId}\u0000${username}`

export async function loadHistory(projectId: string, username: string): Promise<StoredHistory | null> {
  try {
    const db = await openDb()
    const row = await new Promise<Row | undefined>((resolve, reject) => {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).get(keyOf(projectId, username))
      req.onsuccess = () => resolve(req.result as Row | undefined)
      req.onerror = () => reject(req.error ?? new Error("IDB get failed"))
    })
    if (!row || row.projectId !== projectId || row.username !== username) return null
    return {
      undo: Array.isArray(row.undo) ? row.undo : [],
      redo: Array.isArray(row.redo) ? row.redo : [],
      log: Array.isArray(row.log) ? row.log : [],
    }
  } catch {
    return null
  }
}

export async function saveHistory(projectId: string, username: string, value: StoredHistory): Promise<void> {
  try {
    const db = await openDb()
    // Structured clone refuses functions; steps are plain data by design, but
    // a JSON round trip makes sure nothing live slips into storage.
    const row: Row = {
      key: keyOf(projectId, username),
      projectId,
      username,
      savedAt: Date.now(),
      ...(JSON.parse(JSON.stringify(value)) as StoredHistory),
    }
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite")
      tx.objectStore(STORE).put(row)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error("IDB put failed"))
    })
  } catch {
    // Best-effort: an unsaved history is a shorter one after reload, nothing more.
  }
}

/** Tests only. */
export async function clearHistoryStoreForTests(): Promise<void> {
  try {
    const db = await openDb()
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, "readwrite")
      tx.objectStore(STORE).clear()
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
    })
  } catch {
    // nothing to clear
  }
}

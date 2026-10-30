/**
 * Where this browser keeps the edit history between sessions: IndexedDB, one
 * entry per (project, user). (AQU-1767 phase 2; per project and person since
 * decision 11 — before that, Sam's Oct 14 ruling kept one per language.) The
 * server keeps a copy too (history-remote.ts); this one is what makes the
 * history work offline and come back instantly.
 *
 * Best-effort throughout, like the other local caches (export-cache.ts): a
 * history that cannot be saved or read is an empty history, never a broken
 * editor. Entries are keyed by username as well as project, and a read checks
 * both, so a browser shared by two accounts never offers one person the
 * other's steps.
 */
import type { HistoryDoc } from "./history-merge"
import { normalizeHistoryDoc } from "./history-merge"

const DB_NAME = "aquilla-edit-history"
const DB_VERSION = 1
const STORE = "stacks"

export interface StoredHistory extends HistoryDoc {
  /** The server's revision this copy last agreed with; null = never synced. */
  revision: number | null
  /** It holds changes the server has not taken yet (made offline, say): they
   *  go after a reload even when the server's copy has not moved since. */
  unpushed?: boolean
}

interface Row extends StoredHistory {
  key: string
  projectId: string
  username: string
  /** Only on the per-language rows saved before decision 11. */
  lane?: string
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
/** The per-language rows of before decision 11 were keyed with a third part. */
const laneKeyPrefix = (projectId: string, username: string) => `${projectId}\u0000${username}\u0000`

function read<T>(db: IDBDatabase, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const req = fn(db.transaction(STORE, "readonly").objectStore(STORE))
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error("IDB read failed"))
  })
}

export async function loadHistory(projectId: string, username: string): Promise<StoredHistory | null> {
  try {
    const db = await openDb()
    const row = await read<Row | undefined>(db, (s) => s.get(keyOf(projectId, username)) as IDBRequest<Row | undefined>)
    if (!row || row.projectId !== projectId || row.username !== username || row.lane !== undefined) return null
    return {
      ...normalizeHistoryDoc(row),
      revision: typeof row.revision === "number" ? row.revision : null,
      ...(row.unpushed === true ? { unpushed: true } : {}),
    }
  } catch {
    return null
  }
}

/**
 * The per-language histories this browser saved before decision 11, for one
 * project and person. They are merged into the per-project history the first
 * time it opens here (gap 27), then removed with {@link dropLaneHistories}.
 */
export async function loadLaneHistories(
  projectId: string,
  username: string,
): Promise<Array<{ lane: string; history: HistoryDoc }>> {
  try {
    const db = await openDb()
    const prefix = laneKeyPrefix(projectId, username)
    const range = IDBKeyRange.bound(prefix, `${prefix}￿`)
    const rows = await read<Row[]>(db, (s) => s.getAll(range) as IDBRequest<Row[]>)
    return rows
      .filter((r) => r.projectId === projectId && r.username === username && typeof r.lane === "string")
      .map((r) => ({ lane: r.lane as string, history: normalizeHistoryDoc(r) }))
  } catch {
    return []
  }
}

export async function dropLaneHistories(projectId: string, username: string, lanes: readonly string[]): Promise<void> {
  if (lanes.length === 0) return
  try {
    const db = await openDb()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite")
      for (const lane of lanes) tx.objectStore(STORE).delete(`${laneKeyPrefix(projectId, username)}${lane}`)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error("IDB delete failed"))
    })
  } catch {
    // Best-effort: a leftover row is merged again next time, which changes nothing.
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

/** Tests only: write a per-language row the way builds before decision 11 did. */
export async function saveLaneHistoryForTests(projectId: string, username: string, lane: string, value: HistoryDoc): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite")
    tx.objectStore(STORE).put({
      key: `${laneKeyPrefix(projectId, username)}${lane}`,
      projectId,
      username,
      lane,
      savedAt: Date.now(),
      revision: null,
      ...(JSON.parse(JSON.stringify(value)) as HistoryDoc),
    })
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error("IDB put failed"))
  })
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

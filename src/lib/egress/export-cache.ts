// IndexedDB cache for per-project egress exports.
//
// One entry per project, latest-only (a put replaces the previous entry, so
// eviction is natural). A hit requires BOTH the freshness key (project content
// unchanged) and the options hash (same request) to match — checked by the
// caller, not here. Follows the cells-cache raw-IDB conventions: guard for
// missing indexedDB, best-effort try/catch everywhere (a cache failure must
// never break an export).

import type { EgressProjectReport } from "./types"

const DB_NAME = "aquilla-egress-cache"
const DB_VERSION = 1
const STORE = "projects"

export interface EgressCacheEntry {
  projectId: string
  /** Account that built this entry. The zip holds everything THAT user could
   *  read, so a reader must treat a username mismatch as a miss — sign-out
   *  purges the DB, but an in-place account switch (AQU-616) does not. */
  username?: string
  freshnessKey: string
  optionsHash: string
  /** The project's entries as one zip (project-relative paths, no org prefix). */
  zipBlob: Blob
  report: EgressProjectReport
  sizeBytes: number
  cachedAt: number
}

/** IDB row shape: the zip is stored as raw bytes + mime, not a Blob —
 *  structured-cloning Blobs is unsupported in fake-indexeddb (tests) and
 *  historically flaky in some browsers' IDB implementations. */
interface StoredEntry extends Omit<EgressCacheEntry, "zipBlob"> {
  zipBytes: ArrayBuffer
  zipType: string
}

let dbPromise: Promise<IDBDatabase> | null = null

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
          db.createObjectStore(STORE, { keyPath: "projectId" })
        }
      }
    })
  }
  return dbPromise
}

export async function readEgressCache(projectId: string): Promise<EgressCacheEntry | null> {
  try {
    const db = await openDb()
    const stored = await new Promise<StoredEntry | null>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly")
      const req = tx.objectStore(STORE).get(projectId)
      req.onsuccess = () => resolve((req.result as StoredEntry | undefined) ?? null)
      req.onerror = () => reject(req.error ?? new Error("IDB get failed"))
    })
    if (!stored) return null
    const { zipBytes, zipType, ...rest } = stored
    return { ...rest, zipBlob: new Blob([zipBytes], { type: zipType }) }
  } catch {
    return null
  }
}

export async function writeEgressCache(entry: EgressCacheEntry): Promise<void> {
  try {
    const { zipBlob, ...rest } = entry
    const stored: StoredEntry = {
      ...rest,
      zipBytes: await zipBlob.arrayBuffer(),
      zipType: zipBlob.type || "application/zip",
    }
    const db = await openDb()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite")
      tx.objectStore(STORE).put(stored)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error("IDB put failed"))
      tx.onabort = () => reject(tx.error ?? new Error("IDB put aborted"))
    })
  } catch {
    /* cache write is best-effort; a failed write must not break the export */
  }
}

/**
 * Drop the whole cache DB. Called on sign-out (via purgeAudioCachesOnSignOut)
 * — the zips hold everything the signed-out user could read, which must not
 * survive on shared devices. Best-effort by default; `strict` rejects when
 * the delete fails so an account transition can refuse to proceed while
 * sensitive bytes may survive (same contract as the OPFS purges).
 */
export async function purgeEgressExportCache(options: { strict?: boolean } = {}): Promise<void> {
  if (typeof indexedDB === "undefined") return
  try {
    if (dbPromise) {
      // Close the singleton first or deleteDatabase blocks on the open handle.
      try {
        ;(await dbPromise).close()
      } catch {
        /* ignore */
      }
      dbPromise = null
    }
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.deleteDatabase(DB_NAME)
      req.onsuccess = () => resolve()
      req.onerror = () => (options.strict ? reject(req.error ?? new Error("egress cache delete failed")) : resolve())
      // `blocked` still deletes once open handles close — not a failure.
      req.onblocked = () => resolve()
    })
  } catch (error) {
    if (options.strict) throw error
  }
}

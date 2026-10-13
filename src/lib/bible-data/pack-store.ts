// IndexedDB copy of the Bible Knowledge Pack (AQU-1686), so Bible data keeps
// working offline and a reload does not refetch several MB per book.
//
// Layer files are keyed `${version}/${layer}/${book}`. The pack version comes
// from the manifest, so a new version never reads an old version's file; the
// old files are pruned when a new manifest is seen. The last manifest seen
// online is kept under its own key, for offline use.
//
// Best-effort throughout, like ../understanding/passage-tag-store.ts: a
// browser with storage disabled just has no persistent cache, and every call
// resolves rather than throwing.

import { openDB, type DBSchema, type IDBPDatabase } from "idb"

export interface PackRecord {
  key: string
  /** The pack version the data belongs to. */
  version: string
  data: unknown
  storedAt: number
}

interface PackDB extends DBSchema {
  files: {
    key: string
    value: PackRecord
  }
}

const DB_NAME = "aquilla-bkp"
const DB_VERSION = 1

/** Where the last manifest seen online is kept. Never a layer key: those contain "/". */
export const MANIFEST_RECORD_KEY = "manifest"

export function packFileKey(version: string, layer: string, book: string): string {
  return `${version}/${layer}/${book}`
}

let dbPromise: Promise<IDBPDatabase<PackDB>> | null = null

function db(): Promise<IDBPDatabase<PackDB>> {
  if (!dbPromise) {
    dbPromise = openDB<PackDB>(DB_NAME, DB_VERSION, {
      upgrade(database) {
        if (!database.objectStoreNames.contains("files")) {
          database.createObjectStore("files", { keyPath: "key" })
        }
      },
    })
    // A failed open (storage disabled) is retried on the next call.
    dbPromise.catch(() => {
      dbPromise = null
    })
  }
  return dbPromise
}

export async function readPackRecord(key: string): Promise<PackRecord | undefined> {
  try {
    return await (await db()).get("files", key)
  } catch (err) {
    console.warn("[bkp-store] read failed (non-fatal):", err)
    return undefined
  }
}

export async function writePackRecord(record: PackRecord): Promise<void> {
  try {
    await (await db()).put("files", record)
  } catch (err) {
    console.warn("[bkp-store] write failed (non-fatal):", err)
  }
}

/** Delete every layer file that is not from `version`. The manifest record stays. */
export async function prunePackRecords(version: string): Promise<void> {
  try {
    const database = await db()
    const keep = `${version}/`
    const stale = (await database.getAllKeys("files")).filter(
      (key) => key !== MANIFEST_RECORD_KEY && !key.startsWith(keep),
    )
    if (stale.length === 0) return
    const tx = database.transaction("files", "readwrite")
    await Promise.all(stale.map((key) => tx.store.delete(key)))
    await tx.done
  } catch (err) {
    console.warn("[bkp-store] prune failed (non-fatal):", err)
  }
}

/** Test seam: every stored key. */
export async function __packRecordKeys(): Promise<string[]> {
  try {
    return await (await db()).getAllKeys("files")
  } catch {
    return []
  }
}

/** Test seam: empty the store. */
export async function __clearPackStore(): Promise<void> {
  try {
    await (await db()).clear("files")
  } catch {
    // No store to clear.
  }
}

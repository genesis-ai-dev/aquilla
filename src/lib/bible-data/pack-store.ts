// IndexedDB copy of the Bible Knowledge Pack (AQU-1686), so Bible data keeps
// working offline and a reload does not refetch several MB per book.
//
// Layer files are keyed `${version}/${layer}/${book}`. The pack version comes
// from the manifest, so a new version never reads an old version's file; the
// old files are pruned when a new manifest is seen. The last manifest seen
// online is kept under its own key, for offline use.
//
// AQU-1700: with the Old Testament a book's files reach about 12 MB (JER's
// text layer alone is 7.0 MB raw), so each layer keeps only the
// BOOKS_PER_LAYER books used most recently. When a file was last read or
// written is kept in a store of its own, so marking a read never rewrites a
// file of several MB.
//
// Best-effort throughout, like ../understanding/passage-tag-store.ts: a
// browser with storage disabled just has no persistent cache, and every call
// resolves rather than throwing. A write that fails (the browser's storage
// quota) leaves the file uncached: the session keeps it in memory, and the
// next session fetches it again.

import { openDB, type DBSchema, type IDBPDatabase } from "idb"

export interface PackRecord {
  key: string
  /** The pack version the data belongs to. */
  version: string
  data: unknown
  storedAt: number
}

/** When a layer file was last read or written. */
interface UsageRecord {
  key: string
  usedAt: number
}

interface PackDB extends DBSchema {
  files: {
    key: string
    value: PackRecord
  }
  usage: {
    key: string
    value: UsageRecord
  }
}

const DB_NAME = "aquilla-bkp"
/** 2 (AQU-1700): adds `usage`. A file stored before it counts as the least recently used. */
const DB_VERSION = 2

/** Books kept per layer: the ones used most recently. */
export const BOOKS_PER_LAYER = 12

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
        if (!database.objectStoreNames.contains("usage")) {
          database.createObjectStore("usage", { keyPath: "key" })
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

let lastUsedAt = 0

/** Now, but always later than the last use, so two uses in one millisecond still have an order. */
function nextUseTime(): number {
  lastUsedAt = Math.max(Date.now(), lastUsedAt + 1)
  return lastUsedAt
}

export async function readPackRecord(key: string): Promise<PackRecord | undefined> {
  let record: PackRecord | undefined
  try {
    record = await (await db()).get("files", key)
  } catch (err) {
    console.warn("[bkp-store] read failed (non-fatal):", err)
    return undefined
  }
  if (record && key !== MANIFEST_RECORD_KEY) {
    try {
      await (await db()).put("usage", { key, usedAt: nextUseTime() })
    } catch (err) {
      console.warn("[bkp-store] usage write failed (non-fatal):", err)
    }
  }
  return record
}

export async function writePackRecord(record: PackRecord): Promise<void> {
  try {
    const database = await db()
    await database.put("files", record)
    if (record.key === MANIFEST_RECORD_KEY) return
    await database.put("usage", { key: record.key, usedAt: nextUseTime() })
    await evictLeastRecentlyUsed(database, record.key)
  } catch (err) {
    console.warn("[bkp-store] write failed (non-fatal):", err)
  }
}

/** Keep the BOOKS_PER_LAYER most recently used books of `key`'s version and layer; delete the rest. */
async function evictLeastRecentlyUsed(database: IDBPDatabase<PackDB>, key: string): Promise<void> {
  const layerPrefix = key.slice(0, key.lastIndexOf("/") + 1)
  const keys = (await database.getAllKeys("files")).filter((stored) => stored.startsWith(layerPrefix))
  if (keys.length <= BOOKS_PER_LAYER) return
  const usedAt = new Map((await database.getAll("usage")).map((usage) => [usage.key, usage.usedAt]))
  const stale = keys
    .sort((a, b) => (usedAt.get(b) ?? 0) - (usedAt.get(a) ?? 0))
    .slice(BOOKS_PER_LAYER)
  await deleteFiles(database, stale)
}

async function deleteFiles(database: IDBPDatabase<PackDB>, keys: readonly string[]): Promise<void> {
  if (keys.length === 0) return
  const tx = database.transaction(["files", "usage"], "readwrite")
  const files = tx.objectStore("files")
  const usage = tx.objectStore("usage")
  await Promise.all(keys.flatMap((key) => [files.delete(key), usage.delete(key)]))
  await tx.done
}

/** Delete every layer file that is not from `version`. The manifest record stays. */
export async function prunePackRecords(version: string): Promise<void> {
  try {
    const database = await db()
    const keep = `${version}/`
    const stored = new Set([...(await database.getAllKeys("files")), ...(await database.getAllKeys("usage"))])
    await deleteFiles(
      database,
      [...stored].filter((key) => key !== MANIFEST_RECORD_KEY && !key.startsWith(keep)),
    )
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
    const database = await db()
    await database.clear("files")
    await database.clear("usage")
  } catch {
    // No store to clear.
  }
}

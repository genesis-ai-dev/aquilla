// Byte budget + LRU eviction for the cells cache (AQU-1865).
//
// The cache writes one full-row snapshot per (account, project, file) and, until
// this module, never deleted one: a consultant who opens thirty Bible files
// across ten projects kept thirty full projections on disk forever. On Safari's
// ~1 GB origin cap that is enough to start failing writes — and the failures are
// origin-wide, so the next casualty is the CQRS **outbox**, which is the one
// store whose write loss is a contributor losing an edit.
//
// So the cache gets a budget and gives bytes back:
//   * every snapshot records its approximate `sizeBytes` and `lastAccessAt`;
//   * those two fields live in a small sibling `cells-meta` store, so deciding
//     what to evict scans a few hundred bytes per file instead of deserializing
//     every 30k-row snapshot into memory;
//   * after each write the least-recently-*accessed* entries are deleted until
//     the total fits the budget (never the file being written — that would evict
//     the snapshot the open is about to need).
//
// The meta row is written and deleted in the SAME transaction as the snapshot it
// describes, so the two stores cannot disagree about what is cached.

import {
  CELLS_CACHE_META_STORE as META_STORE,
  CELLS_CACHE_STORE as STORE,
} from "./cells-cache-writer"

// The size estimate lives next to the write that records it (the snapshot and
// its meta row commit together), and is re-exported here as part of the budget
// API — sizing and evicting are one concern read from one place.
export { estimateCellsSnapshotBytes } from "./cells-cache-writer"

// Budget resolution mirrors the audio byte cache: a floor the cache is always
// allowed, a ceiling it never exceeds however roomy the disk, and a fraction of
// whatever the browser actually granted in between. The cells cache is text, so
// it is an order of magnitude smaller than the audio budget: 64 MB already holds
// a dozen whole Bibles' projections.
const FLOOR_BYTES = 64 * 1024 * 1024
const CEILING_BYTES = 512 * 1024 * 1024
const QUOTA_FRACTION = 0.1

let budgetCache: number | null = null

/** The cells cache's byte budget for this session (resolved once, memoized). */
export async function cellsCacheBudget(): Promise<number> {
  if (budgetCache != null) return budgetCache
  let budget = FLOOR_BYTES
  try {
    const quota = (await navigator.storage?.estimate?.())?.quota
    if (typeof quota === "number" && Number.isFinite(quota) && quota > 0) {
      budget = Math.min(CEILING_BYTES, Math.max(FLOOR_BYTES, Math.floor(quota * QUOTA_FRACTION)))
    }
  } catch {
    /* keep the floor */
  }
  budgetCache = budget
  return budget
}

/** @internal — test seam for the adaptive budget. */
export function __setCellsCacheBudgetForTests(bytes: number | null): void {
  budgetCache = bytes
}

export interface CellsCacheEntryMeta {
  key: string
  sizeBytes: number
  /** Epoch ms of the last read or write of this entry — the LRU ordering key. */
  lastAccessAt: number
}

/** Record a snapshot's size + access time. Call inside the snapshot's own tx. */
export function putEntryMeta(store: IDBObjectStore, meta: CellsCacheEntryMeta): void {
  store.put(meta)
}

/** Forget a snapshot's meta row. Call inside the snapshot's own delete tx. */
export function deleteEntryMeta(store: IDBObjectStore, key: string): void {
  store.delete(key)
}

function readAllMeta(db: IDBDatabase): Promise<CellsCacheEntryMeta[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(META_STORE, "readonly")
    const request = tx.objectStore(META_STORE).getAll()
    request.onsuccess = () => resolve((request.result as CellsCacheEntryMeta[]) ?? [])
    tx.onerror = () => reject(tx.error ?? new Error("cells cache meta read failed"))
    tx.onabort = () => reject(tx.error ?? new Error("cells cache meta read aborted"))
  })
}

function deleteEntries(db: IDBDatabase, keys: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE, META_STORE], "readwrite")
    const snapshots = tx.objectStore(STORE)
    const meta = tx.objectStore(META_STORE)
    for (const key of keys) {
      snapshots.delete(key)
      meta.delete(key)
    }
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error("cells cache eviction failed"))
    tx.onabort = () => reject(tx.error ?? new Error("cells cache eviction aborted"))
  })
}

/**
 * Bump one entry's `lastAccessAt` so a file the user keeps reopening outlives
 * one they imported last month. Best-effort and intentionally not awaited by
 * readers: recency is a hint, and a failed bump must never slow a file open.
 */
export async function touchEntryAccess(db: IDBDatabase, key: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(META_STORE, "readwrite")
    const store = tx.objectStore(META_STORE)
    const request = store.get(key)
    request.onsuccess = () => {
      const meta = request.result as CellsCacheEntryMeta | undefined
      // No meta row means no snapshot (or one from before this version). Writing
      // one here would invent a cache entry the budget then tries to evict.
      if (meta) store.put({ ...meta, lastAccessAt: Date.now() })
    }
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error("cells cache touch failed"))
    tx.onabort = () => reject(tx.error ?? new Error("cells cache touch aborted"))
  })
}

/**
 * Delete least-recently-accessed snapshots until the cache fits `targetBytes`.
 * `keepKey` is never evicted: it is the snapshot the current file open depends
 * on, and shedding it would turn a budget overrun into a cache miss on the very
 * file the user is looking at.
 *
 * Returns the number of bytes reclaimed.
 */
export async function evictCellsCacheTo(
  db: IDBDatabase,
  targetBytes: number,
  keepKey?: string,
): Promise<number> {
  const all = await readAllMeta(db)
  let total = 0
  for (const meta of all) total += meta.sizeBytes
  if (total <= targetBytes) return 0

  const evictable = all
    .filter((meta) => meta.key !== keepKey)
    .sort((a, b) => a.lastAccessAt - b.lastAccessAt)

  const doomed: string[] = []
  let reclaimed = 0
  for (const meta of evictable) {
    if (total - reclaimed <= targetBytes) break
    doomed.push(meta.key)
    reclaimed += meta.sizeBytes
  }
  if (doomed.length === 0) return 0
  await deleteEntries(db, doomed)
  return reclaimed
}

/** Hold the cache to its budget. Called after every snapshot write. */
export async function enforceCellsCacheBudget(
  db: IDBDatabase,
  keepKey?: string,
): Promise<number> {
  return evictCellsCacheTo(db, await cellsCacheBudget(), keepKey)
}

/**
 * Give the origin its bytes back, now: drop every cached snapshot. Used when a
 * write — this cache's or the outbox's — has already failed for want of space.
 * The cache is a latency optimisation; a queued edit is not.
 */
export async function clearCellsCacheForQuota(db: IDBDatabase): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([STORE, META_STORE], "readwrite")
    tx.objectStore(STORE).clear()
    tx.objectStore(META_STORE).clear()
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error("cells cache clear failed"))
    tx.onabort = () => reject(tx.error ?? new Error("cells cache clear aborted"))
  })
}

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
// are handled correctly by the eventual atomic swap.
//
// Phase 2 (audit M2-1): the entry also carries `maxServerSeq` — the file's
// event-log watermark at snapshot time. On reopen/focus the client sends ONE
// `?since=<maxServerSeq>` request; the server answers with just the changed
// cells (deletions = changed ids with no row), which `mergeCellsDelta` folds
// into the cached rows, re-running the anchor-chain walk so the merged order
// is identical to a full read. Full streams remain the fallback for cache
// misses, entries predating this field, and `resync` responses.

import type { CellRow } from "./cells-read-types"

const DB_NAME = "aquilla-cells-cache"
const DB_VERSION = 2
const STORE = "cells"

export interface CellsCacheEntry {
  /** Composite key: `${projectId}:${fileId}`. */
  key: string
  rows: CellRow[]
  /** Max `lastEditAt` across rows. Superseded by `maxServerSeq` as the delta
   *  cursor (wall clocks regress; server_seq is the ordering key) — kept for
   *  entry-shape compatibility. */
  maxLastEditAt: number
  /** Wallclock of the fetch that produced this snapshot. */
  cachedAt: number
  /** MAX(server_seq) over the file's events at snapshot time — the `?since=`
   *  cursor. Absent on entries written before M2-1 → full-stream fallback. */
  maxServerSeq?: number
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
      req.onupgradeneeded = (event) => {
        const db = req.result
        const oldVersion = event.oldVersion
        if (oldVersion > 0 && oldVersion < DB_VERSION && db.objectStoreNames.contains(STORE)) {
          db.deleteObjectStore(STORE)
        }
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
  maxServerSeq?: number,
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
      ...(maxServerSeq !== undefined ? { maxServerSeq } : {}),
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

/**
 * Walk the anchor chain for one side — client mirror of the server's
 * `walkAnchorChain` in sync-worker/src/events/cells-read-route.ts, over the
 * camelCase `CellRow` shape. Head = `anchorCellId == null`; siblings claiming
 * the same anchor tiebreak by `eventId` lex order; orphans (anchor missing on
 * this side, or isolated by a cycle) append at the tail in `eventId` order.
 *
 * Keeping the two walks identical is what makes a delta merge order-stable:
 * re-walking the merged set here yields the same order a full server read
 * would have returned.
 */
function walkAnchorChain(rows: CellRow[]): CellRow[] {
  if (rows.length === 0) return []

  const byAnchor = new Map<string, CellRow[]>()
  for (const r of rows) {
    const key = r.anchorCellId ?? ""
    let bucket = byAnchor.get(key)
    if (!bucket) {
      bucket = []
      byAnchor.set(key, bucket)
    }
    bucket.push(r)
  }
  for (const bucket of byAnchor.values()) {
    bucket.sort((a, b) => (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0))
  }

  const ordered: CellRow[] = []
  const visited = new Set<string>()
  type Frame = { key: string; i: number }
  const stack: Frame[] = [{ key: "", i: 0 }]
  while (stack.length > 0) {
    const top = stack[stack.length - 1]
    const children = byAnchor.get(top.key)
    if (!children || top.i >= children.length) {
      stack.pop()
      continue
    }
    const child = children[top.i]
    top.i++
    if (visited.has(child.cellId)) continue
    visited.add(child.cellId)
    ordered.push(child)
    stack.push({ key: child.cellId, i: 0 })
  }

  if (visited.size < rows.length) {
    const orphans: CellRow[] = []
    for (const r of rows) {
      if (!visited.has(r.cellId)) orphans.push(r)
    }
    orphans.sort((a, b) => (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0))
    ordered.push(...orphans)
  }

  return ordered
}

/**
 * Fold a `?since=` delta into a cached row set (audit M2-1).
 *
 * Semantics: `changedCellIds` lists every cell touched by an event past the
 * cursor; `deltaRows` carries those cells' CURRENT rows. A changed id with no
 * delta row was deleted. Every cached row of a changed cell is dropped before
 * the delta rows land, so per-side deletions and re-creates resolve to the
 * server's current truth — never a stale union.
 *
 * Ordering: re-parents arrive as changed rows with new `anchorCellId`s, so
 * the whole merged set is re-walked per side (source chain first, then
 * target — the full-read shape). `joinSourceAndTarget` in useCells only
 * depends on per-side order, so either inter-side layout is equivalent.
 */
export function mergeCellsDelta(
  cached: CellRow[],
  changedCellIds: string[],
  deltaRows: CellRow[],
): CellRow[] {
  const changed = new Set(changedCellIds)
  const source: CellRow[] = []
  const target: CellRow[] = []
  const push = (r: CellRow) => {
    if (r.side === "source") source.push(r)
    else if (r.side === "target") target.push(r)
  }
  for (const r of cached) {
    if (!changed.has(r.cellId)) push(r)
  }
  for (const r of deltaRows) push(r)
  return [...walkAnchorChain(source), ...walkAnchorChain(target)]
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

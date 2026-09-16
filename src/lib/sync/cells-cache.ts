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
export const CELLS_CACHE_WRITE_DEBOUNCE_MS = 500

// The database is shared by every account on this browser origin. Prefixing
// keys with the hydrated account prevents a newly-active identity from ever
// painting another account's rows while its authoritative fetch is in flight.
// `undefined` preserves the legacy key shape in focused tests and before the
// app has made its first session decision; the app sets this before rendering
// account-scoped routes.
let activeOwnerKey: string | null | undefined

export function setCellsCacheOwner(ownerKey: string | null): void {
  activeOwnerKey = ownerKey
}

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
  /** AQU-943: the project incarnation `maxServerSeq` was minted against,
   *  echoed as `?epoch=` so the server can tell a cursor from a WIPED-AND-
   *  RE-CREATED project (whose allocator restarted, inverting the cursor)
   *  from a live one. Absent on entries written before AQU-943 — those
   *  cursors are unverifiable, so callers take the full-stream fallback once
   *  rather than trusting a delta against an unknown incarnation. */
  projectEpoch?: number
}

let dbPromise: Promise<IDBDatabase> | null = null

interface PendingCellsCacheWrite {
  entryKey: string
  projectId: string
  fileId: string
  rows: CellRow[]
  maxServerSeq?: number
  projectEpoch?: number
  timer: ReturnType<typeof setTimeout> | null
}

interface InFlightCellsCacheWrite {
  projectId: string
  fileId: string
  promise: Promise<void>
}

const pendingWrites = new Map<string, PendingCellsCacheWrite>()
const inFlightWrites = new Map<string, InFlightCellsCacheWrite>()

function cacheKey(projectId: string, fileId: string): string {
  const legacy = `${projectId}:${fileId}`
  if (activeOwnerKey === undefined) return legacy
  return scopedCacheKey(activeOwnerKey, legacy)
}

function scopedCacheKey(ownerKey: string | null, legacyKey: string): string {
  const owner = ownerKey === null
    ? "local"
    : `account:${encodeURIComponent(ownerKey)}`
  return `owner:${owner}:${legacyKey}`
}

function isScopedCacheKey(storageKey: string): boolean {
  return storageKey.startsWith("owner:local:") || storageKey.startsWith("owner:account:")
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
  activeOwnerKey = undefined
  for (const pending of pendingWrites.values()) {
    if (pending.timer !== null) clearTimeout(pending.timer)
  }
  pendingWrites.clear()
  const writes = [...inFlightWrites.values()].map(({ promise }) => promise)
  await Promise.allSettled(writes)
  inFlightWrites.clear()
  if (!dbPromise) return
  try {
    const db = await dbPromise
    db.close()
  } catch {
    /* ignore */
  }
  dbPromise = null
}

/**
 * One-time upgrade bridge for pre-account cache keys. The first resolved data
 * owner receives the legacy snapshots, preserving warm/offline file opens
 * without leaving an unscoped copy another account could later claim.
 */
export async function claimLegacyCellsCache(ownerKey: string | null): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite")
    const store = tx.objectStore(STORE)
    const request = store.openCursor()
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error("legacy cells cache claim failed"))
    tx.onabort = () => reject(tx.error ?? new Error("legacy cells cache claim aborted"))
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) return
      const entry = cursor.value as CellsCacheEntry
      if (!isScopedCacheKey(entry.key)) {
        const targetKey = scopedCacheKey(ownerKey, entry.key)
        const existing = store.get(targetKey)
        existing.onsuccess = () => {
          // A scoped write can race the one-time upgrade. Keep that newer,
          // explicitly-owned snapshot and only discard the obsolete legacy key.
          if (existing.result === undefined) store.put({ ...entry, key: targetKey })
          cursor.delete()
          cursor.continue()
        }
        return
      }
      cursor.continue()
    }
  })
}

export async function readCellsCache(
  projectId: string,
  fileId: string,
): Promise<CellsCacheEntry | null> {
  const entryKey = cacheKey(projectId, fileId)
  try {
    const db = await openDb()
    return await new Promise<CellsCacheEntry | null>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly")
      const store = tx.objectStore(STORE)
      const req = store.get(entryKey)
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
  projectEpoch?: number,
): Promise<void> {
  // Capture the identity namespace before the first await. An IndexedDB open
  // can settle after an account switch; recomputing then would write the old
  // request's rows into the newly-active account's key.
  const entryKey = cacheKey(projectId, fileId)
  try {
    await putCellsCacheEntry({
      entryKey,
      projectId,
      fileId,
      rows,
      maxServerSeq,
      projectEpoch,
      timer: null,
    })
  } catch {
    /* cache write is best-effort; a failed write must not break the load */
  }
}

async function putCellsCacheEntry(
  pending: PendingCellsCacheWrite,
): Promise<void> {
  const db = await openDb()
  let maxLastEditAt = 0
  for (const row of pending.rows) {
    if (row.lastEditAt > maxLastEditAt) maxLastEditAt = row.lastEditAt
  }
  const entry: CellsCacheEntry = {
    key: pending.entryKey,
    rows: pending.rows,
    maxLastEditAt,
    cachedAt: Date.now(),
    ...(pending.maxServerSeq !== undefined
      ? { maxServerSeq: pending.maxServerSeq }
      : {}),
    ...(pending.projectEpoch !== undefined && pending.projectEpoch !== null
      ? { projectEpoch: pending.projectEpoch }
      : {}),
  }
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite")
    tx.objectStore(STORE).put(entry)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error("IDB put failed"))
    tx.onabort = () => reject(tx.error ?? new Error("IDB put aborted"))
  })
}

/**
 * Queue a full cache snapshot for a trailing write. Repeated writes for the
 * same owner/project/file replace the whole pending tuple, including its
 * cursor. A lower or absent cursor can be intentional, so fields are never
 * merged independently.
 */
export function scheduleCellsCacheWrite(
  projectId: string,
  fileId: string,
  rows: CellRow[],
  maxServerSeq?: number,
  projectEpoch?: number,
): void {
  // Capture the owner-scoped key now. The active account can change before
  // the timer fires, and old rows must never land in the new account's key.
  const entryKey = cacheKey(projectId, fileId)
  const previous = pendingWrites.get(entryKey)
  if (previous?.timer != null) {
    clearTimeout(previous.timer)
  }

  const pending: PendingCellsCacheWrite = {
    entryKey,
    projectId,
    fileId,
    // useCells mutates its rows array in place. Keep the row objects, which
    // callers replace immutably, but detach the queued list from later edits.
    rows: rows.slice(),
    maxServerSeq,
    projectEpoch,
    timer: null,
  }
  pending.timer = setTimeout(() => {
    pending.timer = null
    void flushCellsCacheWriteKeys([entryKey])
  }, CELLS_CACHE_WRITE_DEBOUNCE_MS)
  pendingWrites.set(entryKey, pending)
}

async function writePendingSnapshot(
  pending: PendingCellsCacheWrite,
): Promise<void> {
  const previous = inFlightWrites.get(pending.entryKey)?.promise
  const promise = (previous ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => putCellsCacheEntry(pending))
  inFlightWrites.set(pending.entryKey, {
    projectId: pending.projectId,
    fileId: pending.fileId,
    promise,
  })
  try {
    await promise
  } catch {
    // The cache is best effort. A later pending snapshot still drains below.
  } finally {
    if (inFlightWrites.get(pending.entryKey)?.promise === promise) {
      inFlightWrites.delete(pending.entryKey)
    }
  }
}

async function flushCellsCacheWriteKeys(
  entryKeys: Iterable<string>,
): Promise<void> {
  await Promise.all([...entryKeys].map(async (entryKey) => {
    while (true) {
      const pending = pendingWrites.get(entryKey)
      if (pending) {
        if (pending.timer !== null) clearTimeout(pending.timer)
        pendingWrites.delete(entryKey)
        await writePendingSnapshot(pending)
        continue
      }
      const inFlight = inFlightWrites.get(entryKey)?.promise
      if (inFlight) await inFlight.catch(() => undefined)
      if (!pendingWrites.has(entryKey)) return
    }
  }))
}

/** Flush one file's queued snapshots, or every file when called without ids. */
export async function flushCellsCacheWrites(
  projectId?: string,
  fileId?: string,
): Promise<void> {
  const flushAll = projectId === undefined && fileId === undefined
  if (!flushAll && (projectId === undefined || fileId === undefined)) return

  const entryKeys = new Set<string>()
  for (const [entryKey, pending] of pendingWrites) {
    if (
      flushAll
      || (pending.projectId === projectId && pending.fileId === fileId)
    ) {
      entryKeys.add(entryKey)
    }
  }
  for (const [entryKey, inFlight] of inFlightWrites) {
    if (
      flushAll
      || (inFlight.projectId === projectId && inFlight.fileId === fileId)
    ) {
      entryKeys.add(entryKey)
    }
  }
  await flushCellsCacheWriteKeys(entryKeys)
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
/** Exported for CellStore.resortSourceOrderByChain (AQU-1068), which needs the
 *  same walk after a collaborator's insert arrives through a targeted read. */
export function walkAnchorChain(rows: CellRow[]): CellRow[] {
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
 *
 * AQU-538: the walk dedupes by cellId, so N target lanes for the same cell
 * must be walked PER LANE — exactly like the server's read route — or a
 * sibling lane's row is silently dropped from the merged set. That drop was
 * the "lane translation disappears on reload" bug: the boot delta returned
 * both lanes' target rows, and the lane-blind target walk kept only one.
 * Default lane ('') first, then added lanes in name order — for N=1 the
 * output is byte-identical to the single-bucket walk.
 */
export function mergeCellsDelta(
  cached: CellRow[],
  changedCellIds: string[],
  deltaRows: CellRow[],
): CellRow[] {
  const changed = new Set(changedCellIds)
  const source: CellRow[] = []
  const targetByLane = new Map<string, CellRow[]>()
  const push = (r: CellRow) => {
    if (r.side === "source") {
      source.push(r)
    } else if (r.side === "target") {
      const lane = r.targetLang ?? ""
      let bucket = targetByLane.get(lane)
      if (!bucket) {
        bucket = []
        targetByLane.set(lane, bucket)
      }
      bucket.push(r)
    }
  }
  for (const r of cached) {
    if (!changed.has(r.cellId)) push(r)
  }
  for (const r of deltaRows) push(r)
  const ordered = walkAnchorChain(source)
  for (const lane of [...targetByLane.keys()].sort()) {
    ordered.push(...walkAnchorChain(targetByLane.get(lane)!))
  }
  return ordered
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

// Per-seam cache and drafting-unit lookup for the SPA (AQU-1386).
//
// Two jobs, deliberately separated:
//
//   draftingUnitsFor()  — SYNCHRONOUS, on the drafting hot path. It never
//                         fetches and never awaits. Seams it has answers for
//                         use them; seams it does not fall back to punctuation.
//                         Drafting therefore adds ZERO latency whether or not
//                         classification has run, which is what makes it safe
//                         to leave classification entirely best-effort.
//
//   ensureSeamsForFile() — ASYNCHRONOUS, off the hot path (file open, or after
//                         import). Classifies only the seams that are missing,
//                         in windows, and writes them through to IndexedDB.
//
// Invalidation is structural, not procedural. A seam is keyed on the
// `sourceEventId` of the cells on either side of it (see seamKey), so editing
// one source cell mints a new event id and the two keys that mention it stop
// matching. Nothing sweeps, nothing expires, and no other seam in the file is
// disturbed. A cell with no source event yet is simply not cacheable.

import { openDB, type DBSchema, type IDBPDatabase } from "idb"
import {
  combineSeam,
  deriveDraftingUnits,
  seamKey,
  type DraftingUnit,
  type SeamCell,
  type SeamDecision,
} from "./seams"
import { MAX_SEAMS_PER_REQUEST, type SeamWindowCell } from "./seam-request"

/** What the cache stores and what the route returns, minus the cell ids —
 *  those live in the key. */
export interface CachedSeam extends SeamDecision {
  cachedAt: number
}

interface SeamDB extends DBSchema {
  seams: {
    key: string
    value: CachedSeam & { key: string }
  }
}

const DB_NAME = "aquilla-seams"
const DB_VERSION = 1

let dbPromise: Promise<IDBPDatabase<SeamDB>> | null = null

function db(): Promise<IDBPDatabase<SeamDB>> {
  if (!dbPromise) {
    dbPromise = openDB<SeamDB>(DB_NAME, DB_VERSION, {
      upgrade(database) {
        if (!database.objectStoreNames.contains("seams")) {
          database.createObjectStore("seams", { keyPath: "key" })
        }
      },
    })
  }
  return dbPromise
}

/**
 * Memory mirror of the IDB store. The hot path reads THIS, synchronously —
 * an async read on every draft would reintroduce the latency the cache exists
 * to remove, and `deriveDraftingUnits` is a pure synchronous walk.
 */
const memory = new Map<string, CachedSeam>()

/**
 * Test seam: drop the MEMORY mirror only, leaving IndexedDB intact. This is
 * also what a page reload looks like, which is why the two resets are separate
 * — a test that clears both cannot tell a working persistence layer from a
 * broken one.
 */
export function __resetSeamCache(): void {
  memory.clear()
}

/** Test seam: drop the persisted store as well. */
export async function __clearPersistedSeams(): Promise<void> {
  memory.clear()
  try {
    const database = await db()
    await database.clear("seams")
  } catch {
    // No store to clear — nothing to do.
  }
}

export function getCachedSeam(key: string): CachedSeam | undefined {
  return memory.get(key)
}

/**
 * Warm the memory mirror from IndexedDB for a specific set of seams.
 * Best-effort: a browser with storage disabled just keeps an empty mirror and
 * everything falls back to punctuation.
 */
export async function hydrateSeams(keys: readonly string[]): Promise<void> {
  const missing = keys.filter((k) => !memory.has(k))
  if (missing.length === 0) return
  try {
    const database = await db()
    const tx = database.transaction("seams", "readonly")
    const rows = await Promise.all(missing.map((k) => tx.store.get(k)))
    await tx.done
    for (const row of rows) {
      if (row) memory.set(row.key, row)
    }
  } catch (err) {
    console.warn("[seam-store] hydrate failed (non-fatal):", err)
  }
}

async function persist(entries: [string, CachedSeam][]): Promise<void> {
  if (entries.length === 0) return
  try {
    const database = await db()
    const tx = database.transaction("seams", "readwrite")
    await Promise.all(entries.map(([key, value]) => tx.store.put({ ...value, key })))
    await tx.done
  } catch (err) {
    console.warn("[seam-store] persist failed (non-fatal):", err)
  }
}

// ---------------------------------------------------------------------------
// The hot path
// ---------------------------------------------------------------------------

/** The subset of a cell this module needs. `text` is the EFFECTIVE source (the
 *  caller has already resolved transcripts for media cells). */
export interface SeamStoreCell extends SeamCell {
  text: string
  ref?: string | null
  style?: string | null
}

/**
 * Derive drafting units for an ordered cell list, synchronously, from whatever
 * is cached.
 *
 * Every uncached seam resolves through `combineSeam(null, …)` — the punctuation
 * heuristic — so this returns sensible units on a cold cache, on a browser with
 * IndexedDB blocked, and while classification is still in flight. There is no
 * loading state because there is nothing to wait for.
 */
export function draftingUnitsFor(cells: readonly SeamStoreCell[]): DraftingUnit[] {
  const textById = new Map(cells.map((c) => [c.id, c.text]))
  return deriveDraftingUnits(cells, (prev, next) => {
    const key = seamKey(prev.sourceEventId, next.sourceEventId)
    const cached = key ? memory.get(key) : undefined
    if (cached) return cached
    return combineSeam(null, textById.get(prev.id) ?? "")
  })
}

// ---------------------------------------------------------------------------
// Off the hot path
// ---------------------------------------------------------------------------

/** One window's worth of classification, as the route returns it. */
export interface ClassifiedSeam extends SeamDecision {
  prevCellId: string
  nextCellId: string
}

export type SeamClassifier = (
  window: SeamWindowCell[],
) => Promise<ClassifiedSeam[]>

/**
 * Classify the seams of a file that are not already cached, and cache them.
 *
 * Windowing carries ONE cell of overlap between windows so no seam is lost at a
 * window edge, and skips a window entirely when every seam in it is already
 * cached — reopening an unchanged file costs nothing, and a file where one cell
 * was edited re-classifies only the window holding it.
 *
 * Resolves quietly on any failure. Nothing downstream branches on it.
 */
export async function ensureSeamsForFile(
  cells: readonly SeamStoreCell[],
  classify: SeamClassifier,
): Promise<void> {
  if (cells.length < 2) return

  const keys: (string | null)[] = []
  for (let i = 0; i < cells.length - 1; i++) {
    keys.push(seamKey(cells[i].sourceEventId, cells[i + 1].sourceEventId))
  }
  await hydrateSeams(keys.filter((k): k is string => k !== null))

  // Windows of cells; a window of N cells covers N-1 seams.
  const windowCells = MAX_SEAMS_PER_REQUEST + 1
  for (let start = 0; start < cells.length - 1; start += windowCells - 1) {
    const slice = cells.slice(start, start + windowCells)
    if (slice.length < 2) break

    // Skip a window whose every seam is already answered. An unkeyable seam
    // (no source event id) can never be cached, so it is not a reason to spend
    // a call on the window either.
    const needed = slice.slice(0, -1).some((_, i) => {
      const key = keys[start + i]
      return key !== null && !memory.has(key)
    })
    if (!needed) continue

    try {
      const classified = await classify(
        slice.map((c) => ({ id: c.id, text: c.text, ref: c.ref ?? null, style: c.style ?? null })),
      )
      const byId = new Map(slice.map((c) => [c.id, c]))
      const writes: [string, CachedSeam][] = []
      for (const seam of classified) {
        const prev = byId.get(seam.prevCellId)
        const next = byId.get(seam.nextCellId)
        const key = seamKey(prev?.sourceEventId, next?.sourceEventId)
        if (!key) continue
        const entry: CachedSeam = { ...seam, cachedAt: Date.now() }
        memory.set(key, entry)
        writes.push([key, entry])
      }
      await persist(writes)
    } catch (err) {
      console.warn("[seam-store] classification failed (non-fatal):", err)
      return
    }
  }
}

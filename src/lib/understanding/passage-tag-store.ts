// Per-node tag cache for the SPA (AQU-657, slice 1).
//
// This is the "persistent tree of understanding" the ticket asks for: the tags
// themselves live in ./passage-tags.ts, the spine they hang on comes from
// AQU-1387, and this module is what makes the pair survive a reload without
// re-asking. Two jobs, deliberately separated — the same split as
// ../completion/seam-store.ts:
//
//   tagsFor()               — SYNCHRONOUS. Never fetches, never awaits. Nodes it
//                             has answers for use them; nodes it does not fall
//                             back to the lexical heuristic. A reader therefore
//                             adds ZERO latency whether or not tagging has run,
//                             which is what makes it safe to leave tagging
//                             entirely best-effort.
//
//   ensureTagsForPassages() — ASYNCHRONOUS, off any hot path (after import, or
//                             when a file's spine is built). Tags only the nodes
//                             that are missing, in windows, and writes them
//                             through to IndexedDB.
//
// Invalidation is structural, not procedural. A node is keyed on the source
// events it covers AND the candidates it was asked about (see passageTagKey), so
// editing a cell inside a passage, or growing the book's cast, stops that node's
// key matching while every other node in the file still hits. Nothing sweeps and
// nothing expires.

import { openDB, type DBSchema, type IDBPDatabase } from "idb"
import {
  combinePassageTags,
  passageTagKey,
  type PassageTagNode,
  type PassageTags,
  type TagCandidates,
} from "./passage-tags"
import { tagWindows, type TaggedNodeRequest } from "./passage-tag-request"

/** What the cache stores: the tags, plus when they were written. */
export interface CachedPassageTags extends PassageTags {
  cachedAt: number
}

interface PassageTagDB extends DBSchema {
  tags: {
    key: string
    value: CachedPassageTags & { key: string }
  }
}

const DB_NAME = "aquilla-passage-tags"
const DB_VERSION = 1

let dbPromise: Promise<IDBPDatabase<PassageTagDB>> | null = null

function db(): Promise<IDBPDatabase<PassageTagDB>> {
  if (!dbPromise) {
    dbPromise = openDB<PassageTagDB>(DB_NAME, DB_VERSION, {
      upgrade(database) {
        if (!database.objectStoreNames.contains("tags")) {
          database.createObjectStore("tags", { keyPath: "key" })
        }
      },
    })
  }
  return dbPromise
}

/** Memory mirror of the IDB store, read synchronously by `tagsFor`. */
const memory = new Map<string, CachedPassageTags>()

/**
 * Test seam: drop the MEMORY mirror only, leaving IndexedDB intact — which is
 * also what a page reload looks like. Kept separate from the clear below so a
 * test that empties both cannot tell a working persistence layer from a broken
 * one.
 */
export function __resetPassageTagCache(): void {
  memory.clear()
}

/** Test seam: drop the persisted store as well. */
export async function __clearPersistedPassageTags(): Promise<void> {
  memory.clear()
  try {
    const database = await db()
    await database.clear("tags")
  } catch {
    // No store to clear — nothing to do.
  }
}

export function getCachedPassageTags(key: string): CachedPassageTags | undefined {
  return memory.get(key)
}

/**
 * One node as this module needs it: the node itself, the candidates it is asked
 * about, and the source events it covers (its cache key's content address).
 */
export interface PassageTagStoreNode extends TaggedNodeRequest {
  /** `sourceEventId` of every cell the passage covers, in file order. */
  sourceEventIds: readonly (string | null | undefined)[]
}

function keyFor(entry: PassageTagStoreNode): string | null {
  return passageTagKey(entry.node.key, entry.sourceEventIds, entry.candidates)
}

/**
 * Warm the memory mirror from IndexedDB for a specific set of nodes.
 * Best-effort: a browser with storage disabled just keeps an empty mirror and
 * every node falls back to the heuristic.
 */
export async function hydratePassageTags(keys: readonly string[]): Promise<void> {
  const missing = keys.filter((key) => !memory.has(key))
  if (missing.length === 0) return
  try {
    const database = await db()
    const tx = database.transaction("tags", "readonly")
    const rows = await Promise.all(missing.map((key) => tx.store.get(key)))
    await tx.done
    for (const row of rows) {
      if (row) memory.set(row.key, row)
    }
  } catch (err) {
    console.warn("[passage-tag-store] hydrate failed (non-fatal):", err)
  }
}

async function persist(entries: [string, CachedPassageTags][]): Promise<void> {
  if (entries.length === 0) return
  try {
    const database = await db()
    const tx = database.transaction("tags", "readwrite")
    await Promise.all(entries.map(([key, value]) => tx.store.put({ ...value, key })))
    await tx.done
  } catch (err) {
    console.warn("[passage-tag-store] persist failed (non-fatal):", err)
  }
}

// ---------------------------------------------------------------------------
// The synchronous read
// ---------------------------------------------------------------------------

/**
 * Tags for an ordered node list, synchronously, from whatever is cached.
 *
 * Every uncached node resolves through `combinePassageTags(…, null)` — the
 * lexical heuristic — so this returns a usable tree on a cold cache, on a
 * browser with IndexedDB blocked, and while tagging is still in flight. There is
 * no loading state because there is nothing to wait for.
 */
export function tagsFor(nodes: readonly PassageTagStoreNode[]): PassageTags[] {
  return nodes.map((entry, index) => {
    const key = keyFor(entry)
    const cached = key ? memory.get(key) : undefined
    if (cached) return cached
    return combinePassageTags(
      entry.node,
      nodes[index - 1]?.node ?? null,
      entry.candidates,
      null,
    )
  })
}

/** Tags for one node by key, or undefined when nothing is cached for it. */
export function cachedTagsForNode(entry: PassageTagStoreNode): PassageTags | undefined {
  const key = keyFor(entry)
  return key ? memory.get(key) : undefined
}

// ---------------------------------------------------------------------------
// Off the hot path
// ---------------------------------------------------------------------------

export type PassageTagClassifier = (
  window: readonly TaggedNodeRequest[],
) => Promise<PassageTags[]>

/**
 * Tag the nodes of a file that are not already cached, and cache them.
 *
 * Windowing carries ONE node of overlap between windows, because `scene_change`
 * is a question about a node and its predecessor: without the overlap the first
 * node of every window would be asked about a scene it could not see, and the
 * request builder would (correctly) decline to ask at all. The file's very first
 * node is the one node with no predecessor by nature.
 *
 * A window whose every node is already cached is skipped entirely, so reopening
 * an unchanged file costs nothing and a file with one edited passage re-tags only
 * the window holding it.
 *
 * Resolves quietly on any failure. Nothing downstream branches on it.
 */
export async function ensureTagsForPassages(
  nodes: readonly PassageTagStoreNode[],
  classify: PassageTagClassifier,
): Promise<void> {
  if (nodes.length === 0) return

  const keys = nodes.map(keyFor)
  await hydratePassageTags(keys.filter((key): key is string => key !== null))

  for (const { from, to } of tagWindows(nodes.length)) {
    const slice = nodes.slice(from, to)
    if (slice.length === 0) continue

    // An unkeyable node (a cell with no source event yet) can never be cached,
    // so it is not a reason to spend a call on the window either.
    const needed = slice.some((_, offset) => {
      const key = keys[from + offset]
      return key !== null && !memory.has(key)
    })
    if (!needed) continue

    try {
      const tagged = await classify(
        slice.map(({ node, candidates }) => ({ node, candidates })),
      )
      const entryByNodeKey = new Map(slice.map((entry) => [entry.node.key, entry]))
      const writes: [string, CachedPassageTags][] = []
      for (const tags of tagged) {
        const entry = entryByNodeKey.get(tags.nodeKey)
        if (!entry) continue
        const key = keyFor(entry)
        if (!key) continue
        const cached: CachedPassageTags = { ...tags, cachedAt: Date.now() }
        memory.set(key, cached)
        writes.push([key, cached])
      }
      await persist(writes)
    } catch (err) {
      console.warn("[passage-tag-store] tagging failed (non-fatal):", err)
      return
    }
  }
}

/** Convenience for callers that hold the spine and a cast: pair each node with
 *  its candidates and covered source events in one place. */
export function toStoreNodes(
  nodes: readonly PassageTagNode[],
  sourceEventIdsFor: (node: PassageTagNode) => readonly (string | null | undefined)[],
  candidatesFor: (node: PassageTagNode) => TagCandidates,
): PassageTagStoreNode[] {
  return nodes.map((node) => ({
    node,
    candidates: candidatesFor(node),
    sourceEventIds: sourceEventIdsFor(node),
  }))
}

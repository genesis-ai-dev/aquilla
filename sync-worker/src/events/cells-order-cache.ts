// AQU-1885: the colo-shared tier of the paged-cell-read ordering cache.
//
// AQU-1160 remembers a file's walked anchor-chain order (the ordered list of
// (cell, side, lane) slots) so only the FIRST page of a stream pays the
// full-file walk. AQU-1841 pinned that ordering into the pagination cursor so
// a peer commit mid-stream no longer moves the key. Both of those live in one
// isolate-local `Map`: when a later page of the same stream lands on a
// different Worker isolate, the pin names an ordering that isolate does not
// hold, the read falls back to the full-file walk, and the stream tears (it
// has to re-advertise the live watermark).
//
// This module adds the second tier the AQU-1885 ticket costed as the cheap
// interim: the same ordered list, under the SAME key, in the colo-shared
// Workers Cache API. Every isolate in the colo serving the client's pages
// therefore reaches the ordering the stream's first page built, with no schema
// change and no write-path work.
//
// What it is NOT: a durable sort index. A page landing in a different COLO
// still walks (once), and the entry is evictable at any time. Correctness
// never depends on a hit — a miss is exactly the pre-AQU-1160 full walk, which
// is the tested oracle every path here defers to.
//
// Keying and visibility: the key is `chainCacheKey(...)`, which embeds the
// response ETag — fileId + project epoch + rebuiltSeq + maxSeq + the CALLER's
// lane-visibility token (see `makeEtag`/`pinnedEtag`). So an entry is only ever
// reachable by a caller whose own visibility rebuilds the same key, and any
// write that could change the ordering changes the key. The isolate-local tier
// is already shared across every caller served by that isolate, so widening it
// to the colo adds reach, not a new cross-caller axis.

/** One slot of a file's ordering: a cell on one side, in one target lane. */
export interface OrderCacheItem {
  cellId: string
  side: "source" | "target"
  laneId: string
}

export interface OrderCacheStore {
  /** The ordering stored under `key`, or null on a miss / unreadable entry. */
  get(key: string): Promise<OrderCacheItem[] | null>
  put(key: string, items: readonly OrderCacheItem[], ttlSeconds: number): Promise<void>
}

/** Bumped if `encodeOrder` ever changes shape, so old entries cannot be read
 *  as new ones. It is also a path segment, so they cannot even be found. */
const WIRE_VERSION = 1

interface OrderWire {
  v: number
  /** The distinct `side\u0000laneId` slots, in first-seen order. */
  slots: string[]
  /** Cell ids, in chain order. */
  ids: string[]
  /** `slots` index per id, same length as `ids`. */
  slotOf: number[]
}

/** Parallel arrays with a slot dictionary: a 30k-cell file has two sides and a
 *  handful of lanes, so side+lane collapse to a few strings instead of ~60k
 *  repeats of each. Roughly halves both the stored bytes and the parse cost
 *  against an array of objects. */
export function encodeOrder(items: readonly OrderCacheItem[]): string {
  const slotIndex = new Map<string, number>()
  const wire: OrderWire = { v: WIRE_VERSION, slots: [], ids: [], slotOf: [] }
  for (const item of items) {
    const slot = `${item.side}\u0000${item.laneId}`
    let idx = slotIndex.get(slot)
    if (idx === undefined) {
      idx = wire.slots.length
      wire.slots.push(slot)
      slotIndex.set(slot, idx)
    }
    wire.ids.push(item.cellId)
    wire.slotOf.push(idx)
  }
  return JSON.stringify(wire)
}

/** Null for anything that is not an ordering this version wrote. A cached
 *  entry is a performance hint, never a source of truth, so a malformed or
 *  truncated one must read as a miss rather than as a shorter file. */
export function decodeOrder(raw: string): OrderCacheItem[] | null {
  let wire: unknown
  try {
    wire = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof wire !== "object" || wire === null) return null
  const w = wire as Partial<OrderWire>
  if (w.v !== WIRE_VERSION) return null
  if (!Array.isArray(w.slots) || !Array.isArray(w.ids) || !Array.isArray(w.slotOf)) return null
  if (w.ids.length !== w.slotOf.length) return null
  const slots: Array<{ side: "source" | "target"; laneId: string }> = []
  for (const slot of w.slots) {
    if (typeof slot !== "string") return null
    const sep = slot.indexOf("\u0000")
    if (sep < 0) return null
    const side = slot.slice(0, sep)
    if (side !== "source" && side !== "target") return null
    slots.push({ side, laneId: slot.slice(sep + 1) })
  }
  const items: OrderCacheItem[] = []
  for (let i = 0; i < w.ids.length; i++) {
    const id = w.ids[i]
    const idx = w.slotOf[i]
    if (typeof id !== "string") return null
    if (typeof idx !== "number" || !Number.isInteger(idx) || idx < 0 || idx >= slots.length) return null
    items.push({ cellId: id, side: slots[idx].side, laneId: slots[idx].laneId })
  }
  return items
}

/** The key as a Cache API request. The whole key (project, ETag, side, lane,
 *  paired) is one encoded path segment, so two keys can never alias. */
function cacheRequest(key: string): Request {
  return new Request(`https://cells-order-cache.aquilla.internal/v${WIRE_VERSION}/${encodeURIComponent(key)}`)
}

export function workersOrderCache(cache: Cache): OrderCacheStore {
  return {
    async get(key) {
      const res = await cache.match(cacheRequest(key))
      if (!res) return null
      return decodeOrder(await res.text())
    },
    async put(key, items, ttlSeconds) {
      await cache.put(
        cacheRequest(key),
        new Response(encodeOrder(items), {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": `max-age=${Math.max(1, Math.floor(ttlSeconds))}`,
          },
        }),
      )
    },
  }
}

let testOverride: OrderCacheStore | null = null

/** Test seam: the route's tests run in the `node` pool, which has no `caches`,
 *  so the colo tier is absent unless a test installs one. */
export function setColoOrderCacheForTests(store: OrderCacheStore | null): void {
  testOverride = store
}

/** The colo-shared store, or null when the runtime has no Cache API (the test
 *  pools, and any runtime where `caches.default` is not bound). Null simply
 *  leaves the isolate-local tier as the only cache — the pre-AQU-1885 read. */
export function coloOrderCache(): OrderCacheStore | null {
  if (testOverride) return testOverride
  const g = globalThis as { caches?: { default?: Cache } }
  return g.caches?.default ? workersOrderCache(g.caches.default) : null
}

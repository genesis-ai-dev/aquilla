// AQU-1865 — the cells cache's byte budget and LRU eviction.
//
// The cache used to grow without bound: one full-row snapshot per
// (account, project, file), never deleted. These tests pin the two properties
// that keep it bounded without making it useless — the total stays under the
// budget, and what gets dropped is the file nobody has opened recently, never
// the one being written or re-read.
//
// Everything here drives the real public API (`writeCellsCache` /
// `readCellsCache`) against `fake-indexeddb`, so the meta store, the eviction
// transaction and the LRU bump are all exercised as the app uses them.

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { CellRow } from "./cells-read-types"
import {
  purgeCellsCacheForQuota,
  readCellsCache,
  resetCellsCacheConnectionForTests,
  setCellsCacheOwner,
  writeCellsCache,
} from "./cells-cache"
import {
  __setCellsCacheBudgetForTests,
  estimateCellsSnapshotBytes,
} from "./cells-cache-budget"
import { CELLS_CACHE_DB } from "./cells-cache-writer"

function rows(count: number, prefix: string): CellRow[] {
  return Array.from({ length: count }, (_, i) => ({
    cellId: `${prefix}-${i}`,
    side: "source" as const,
    value: `${prefix} verse ${i}`,
    valueHtml: null,
    type: null,
    canonicalRef: null,
    anchorCellId: i === 0 ? null : `${prefix}-${i - 1}`,
    eventId: `e-${prefix}-${i}`,
    sourceEventId: null,
    lastEditor: null,
    lastEditAt: 0,
    validated: false,
    wordCount: 3,
  }))
}

/** One snapshot's worth of bytes, so budgets can be expressed in whole files. */
const FILE_ROWS = 40
const FILE_BYTES = estimateCellsSnapshotBytes(rows(FILE_ROWS, "gen"))

/**
 * The budget is per ORIGIN, so these tests cannot isolate themselves with
 * distinct keys the way the rest of the cache suite does — one test's leftover
 * snapshots would count against the next test's budget. Each starts from an
 * empty database.
 */
async function wipeCellsCache(): Promise<void> {
  await resetCellsCacheConnectionForTests()
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(CELLS_CACHE_DB)
    request.onsuccess = () => resolve()
    request.onerror = () => resolve()
    request.onblocked = () => resolve()
  })
}

beforeEach(async () => {
  await wipeCellsCache()
  setCellsCacheOwner("account-1")
})

afterEach(async () => {
  await wipeCellsCache()
})

describe("estimateCellsSnapshotBytes", () => {
  it("grows with the row count and with the text in the rows", () => {
    expect(estimateCellsSnapshotBytes(rows(10, "gen")))
      .toBeLessThan(estimateCellsSnapshotBytes(rows(20, "gen")))

    const plain = rows(1, "gen")
    const rich: CellRow[] = [{ ...plain[0], valueHtml: "<p>".padEnd(5_000, "x") }]
    expect(estimateCellsSnapshotBytes(rich))
      .toBeGreaterThan(estimateCellsSnapshotBytes(plain) + 9_000)
  })

  it("counts an empty snapshot as nothing", () => {
    expect(estimateCellsSnapshotBytes([])).toBe(0)
  })
})

describe("cells cache byte budget", () => {
  it("evicts the least-recently-used file once the budget is exceeded", async () => {
    // Room for two snapshots, not three.
    __setCellsCacheBudgetForTests(Math.floor(FILE_BYTES * 2.5))

    await writeCellsCache("p1", "gen", rows(FILE_ROWS, "gen"))
    await writeCellsCache("p1", "exo", rows(FILE_ROWS, "exo"))
    await writeCellsCache("p1", "lev", rows(FILE_ROWS, "lev"))

    expect(await readCellsCache("p1", "gen")).toBeNull()
    expect((await readCellsCache("p1", "exo"))?.rows).toHaveLength(FILE_ROWS)
    expect((await readCellsCache("p1", "lev"))?.rows).toHaveLength(FILE_ROWS)
  })

  it("keeps a reopened file and drops the one nobody came back to", async () => {
    __setCellsCacheBudgetForTests(Math.floor(FILE_BYTES * 2.5))

    await writeCellsCache("p1", "gen", rows(FILE_ROWS, "gen"))
    await writeCellsCache("p1", "exo", rows(FILE_ROWS, "exo"))

    // Reopening GEN makes it the most recently used, so the next write must
    // evict EXO instead — this is the whole point of LRU over insertion order.
    expect(await readCellsCache("p1", "gen")).not.toBeNull()

    await writeCellsCache("p1", "lev", rows(FILE_ROWS, "lev"))

    expect((await readCellsCache("p1", "gen"))?.rows).toHaveLength(FILE_ROWS)
    expect(await readCellsCache("p1", "exo")).toBeNull()
    expect((await readCellsCache("p1", "lev"))?.rows).toHaveLength(FILE_ROWS)
  })

  it("never evicts the snapshot it just wrote, even alone over budget", async () => {
    // A single file bigger than the whole budget: the open that wrote it is
    // about to read it back, so it survives and nothing else does.
    __setCellsCacheBudgetForTests(Math.floor(FILE_BYTES / 2))

    await writeCellsCache("p1", "gen", rows(FILE_ROWS, "gen"))
    await writeCellsCache("p1", "exo", rows(FILE_ROWS, "exo"))

    expect(await readCellsCache("p1", "gen")).toBeNull()
    expect((await readCellsCache("p1", "exo"))?.rows).toHaveLength(FILE_ROWS)
  })

  it("leaves every file cached while the total fits", async () => {
    __setCellsCacheBudgetForTests(FILE_BYTES * 10)

    await writeCellsCache("p1", "gen", rows(FILE_ROWS, "gen"))
    await writeCellsCache("p2", "gen", rows(FILE_ROWS, "gen2"))
    await writeCellsCache("p3", "gen", rows(FILE_ROWS, "gen3"))

    expect(await readCellsCache("p1", "gen")).not.toBeNull()
    expect(await readCellsCache("p2", "gen")).not.toBeNull()
    expect(await readCellsCache("p3", "gen")).not.toBeNull()
  })

  it("hands every byte back when the outbox needs the room", async () => {
    // The recovery the outbox triggers on a QuotaExceededError: the cache is a
    // latency optimisation, a queued edit is not, so the cache empties — across
    // every account and project, not just the active one.
    __setCellsCacheBudgetForTests(FILE_BYTES * 10)
    await writeCellsCache("p1", "gen", rows(FILE_ROWS, "gen"))
    await writeCellsCache("p2", "exo", rows(FILE_ROWS, "exo"))

    await purgeCellsCacheForQuota()

    expect(await readCellsCache("p1", "gen")).toBeNull()
    expect(await readCellsCache("p2", "exo")).toBeNull()

    // And the cache is still usable afterwards — a purge is not a kill switch.
    await writeCellsCache("p1", "gen", rows(FILE_ROWS, "gen"))
    expect((await readCellsCache("p1", "gen"))?.rows).toHaveLength(FILE_ROWS)
  })

  it("counts each account's snapshots against the one origin budget", async () => {
    // Quota is per origin, not per account: a shared machine where three people
    // sign in must not cache three times the budget.
    __setCellsCacheBudgetForTests(Math.floor(FILE_BYTES * 1.5))

    setCellsCacheOwner("account-1")
    await writeCellsCache("p1", "gen", rows(FILE_ROWS, "gen"))
    setCellsCacheOwner("account-2")
    await writeCellsCache("p1", "gen", rows(FILE_ROWS, "gen"))

    expect((await readCellsCache("p1", "gen"))?.rows).toHaveLength(FILE_ROWS)
    setCellsCacheOwner("account-1")
    expect(await readCellsCache("p1", "gen")).toBeNull()
  })
})

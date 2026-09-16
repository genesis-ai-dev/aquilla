// Tests for the M2-1 delta merge (mergeCellsDelta) and the cache entry's
// maxServerSeq cursor.
//
// The load-bearing property: a delta merge must produce EXACTLY the row
// order a full server read of the same final state would return — useCells
// renders in row order, so any divergence visibly reorders the editor. The
// server walks anchor chains in sync-worker/src/events/cells-read-route.ts;
// mergeCellsDelta re-walks the merged set with mirrored semantics (eventId
// sibling tiebreak, orphans at the tail by eventId).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { CellRow } from "./cells-read-types"
import {
  mergeCellsDelta,
  readCellsCache,
  writeCellsCache,
  resetCellsCacheConnectionForTests,
  setCellsCacheOwner,
  claimLegacyCellsCache,
  CELLS_CACHE_WRITE_DEBOUNCE_MS,
  flushCellsCacheWrites,
  scheduleCellsCacheWrite,
} from "./cells-cache"

function row(
  cellId: string,
  side: "source" | "target",
  over: Partial<CellRow> = {},
): CellRow {
  return {
    cellId,
    side,
    value: `${cellId}-${side}`,
    valueHtml: null,
    type: null,
    canonicalRef: null,
    anchorCellId: null,
    eventId: `e-${cellId}-${side}`,
    sourceEventId: null,
    lastEditor: null,
    lastEditAt: 0,
    validated: false,
    wordCount: 0,
    ...over,
  }
}

/** Chain a → b → c → … on one side. */
function chain(side: "source" | "target", ...ids: string[]): CellRow[] {
  return ids.map((id, i) =>
    row(id, side, { anchorCellId: i === 0 ? null : ids[i - 1] }),
  )
}

describe("mergeCellsDelta", () => {
  it("a delta merge of a re-parented chain equals a full walk of the final state", () => {
    // Cached: a → b → c → d. Server-side, d was moved between a and b:
    // d now anchors to a, b re-anchors to d. Delta carries the two moved rows.
    const cached = chain("source", "a", "b", "c", "d")
    const deltaRows = [
      row("d", "source", { anchorCellId: "a", eventId: "e-d2" }),
      row("b", "source", { anchorCellId: "d", eventId: "e-b2" }),
    ]
    const merged = mergeCellsDelta(cached, ["b", "d"], deltaRows)

    // What a full read of the final state would return (same walk over the
    // complete set, fed in scrambled order to prove order-independence).
    const finalState = [
      deltaRows[1],
      cached[0],
      cached[2],
      deltaRows[0],
    ]
    const fullWalk = mergeCellsDelta(finalState, [], [])

    expect(merged.map((r) => r.cellId)).toEqual(["a", "d", "b", "c"])
    expect(merged).toEqual(fullWalk)
  })

  it("drops every row of a changed cellId that returned no delta row (deletion)", () => {
    const cached = [...chain("source", "a", "b", "c"), row("b", "target")]
    // b was deleted on both sides: changed id, no rows. c re-anchors onto a.
    const merged = mergeCellsDelta(cached, ["b", "c"], [
      row("c", "source", { anchorCellId: "a" }),
    ])
    expect(merged.map((r) => `${r.cellId}|${r.side}`)).toEqual(["a|source", "c|source"])
  })

  it("drops only the side the server no longer returns (per-side delete)", () => {
    const cached = [row("a", "source"), row("a", "target")]
    // target.cell.delete on a: current state of `a` is source-only.
    const merged = mergeCellsDelta(cached, ["a"], [row("a", "source")])
    expect(merged.map((r) => `${r.cellId}|${r.side}`)).toEqual(["a|source"])
  })

  it("slots a newly created cell into its chain position", () => {
    const cached = chain("source", "a", "b")
    // New cell x inserted between a and b.
    const merged = mergeCellsDelta(cached, ["x", "b"], [
      row("x", "source", { anchorCellId: "a" }),
      row("b", "source", { anchorCellId: "x" }),
    ])
    expect(merged.map((r) => r.cellId)).toEqual(["a", "x", "b"])
  })

  // AQU-646 round 8: inserting a line BEFORE the first cue. The pair of tests
  // matters more than either one — the first pins the bug so it cannot come
  // back quietly, the second proves the fix.
  it("WITHOUT re-pointing the old head, a head insert lands at the TAIL", () => {
    // Two rows now claim a null anchor. They bucket under the same key and
    // tiebreak by eventId, and a fresh uuidv7 always sorts last — so the whole
    // original chain is emitted first and the new row is appended after it.
    const cached = chain("source", "a", "b")
    const merged = mergeCellsDelta(cached, ["x"], [
      row("x", "source", { anchorCellId: null, eventId: "e-zzz-newer" }),
    ])
    expect(merged.map((r) => r.cellId)).toEqual(["a", "b", "x"])
  })

  it("re-pointing the old head puts the new line FIRST, where it belongs", () => {
    const cached = chain("source", "a", "b")
    const merged = mergeCellsDelta(cached, ["x", "a"], [
      row("x", "source", { anchorCellId: null, eventId: "e-zzz-newer" }),
      row("a", "source", { anchorCellId: "x", eventId: "e-a2" }),
    ])
    expect(merged.map((r) => r.cellId)).toEqual(["x", "a", "b"])
    // ...and the file is back to exactly one row with no cell before it.
    expect(merged.filter((r) => r.anchorCellId == null)).toHaveLength(1)
  })

  // Round 4: the SAME bug one position along. The head fix only re-pointed the
  // old head, so a MID-FILE insert left the successor still anchored to the
  // cell before it — two siblings on one anchor. Invisible in the table
  // (time-sorted) and invisible until the file is exported, which reads chain
  // order.
  it("WITHOUT re-pointing the successor, a mid-file insert lands at the TAIL", () => {
    const cached = chain("source", "a", "b", "c")
    // x inserted between a and b, but b still points at a.
    const merged = mergeCellsDelta(cached, ["x"], [
      row("x", "source", { anchorCellId: "a", eventId: "e-zzz-newer" }),
    ])
    // b (lower event id) is emitted first AND drags its whole subtree — the
    // rest of the file — before x gets a turn.
    expect(merged.map((r) => r.cellId)).toEqual(["a", "b", "c", "x"])
  })

  it("re-pointing the successor puts the new line where the clock says", () => {
    const cached = chain("source", "a", "b", "c")
    const merged = mergeCellsDelta(cached, ["x", "b"], [
      row("x", "source", { anchorCellId: "a", eventId: "e-zzz-newer" }),
      row("b", "source", { anchorCellId: "x", eventId: "e-b2" }),
    ])
    expect(merged.map((r) => r.cellId)).toEqual(["a", "x", "b", "c"])
    // Still exactly one head, and no cell claims an anchor twice.
    expect(merged.filter((r) => r.anchorCellId == null)).toHaveLength(1)
    const anchors = merged.map((r) => r.anchorCellId).filter(Boolean)
    expect(new Set(anchors).size).toBe(anchors.length)
  })

  it("replaces a changed row in place without disturbing order (validate flip)", () => {
    const cached = chain("target", "a", "b", "c")
    const merged = mergeCellsDelta(cached, ["b"], [
      row("b", "target", { anchorCellId: "a", validated: true }),
    ])
    expect(merged.map((r) => r.cellId)).toEqual(["a", "b", "c"])
    expect(merged[1].validated).toBe(true)
  })

  it("walks sides independently and emits source rows before target rows", () => {
    const cached = [
      ...chain("target", "a", "b"),
      ...chain("source", "a", "b"),
    ]
    const merged = mergeCellsDelta(cached, ["b"], [
      row("b", "source", { anchorCellId: "a" }),
      row("b", "target", { anchorCellId: "a", value: "new" }),
    ])
    expect(merged.map((r) => `${r.cellId}|${r.side}`)).toEqual([
      "a|source",
      "b|source",
      "a|target",
      "b|target",
    ])
  })

  it("appends rows whose anchor is unknown at the tail in eventId order (orphans)", () => {
    const cached = chain("source", "a")
    const merged = mergeCellsDelta(cached, ["z2", "z1"], [
      row("z2", "source", { anchorCellId: "missing", eventId: "e-2" }),
      row("z1", "source", { anchorCellId: "missing", eventId: "e-1" }),
    ])
    expect(merged.map((r) => r.cellId)).toEqual(["a", "z1", "z2"])
  })

  it("AQU-538: keeps BOTH lanes' target rows for one cell through a delta merge", () => {
    // Regression: the target side was walked as ONE bucket, and the walk
    // dedupes by cellId — so when a cell had a default-lane row AND a named-
    // lane row (the delta returns all lanes), one lane's row was silently
    // dropped from the merged set. Symptom: a lane translation that was
    // saved and server-projected "disappeared" on reload (boot delta path).
    const cached = [
      row("a", "source"),
      row("a", "target", { value: "stale default", targetLang: "" }),
    ]
    const delta = [
      row("a", "source"),
      row("a", "target", { value: "English draft", targetLang: "", eventId: "e-a-default" }),
      row("a", "target", { value: "Hola draft", targetLang: "es", eventId: "e-a-es" }),
    ]
    const merged = mergeCellsDelta(cached, ["a"], delta)
    const targets = merged.filter((r) => r.side === "target")
    expect(targets.map((r) => [r.targetLang ?? "", r.value])).toEqual([
      ["", "English draft"],
      ["es", "Hola draft"],
    ])
    // Source first, then default lane, then named lanes (the full-read shape).
    expect(merged[0].side).toBe("source")
  })

  it("tiebreaks siblings claiming the same anchor by eventId, matching the server", () => {
    const cached = [row("head", "source", { eventId: "e-0" })]
    const merged = mergeCellsDelta(cached, ["s1", "s2"], [
      row("s2", "source", { anchorCellId: "head", eventId: "e-2" }),
      row("s1", "source", { anchorCellId: "head", eventId: "e-1" }),
    ])
    expect(merged.map((r) => r.cellId)).toEqual(["head", "s1", "s2"])
  })
})

describe("cells cache maxServerSeq cursor", () => {
  beforeEach(async () => {
    await resetCellsCacheConnectionForTests()
  })

  it("round-trips maxServerSeq through the IDB entry", async () => {
    await writeCellsCache("p1", "f-seq", [row("a", "source")], 42)
    const entry = await readCellsCache("p1", "f-seq")
    expect(entry?.maxServerSeq).toBe(42)
    expect(entry?.rows).toHaveLength(1)
  })

  it("never returns another account's cached rows for the same project and file", async () => {
    setCellsCacheOwner("alice")
    await writeCellsCache("shared-id", "same-file", [row("alice-row", "source")], 1)

    setCellsCacheOwner("bob")
    expect(await readCellsCache("shared-id", "same-file")).toBeNull()
    await writeCellsCache("shared-id", "same-file", [row("bob-row", "source")], 2)

    setCellsCacheOwner("alice")
    expect((await readCellsCache("shared-id", "same-file"))?.rows[0].cellId).toBe("alice-row")
  })

  it("does not collide local-only data with an account literally named local", async () => {
    setCellsCacheOwner(null)
    await writeCellsCache("collision", "file", [row("local-only-row", "source")], 1)

    setCellsCacheOwner("local")
    expect(await readCellsCache("collision", "file")).toBeNull()
  })

  it("moves a pre-account snapshot into the first resolved owner scope", async () => {
    await writeCellsCache("legacy-project", "legacy-file", [row("legacy-row", "source")], 1)
    setCellsCacheOwner("alice")
    expect(await readCellsCache("legacy-project", "legacy-file")).toBeNull()

    await claimLegacyCellsCache("alice")
    expect((await readCellsCache("legacy-project", "legacy-file"))?.rows[0].cellId).toBe("legacy-row")

    setCellsCacheOwner("bob")
    expect(await readCellsCache("legacy-project", "legacy-file")).toBeNull()
  })

  it("does not overwrite a newer scoped snapshot while removing its legacy copy", async () => {
    await writeCellsCache("upgrade-project", "upgrade-file", [row("legacy-row", "source")], 1)
    setCellsCacheOwner("alice")
    await writeCellsCache("upgrade-project", "upgrade-file", [row("scoped-row", "source")], 2)

    await claimLegacyCellsCache("alice")
    const claimed = await readCellsCache("upgrade-project", "upgrade-file")
    expect(claimed?.rows[0].cellId).toBe("scoped-row")
    expect(claimed?.maxServerSeq).toBe(2)
  })

  it("omits maxServerSeq when the server did not provide one (pre-M2-1 fallback)", async () => {
    await writeCellsCache("p1", "f-noseq", [row("a", "source")])
    const entry = await readCellsCache("p1", "f-noseq")
    expect(entry?.maxServerSeq).toBeUndefined()
  })

  // AQU-943: the cursor alone cannot say WHICH incarnation of the project it
  // was minted against, so a wipe + re-migration under the same ids leaves it
  // pointing at a seq range that no longer exists. The epoch travels with it.
  it("round-trips the project incarnation beside the cursor", async () => {
    await writeCellsCache("p1", "f-epoch", [row("a", "source")], 42, 2_000)
    const entry = await readCellsCache("p1", "f-epoch")
    expect(entry?.maxServerSeq).toBe(42)
    expect(entry?.projectEpoch).toBe(2_000)
  })

  it("omits the incarnation when the server did not provide one (pre-AQU-943 fallback)", async () => {
    await writeCellsCache("p1", "f-noepoch", [row("a", "source")], 42)
    const entry = await readCellsCache("p1", "f-noepoch")
    expect(entry?.projectEpoch).toBeUndefined()
  })
})

describe("queued cells cache writes", () => {
  beforeEach(async () => {
    vi.useRealTimers()
    await resetCellsCacheConnectionForTests()
    vi.useFakeTimers()
  })

  afterEach(async () => {
    vi.useRealTimers()
    await resetCellsCacheConnectionForTests()
    vi.restoreAllMocks()
  })

  it("keeps only the latest tuple pending before the delay", async () => {
    const put = vi.spyOn(IDBObjectStore.prototype, "put")

    for (let seq = 1; seq <= 10; seq++) {
      scheduleCellsCacheWrite(
        "queued-project",
        "queued-file",
        [row(`row-${seq}`, "source")],
        seq === 10 ? undefined : seq,
        seq === 10 ? undefined : 1_000 + seq,
      )
    }

    expect(put).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(CELLS_CACHE_WRITE_DEBOUNCE_MS - 1)
    expect(put).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await vi.runAllTimersAsync()
    expect(put).toHaveBeenCalledTimes(1)
    // fake-indexeddb completes transactions through timers of its own.
    vi.useRealTimers()
    await flushCellsCacheWrites("queued-project", "queued-file")

    expect(put).toHaveBeenCalledTimes(1)
    const entry = await readCellsCache("queued-project", "queued-file")
    expect(entry?.rows[0].cellId).toBe("row-10")
    expect(entry?.maxServerSeq).toBeUndefined()
    expect(entry?.projectEpoch).toBeUndefined()
  })

  it("restarts the trailing delay when a newer snapshot arrives", async () => {
    const put = vi.spyOn(IDBObjectStore.prototype, "put")
    scheduleCellsCacheWrite(
      "trailing-project",
      "trailing-file",
      [row("first", "source")],
      1,
    )
    await vi.advanceTimersByTimeAsync(CELLS_CACHE_WRITE_DEBOUNCE_MS - 1)
    scheduleCellsCacheWrite(
      "trailing-project",
      "trailing-file",
      [row("second", "source")],
      2,
    )

    await vi.advanceTimersByTimeAsync(CELLS_CACHE_WRITE_DEBOUNCE_MS - 1)
    expect(put).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await vi.runAllTimersAsync()
    expect(put).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
    await flushCellsCacheWrites("trailing-project", "trailing-file")

    expect(put).toHaveBeenCalledTimes(1)
    const entry = await readCellsCache("trailing-project", "trailing-file")
    expect(entry?.rows[0].cellId).toBe("second")
    expect(entry?.maxServerSeq).toBe(2)
  })

  it("flushes one file without draining another file", async () => {
    scheduleCellsCacheWrite(
      "flush-project",
      "file-a",
      [row("a", "source")],
      1,
    )
    scheduleCellsCacheWrite(
      "flush-project",
      "file-b",
      [row("b", "source")],
      2,
    )

    vi.useRealTimers()
    await flushCellsCacheWrites("flush-project", "file-a")
    expect((await readCellsCache("flush-project", "file-a"))?.rows[0].cellId)
      .toBe("a")
    expect(await readCellsCache("flush-project", "file-b")).toBeNull()

    await flushCellsCacheWrites()
    expect((await readCellsCache("flush-project", "file-b"))?.rows[0].cellId)
      .toBe("b")
  })

  it("captures the owner key and detaches the queued rows array", async () => {
    setCellsCacheOwner("queued-alice")
    const rows = [row("alice-original", "source")]
    scheduleCellsCacheWrite("owner-project", "owner-file", rows, 7)
    rows[0] = row("mutated-after-schedule", "source")

    setCellsCacheOwner("queued-bob")
    vi.useRealTimers()
    await flushCellsCacheWrites("owner-project", "owner-file")
    expect(await readCellsCache("owner-project", "owner-file")).toBeNull()

    setCellsCacheOwner("queued-alice")
    const entry = await readCellsCache("owner-project", "owner-file")
    expect(entry?.rows[0].cellId).toBe("alice-original")
    expect(entry?.maxServerSeq).toBe(7)
  })

  it("recovers from a rejected write and accepts the next snapshot", async () => {
    vi.spyOn(IDBObjectStore.prototype, "put")
      .mockImplementationOnce(() => {
        throw new Error("synthetic IDB failure")
      })
    scheduleCellsCacheWrite(
      "retry-project",
      "retry-file",
      [row("rejected", "source")],
      1,
    )

    vi.useRealTimers()
    await expect(
      flushCellsCacheWrites("retry-project", "retry-file"),
    ).resolves.toBeUndefined()
    expect(await readCellsCache("retry-project", "retry-file")).toBeNull()

    scheduleCellsCacheWrite(
      "retry-project",
      "retry-file",
      [row("accepted", "source")],
      2,
    )
    await flushCellsCacheWrites("retry-project", "retry-file")

    const entry = await readCellsCache("retry-project", "retry-file")
    expect(entry?.rows[0].cellId).toBe("accepted")
    expect(entry?.maxServerSeq).toBe(2)
  })
})

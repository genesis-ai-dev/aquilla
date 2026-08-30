// AQU-1068: inserting a cell into a file with no clock.
//
// The timed insert picks its neighbours by TIME, because on a subtitle file the
// clock is what the user is looking at. An ordinary text file has no clock, so
// the anchor chain IS the order and getInsertPlan reads it directly.
//
// The re-anchor half is the part worth pinning down. Leaving it out puts two
// rows on one anchor, and walkAnchorChain breaks that tie by event id — a fresh
// uuidv7 always sorts last, so the new cell lands at the TAIL of the file
// instead of where it was asked for. On a head insert the same omission gives
// the file two rows claiming a null anchor.

import { describe, expect, it } from "vitest"
import type { CellRow } from "@/lib/sync/cells-read-types"
import { CellStore } from "./useActiveCellStore"

function row(cellId: string, over: Partial<CellRow> = {}): CellRow {
  return {
    cellId,
    side: "source",
    value: cellId.toUpperCase(),
    valueHtml: null,
    type: null,
    canonicalRef: null,
    anchorCellId: null,
    eventId: `source-${cellId}`,
    sourceEventId: null,
    lastEditor: "alice",
    lastEditAt: 1,
    validated: false,
    wordCount: 1,
    endorsementCount: 0,
    ...over,
  } as CellRow
}

function makeStore(rows: CellRow[]): CellStore {
  const store = new CellStore()
  store.reset("p", "f")
  store.setRuntime({
    projectId: "p",
    fileId: "f",
    username: "alice",
    requiredValidations: 1,
    auditStats: new Map(),
  })
  store.replaceRows(rows, { full: true })
  return store
}

/** a -> b -> c, an untimed text file with no startMs anywhere. */
const chain = () => [
  row("a", { anchorCellId: null, sequenceIndex: 0 }),
  row("b", { anchorCellId: "a", sequenceIndex: 1 }),
  row("c", { anchorCellId: "b", sequenceIndex: 2 }),
]

describe("CellStore.getInsertPlan", () => {
  it("inserting BELOW anchors to that cell and re-points its former successor", () => {
    const plan = makeStore(chain()).getInsertPlan("b", "below")!
    expect(plan.anchorCellId).toBe("b")
    expect(plan.reanchor).toEqual({ cellId: "c", eventId: "source-c" })
    expect(plan.sequenceBefore).toBe(1)
    expect(plan.sequenceAfter).toBe(2)
  })

  it("inserting ABOVE takes that cell's anchor and re-points the cell itself", () => {
    const plan = makeStore(chain()).getInsertPlan("b", "above")!
    expect(plan.anchorCellId).toBe("a")
    expect(plan.reanchor).toEqual({ cellId: "b", eventId: "source-b" })
    expect(plan.sequenceBefore).toBe(0)
    expect(plan.sequenceAfter).toBe(1)
  })

  it("inserting ABOVE THE HEAD takes a null anchor and re-points the old head", () => {
    // The re-point is not optional here: without it the file has two rows
    // claiming a null anchor, which is the bug getChainHeadCellId documents.
    const plan = makeStore(chain()).getInsertPlan("a", "above")!
    expect(plan.anchorCellId).toBeNull()
    expect(plan.reanchor).toEqual({ cellId: "a", eventId: "source-a" })
    expect(plan.sequenceBefore).toBeUndefined()
    expect(plan.sequenceAfter).toBe(0)
  })

  it("inserting BELOW THE LAST cell has nothing to re-point", () => {
    const plan = makeStore(chain()).getInsertPlan("c", "below")!
    expect(plan.anchorCellId).toBe("c")
    expect(plan.reanchor).toBeNull()
    expect(plan.sequenceBefore).toBe(2)
    expect(plan.sequenceAfter).toBeUndefined()
  })

  it("returns null for a cell the store does not hold", () => {
    expect(makeStore(chain()).getInsertPlan("nope", "below")).toBeNull()
  })

  it("works on a single-cell file, in both directions", () => {
    const store = makeStore([row("only", { anchorCellId: null, sequenceIndex: 0 })])
    const below = store.getInsertPlan("only", "below")!
    expect(below.anchorCellId).toBe("only")
    expect(below.reanchor).toBeNull()

    const above = store.getInsertPlan("only", "above")!
    expect(above.anchorCellId).toBeNull()
    expect(above.reanchor).toEqual({ cellId: "only", eventId: "source-only" })
  })
})

/**
 * AQU-1068: the gate has to know whether a file contains cells that ARE audio,
 * and it has to know WITHOUT a media panel being open. Round 1 asked
 * `audioMergedCells` — empty outside the media lens — so an MP3 import read as
 * an ordinary text file, got the full controls, and offered a removal whose
 * confirmation could not see the audio it was about to destroy.
 */
describe("CellStore.hasMediaCells", () => {
  it("is false for an ordinary text file", () => {
    expect(makeStore(chain()).hasMediaCells()).toBe(false)
  })

  it("is true when any source row is a media cell", () => {
    const store = makeStore([
      row("a", { anchorCellId: null, sequenceIndex: 0 }),
      row("clip", { anchorCellId: "a", sequenceIndex: 1, medium: "media", startMs: 0, endMs: 60_000 }),
    ])
    expect(store.hasMediaCells()).toBe(true)
  })

  it("is true for a single-cell MP3 import — what emitMediaFile creates", () => {
    const store = makeStore([
      row("only", { anchorCellId: null, sequenceIndex: 0, medium: "media", startMs: 0, endMs: 183_000 }),
    ])
    expect(store.hasMediaCells()).toBe(true)
  })

  it("reads the answer off the cell projection — no attachments needed", () => {
    // `medium` rides the ordinary source rows, which is exactly why this can be
    // asked in any lens. Store cells never carry audio attachments at all.
    const store = makeStore([row("a", { medium: "media", startMs: 0, endMs: 10 })])
    expect(store.getAllCellViews()[0].attachments).toBeUndefined()
    expect(store.hasMediaCells()).toBe(true)
  })

  it("re-answers after the rows change, rather than serving a stale memo", () => {
    const store = makeStore(chain())
    expect(store.hasMediaCells()).toBe(false)
    store.replaceRows(
      [row("a", { anchorCellId: null, sequenceIndex: 0, medium: "media", startMs: 0, endMs: 5 })],
      { full: true },
    )
    expect(store.hasMediaCells()).toBe(true)
  })
})

/**
 * AQU-1068: an insert or removal has to be visible on the tick it happens.
 *
 * Waiting for the confirming read made a whole Bible crawl — not on the wire
 * (the delta carries two or three cells) but here: changing `order` makes
 * `replaceRows` treat every cell in the file as dirty and rebuild every derived
 * index. Applying locally first makes the click instant and demotes the read to
 * a correction nobody waits for.
 */
describe("CellStore optimistic insert / remove", () => {
  const idsOf = (store: CellStore) => store.getAllCellViews().map((c) => c.id)

  it("puts the new cell directly after its anchor, not at the tail", () => {
    // The whole point. Appending is what the targeted-read path does, and it is
    // why a collaborator's insert used to land at the bottom of the file.
    const store = makeStore(chain())
    store.applyOptimisticSourceInsert({
      cellId: "new", anchorCellId: "a", reanchorCellId: "b", sequenceIndex: 0.5,
    })
    expect(idsOf(store)).toEqual(["a", "new", "b", "c"])
  })

  it("inserts at the head when it has no anchor", () => {
    const store = makeStore(chain())
    store.applyOptimisticSourceInsert({ cellId: "new", anchorCellId: null, reanchorCellId: "a" })
    expect(idsOf(store)).toEqual(["new", "a", "b", "c"])
  })

  it("re-points the displaced sibling onto the new cell", () => {
    // Without this the file has two rows on one anchor, and the chain walk
    // breaks the tie by event id — the new cell would sort to the tail.
    const store = makeStore(chain())
    store.applyOptimisticSourceInsert({ cellId: "new", anchorCellId: "a", reanchorCellId: "b" })
    expect(store.getInsertPlan("b", "above")!.anchorCellId).toBe("new")
  })

  it("makes the cell visible to getCellView — what the scroll-to effect waits on", () => {
    const store = makeStore(chain())
    store.applyOptimisticSourceInsert({ cellId: "new", anchorCellId: "a", reanchorCellId: "b" })
    expect(store.getCellView("new")).not.toBeNull()
  })

  it("bumps the file version, so the footer's counts move at once", () => {
    const store = makeStore(chain())
    const before = store.getAllVersion()
    store.applyOptimisticSourceInsert({ cellId: "new", anchorCellId: "a", reanchorCellId: "b" })
    expect(store.getAllVersion()).toBeGreaterThan(before)
    expect(store.getAllSummaries()).toHaveLength(4)
  })

  it("refuses to insert a cell id the file already has", () => {
    const store = makeStore(chain())
    store.applyOptimisticSourceInsert({ cellId: "b", anchorCellId: "a" })
    expect(idsOf(store)).toEqual(["a", "b", "c"])
  })

  it("removes a cell and re-points its successor onto its old anchor", () => {
    const store = makeStore(chain())
    const removed = store.applyOptimisticSourceRemove("b")
    expect(idsOf(store)).toEqual(["a", "c"])
    expect(removed?.successorCellId).toBe("c")
    expect(store.getInsertPlan("c", "above")!.anchorCellId).toBe("a")
  })

  it("returns null when asked to remove a cell that is not there", () => {
    expect(makeStore(chain()).applyOptimisticSourceRemove("nope")).toBeNull()
  })

  it("refuses to plan a removal for a row the server has not confirmed", () => {
    // The insert-then-immediately-remove path. An optimistic row has no event
    // id, so a delete would carry an empty parent AND its companion reorder
    // would land on the same AD-2 slot the insert's reorder already claimed —
    // first-child-wins dead-letters the second, and the sibling is left
    // anchored on the server to a cell that no longer exists. Offline both
    // batches flush together and the later reorder loses every time.
    const store = makeStore(chain())
    store.applyOptimisticSourceInsert({ cellId: "new", anchorCellId: "a", reanchorCellId: "b" })
    expect(store.getCellView("new")).not.toBeNull()
    expect(store.getRemovalPlan("new")).toBeNull()
  })

  it("plans a removal normally once the row carries an event id", () => {
    expect(makeStore(chain()).getRemovalPlan("b")).not.toBeNull()
  })

  describe("rollback — a write the server refused", () => {
    // A freshness floor protects a row from every correcting fetch, so without
    // an explicit undo a refused insert would be a permanent phantom.
    it("takes an insert back out and restores the sibling's anchor", () => {
      const store = makeStore(chain())
      store.applyOptimisticSourceInsert({ cellId: "new", anchorCellId: "a", reanchorCellId: "b" })
      store.rollbackOptimisticSourceChange("new")
      expect(idsOf(store)).toEqual(["a", "b", "c"])
      expect(store.getInsertPlan("b", "above")!.anchorCellId).toBe("a")
    })

    it("puts a removed cell back where it was", () => {
      const store = makeStore(chain())
      const removed = store.applyOptimisticSourceRemove("b")
      store.rollbackOptimisticSourceChange("b", removed)
      expect(idsOf(store)).toEqual(["a", "b", "c"])
      expect(store.getInsertPlan("c", "above")!.anchorCellId).toBe("b")
    })
  })
})

describe("CellStore.resortSourceOrderByChain (via a targeted read)", () => {
  // A collaborator's insert reaches us as TWO targeted reads — the new cell,
  // and the sibling whose anchor was re-pointed at it — because the server
  // emits both events and each arrives on its own `event.applied`. Order is
  // only correct once both have landed, and that is what this pins.
  //
  // Between them the new row sits at the tail, which is transient and
  // self-correcting: `walkAnchorChain` breaks a sibling tie by event id, and a
  // fresh uuid always sorts last. That is the same tie-break the server uses,
  // and the reason an insert emits a re-anchor at all.
  it("places a collaborator's inserted cell at its anchor once both reads land", () => {
    const store = makeStore(chain())
    store.replaceRowsForCell("new", [row("new", { anchorCellId: "a", sequenceIndex: 0.5 })])
    store.replaceRowsForCell("b", [row("b", { anchorCellId: "new", sequenceIndex: 1 })])
    expect(store.getAllCellViews().map((c) => c.id)).toEqual(["a", "new", "b", "c"])
  })

  it("leaves the rest of the file alone while only the first read has arrived", () => {
    // Transiently at the tail — but never LOST, and never scrambling its
    // neighbours, which is what would actually hurt.
    const store = makeStore(chain())
    store.replaceRowsForCell("new", [row("new", { anchorCellId: "a", sequenceIndex: 0.5 })])
    const ids = store.getAllCellViews().map((c) => c.id)
    expect(ids).toContain("new")
    expect(ids.filter((id) => id !== "new")).toEqual(["a", "b", "c"])
  })

  it("survives a chain far deeper than the call stack", () => {
    // A Bible is one cell deep per verse; a recursive walk overflows around
    // thirty thousand. The reused house walk is explicitly stacked.
    const deep = Array.from({ length: 30_000 }, (_, i) =>
      row(`c${i}`, { anchorCellId: i === 0 ? null : `c${i - 1}`, sequenceIndex: i }),
    )
    const store = makeStore(deep)
    expect(() => {
      store.replaceRowsForCell("inserted", [row("inserted", { anchorCellId: "c0" })])
      store.replaceRowsForCell("c1", [row("c1", { anchorCellId: "inserted", sequenceIndex: 1 })])
    }).not.toThrow()
    expect(store.getAllCellViews().map((c) => c.id).slice(0, 3)).toEqual(["c0", "inserted", "c1"])
  })
})

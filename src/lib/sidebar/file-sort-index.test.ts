import { describe, it, expect } from "vitest"
import {
  SORT_INDEX_STEP,
  hasPlacedFiles,
  planFileInsert,
  planFileMove,
  planFileNudge,
  planFileOrderReset,
  type PlaceableFile,
} from "./file-sort-index"

/** A group as the sidebar sees it: already in visual order. */
function group(...spec: [string, number?][]): PlaceableFile[] {
  return spec.map(([id, sortIndex]) =>
    sortIndex === undefined ? { id } : { id, sortIndex },
  )
}

/** Apply a plan and re-sort the way `groupByCorpus` would, to read the result. */
function applied(ordered: PlaceableFile[], writes: { fileId: string; sortIndex: number | null }[]) {
  const byId = new Map(writes.map((w) => [w.fileId, w.sortIndex]))
  const next = ordered.map((f, position) => {
    if (!byId.has(f.id)) return { ...f, position }
    const sortIndex = byId.get(f.id)
    return { ...f, position, ...(sortIndex === null ? { sortIndex: undefined } : { sortIndex }) }
  })
  return next
    .slice()
    .sort((a, b) => {
      const ai = a.sortIndex
      const bi = b.sortIndex
      if (ai !== undefined && bi !== undefined && ai !== bi) return ai - bi
      if (ai !== undefined && bi === undefined) return -1
      if (bi !== undefined && ai === undefined) return 1
      // Stand-in for today's name-derived comparator: the original position.
      return a.position - b.position
    })
    .map((f) => f.id)
}

describe("planFileMove — first placement in a group", () => {
  it("stamps every file in the group, in the order the move produces", () => {
    const ordered = group(["ep1"], ["ep10"], ["ep2"], ["ep3"])
    const writes = planFileMove(ordered, "ep10", 3)
    expect(writes).toEqual([
      { fileId: "ep1", sortIndex: 0 },
      { fileId: "ep2", sortIndex: SORT_INDEX_STEP },
      { fileId: "ep3", sortIndex: SORT_INDEX_STEP * 2 },
      { fileId: "ep10", sortIndex: SORT_INDEX_STEP * 3 },
    ])
    expect(applied(ordered, writes)).toEqual(["ep1", "ep2", "ep3", "ep10"])
  })

  // A single midpoint cannot express this: an unplaced file sorts AFTER every
  // placed one, so no number puts the moved file below one. Hence the stamp.
  it("stamps the whole group when only some files are placed", () => {
    const ordered = group(["placed", 0], ["loose-a"], ["loose-b"])
    const writes = planFileMove(ordered, "placed", 2)
    expect(writes.map((w) => w.fileId)).toEqual(["loose-a", "loose-b", "placed"])
    expect(applied(ordered, writes)).toEqual(["loose-a", "loose-b", "placed"])
  })
})

describe("planFileMove — steady state (every file placed)", () => {
  const ordered = group(["a", 0], ["b", 1024], ["c", 2048], ["d", 3072])

  it("writes one midpoint when moving into the middle", () => {
    const writes = planFileMove(ordered, "d", 1)
    expect(writes).toEqual([{ fileId: "d", sortIndex: 512 }])
    expect(applied(ordered, writes)).toEqual(["a", "d", "b", "c"])
  })

  it("writes one index below the head when moving to the top", () => {
    const writes = planFileMove(ordered, "c", 0)
    expect(writes).toEqual([{ fileId: "c", sortIndex: -SORT_INDEX_STEP }])
    expect(applied(ordered, writes)).toEqual(["c", "a", "b", "d"])
  })

  it("writes one index above the tail when moving to the bottom", () => {
    const writes = planFileMove(ordered, "a", 3)
    expect(writes).toEqual([{ fileId: "a", sortIndex: 3072 + SORT_INDEX_STEP }])
    expect(applied(ordered, writes)).toEqual(["b", "c", "d", "a"])
  })

  it("touches only the moved file, so two concurrent moves cannot clobber each other", () => {
    expect(planFileMove(ordered, "d", 1)).toHaveLength(1)
    expect(planFileMove(ordered, "a", 2)).toHaveLength(1)
  })

  it("falls back to a renumber when the file lands between two equal indices", () => {
    // The visual order between two tied files came from the name tie-break,
    // not from the numbers, so there is no midpoint between them to mint.
    const tied = group(["a", 512], ["b", 512], ["c", 512])
    const writes = planFileMove(tied, "a", 1)
    expect(writes).toEqual([
      { fileId: "b", sortIndex: 0 },
      { fileId: "a", sortIndex: SORT_INDEX_STEP },
      { fileId: "c", sortIndex: SORT_INDEX_STEP * 2 },
    ])
  })

  it("still writes one index when a tie is at an END of the group", () => {
    // Nothing above the head, so the index goes a step below it — no renumber
    // needed, and the tie below is left undisturbed.
    const tied = group(["a", 512], ["b", 512], ["c", 512])
    expect(planFileMove(tied, "c", 0)).toEqual([{ fileId: "c", sortIndex: 512 - SORT_INDEX_STEP }])
  })

  it("renumbers rather than writing a midpoint a double cannot represent", () => {
    // 1 and the very next representable double above it: their midpoint
    // rounds back onto 1, so there is genuinely no slot between them.
    const noGap = group(["a", 1], ["b", 1.0000000000000002], ["c", 9])
    expect(planFileMove(noGap, "c", 1)).toEqual([
      { fileId: "a", sortIndex: 0 },
      { fileId: "c", sortIndex: SORT_INDEX_STEP },
      { fileId: "b", sortIndex: SORT_INDEX_STEP * 2 },
    ])
    // A pair with ordinary room apart still takes the one-write path.
    expect(planFileMove(group(["a", 1], ["b", 9], ["c", 20]), "c", 1))
      .toEqual([{ fileId: "c", sortIndex: 5 }])
  })
})

describe("planFileMove — no-ops", () => {
  const ordered = group(["a", 0], ["b", 1024])

  it("emits nothing for a file that is not in the group", () => {
    expect(planFileMove(ordered, "ghost", 0)).toEqual([])
  })

  it("emits nothing when the file is already in that slot", () => {
    expect(planFileMove(ordered, "a", 0)).toEqual([])
  })

  it("clamps a position past the end instead of dropping the move", () => {
    expect(planFileMove(ordered, "a", 99)).toEqual([{ fileId: "a", sortIndex: 1024 + SORT_INDEX_STEP }])
  })
})

describe("planFileInsert", () => {
  const placed = group(["c", 0], ["d", SORT_INDEX_STEP])

  it("lands an incoming file between the neighbours it was dropped on", () => {
    const writes = planFileInsert(placed, "a", 1)
    expect(writes).toEqual([{ fileId: "a", sortIndex: SORT_INDEX_STEP / 2 }])
    expect(applied([...placed, { id: "a" }], writes)).toEqual(["c", "a", "d"])
  })

  it("lands an incoming file after the last row", () => {
    expect(planFileInsert(placed, "a", placed.length)).toEqual([
      { fileId: "a", sortIndex: SORT_INDEX_STEP * 2 },
    ])
  })

  it("stamps a whole unplaced group so the incoming file can sit in the slot", () => {
    const loose = group(["c"], ["d"])
    expect(applied(
      [...loose, { id: "a" }],
      planFileInsert(loose, "a", 0),
    )).toEqual(["a", "c", "d"])
  })

  it("uses the same-group move when the file is already in the list", () => {
    expect(planFileInsert(placed, "d", 0)).toEqual(planFileMove(placed, "d", 0))
  })
})

describe("planFileNudge", () => {
  const ordered = group(["a", 0], ["b", 1024], ["c", 2048])

  it("moves one slot up", () => {
    expect(applied(ordered, planFileNudge(ordered, "c", -1))).toEqual(["a", "c", "b"])
  })

  it("moves one slot down", () => {
    expect(applied(ordered, planFileNudge(ordered, "a", 1))).toEqual(["b", "a", "c"])
  })

  // The same emptiness that disables the menu item, so the control and the
  // write can never disagree about where the ends are.
  it("emits nothing at the top going up, or the bottom going down", () => {
    expect(planFileNudge(ordered, "a", -1)).toEqual([])
    expect(planFileNudge(ordered, "c", 1)).toEqual([])
  })

  it("emits nothing for an unknown file", () => {
    expect(planFileNudge(ordered, "ghost", 1)).toEqual([])
  })
})

describe("planFileOrderReset", () => {
  it("clears every placed file and leaves the unplaced ones alone", () => {
    const ordered = group(["a", 0], ["loose"], ["b", 1024])
    expect(planFileOrderReset(ordered)).toEqual([
      { fileId: "a", sortIndex: null },
      { fileId: "b", sortIndex: null },
    ])
  })

  it("emits nothing for a group nobody has placed", () => {
    expect(planFileOrderReset(group(["a"], ["b"]))).toEqual([])
  })
})

describe("hasPlacedFiles", () => {
  it("is what gates the Reset order action", () => {
    expect(hasPlacedFiles(group(["a"], ["b"]))).toBe(false)
    expect(hasPlacedFiles(group(["a"], ["b", 0]))).toBe(true)
    expect(hasPlacedFiles([{ id: "a", sortIndex: Number.NaN }])).toBe(false)
  })
})

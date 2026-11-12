import { describe, it, expect } from "vitest"
import { filterValidated, sortValidated } from "./useLivingMemory"
import { buildProjectCellSnapshot } from "./useProjectCells"
import type { CellData } from "./useCells"
import type { CellRow } from "@/lib/sync/cells-read-types"

// Minimal stub: only the fields useLivingMemory cares about.
function makeCell(overrides: Partial<CellData> & { id: string }): CellData {
  return {
    fileId: "file-a",
    original: "source text",
    translated: "target text",
    status: "validated",
    group: "",
    type: "text",
    context: "",
    validationStatus: "full",
    activeValidators: [],
    validationHistory: [],
    history: [],
    threads: [],
    ...overrides,
  }
}

describe("filterValidated", () => {
  it("returns only validated cells", () => {
    const cells = [
      makeCell({ id: "1", status: "validated" }),
      makeCell({ id: "2", status: "unvalidated" }),
      makeCell({ id: "3", status: "empty" }),
      makeCell({ id: "4", status: "validated" }),
    ]
    const result = filterValidated(cells)
    expect(result).toHaveLength(2)
    expect(result.map((c) => c.id)).toEqual(["1", "4"])
  })

  it("returns empty array when no validated cells exist", () => {
    const cells = [
      makeCell({ id: "1", status: "unvalidated" }),
      makeCell({ id: "2", status: "empty" }),
    ]
    expect(filterValidated(cells)).toHaveLength(0)
  })

  it("returns all cells when all are validated", () => {
    const cells = [
      makeCell({ id: "a", status: "validated" }),
      makeCell({ id: "b", status: "validated" }),
    ]
    expect(filterValidated(cells)).toHaveLength(2)
  })
})

describe("sortValidated", () => {
  it("sorts by descending lastEditAt (most-recently-edited first)", () => {
    const cells = [
      makeCell({ id: "1", lastEditAt: 1000 }),
      makeCell({ id: "2", lastEditAt: 3000 }),
      makeCell({ id: "3", lastEditAt: 2000 }),
    ]
    const sorted = sortValidated(cells)
    expect(sorted.map((c) => c.id)).toEqual(["2", "3", "1"])
  })

  it("falls back to group (canonicalRef) ascending when lastEditAt is absent", () => {
    const cells = [
      makeCell({ id: "1", group: "GEN 1:3" }),
      makeCell({ id: "2", group: "GEN 1:1" }),
      makeCell({ id: "3", group: "GEN 1:2" }),
    ]
    const sorted = sortValidated(cells)
    expect(sorted.map((c) => c.group)).toEqual(["GEN 1:1", "GEN 1:2", "GEN 1:3"])
  })

  it("falls back to id when group is empty and lastEditAt is absent", () => {
    const cells = [
      makeCell({ id: "z", group: "" }),
      makeCell({ id: "a", group: "" }),
      makeCell({ id: "m", group: "" }),
    ]
    const sorted = sortValidated(cells)
    expect(sorted.map((c) => c.id)).toEqual(["a", "m", "z"])
  })

  it("cells with lastEditAt sort before cells without it", () => {
    const cells = [
      makeCell({ id: "no-time", group: "A" }),
      makeCell({ id: "has-time", group: "Z", lastEditAt: 500 }),
    ]
    const sorted = sortValidated(cells)
    // lastEditAt=500 > 0 (absent treated as 0), so has-time comes first
    expect(sorted.map((c) => c.id)).toEqual(["has-time", "no-time"])
  })

  it("does not mutate the original array", () => {
    const cells = [
      makeCell({ id: "b", group: "B" }),
      makeCell({ id: "a", group: "A" }),
    ]
    const original = [...cells]
    sortValidated(cells)
    expect(cells.map((c) => c.id)).toEqual(original.map((c) => c.id))
  })
})

/**
 * AQU-2001: Living Memory aggregates the corpus snapshot `useProjectCells`
 * publishes, and that snapshot keeps only target rows belonging to the lane it
 * was read in. So the regression lives in the composition, not in either half:
 * `filterValidated` is correct, and the snapshot builder is correct, but
 * running the builder at the default lane `''` over rows that live in a named
 * lane drops every target row — and a cell with no target can never be
 * `validated`. The pane then showed its empty state however many cells the
 * team had actually validated.
 *
 * The fixture is a curriculum-style file on purpose (ordered by
 * `sequenceIndex`, `canonicalRef: null`): the LOTE projects where this was
 * found have no scripture refs, and the guard has to prove that nothing in
 * this path filters those cells out.
 */
describe("validated examples across the lane-scoped corpus read (AQU-2001)", () => {
  const laneRows: CellRow[] = [
    {
      cellId: "seg-1",
      side: "source",
      targetLang: "",
      value: "Come before God daily.",
      valueHtml: null,
      type: "text",
      canonicalRef: null,
      anchorCellId: null,
      eventId: "e-src-1",
      sourceEventId: null,
      lastEditor: "joel",
      lastEditAt: 1000,
      validated: false,
      wordCount: 4,
      sequenceIndex: 1,
    },
    {
      cellId: "seg-1",
      side: "target",
      targetLang: "de",
      value: "Komm täglich vor Gott.",
      valueHtml: null,
      type: "text",
      canonicalRef: null,
      anchorCellId: null,
      eventId: "e-tgt-1",
      sourceEventId: "e-src-1",
      lastEditor: "joel",
      lastEditAt: 2000,
      validated: true,
      wordCount: 4,
      sequenceIndex: 1,
    },
  ]

  it("surfaces a validated curriculum pair when the corpus is read in its named lane", () => {
    const validated = filterValidated(buildProjectCellSnapshot(laneRows, "file-lote", "de"))

    expect(validated.map((cell) => cell.id)).toEqual(["seg-1"])
    expect(validated[0].original).toBe("Come before God daily.")
    expect(validated[0].translated).toBe("Komm täglich vor Gott.")
  })

  it("finds nothing when the same corpus is read at the default lane — the bug", () => {
    expect(filterValidated(buildProjectCellSnapshot(laneRows, "file-lote", ""))).toEqual([])
  })

  it("leaves default-lane (scripture-style) projects reading their own pairs", () => {
    const defaultLaneRows: CellRow[] = [
      { ...laneRows[0], canonicalRef: "GEN 1:1", sequenceIndex: null },
      { ...laneRows[1], targetLang: "", canonicalRef: "GEN 1:1", sequenceIndex: null },
    ]

    const validated = filterValidated(buildProjectCellSnapshot(defaultLaneRows, "file-gen", ""))
    expect(validated.map((cell) => cell.id)).toEqual(["seg-1"])
  })
})

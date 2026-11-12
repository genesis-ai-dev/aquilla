import { describe, it, expect } from "vitest"
import { planToolRevert, type ToolWrite, type TouchedCellState } from "./revert"

const write = (eventId: string, cellId: string, seq: number, extra: Partial<ToolWrite> = {}): ToolWrite => ({
  eventId,
  kind: "target.cell.commit",
  fileId: "f",
  cellId,
  targetLang: "",
  serverSeq: seq,
  parentId: null,
  ...extra,
})

const cell = (cellId: string, head: string, headValue: string, priorValue: string, headAuthor = "alice"): TouchedCellState => ({
  fileId: "f",
  cellId,
  targetLang: "",
  laneId: "lane-1",
  headEventId: head,
  headValue,
  headAuthor,
  sourceEventId: `src-${cellId}`,
  priorValue,
  priorValueHtml: null,
})

describe("planToolRevert", () => {
  it("restores cells whose head is still the tool's write, chained on that head", () => {
    const plan = planToolRevert([write("e1", "c1", 1)], [cell("c1", "e1", "Jesús", "Jesus")])
    expect(plan.commits).toEqual([
      expect.objectContaining({ cellId: "c1", parentId: "e1", value: "Jesus", before: "Jesús", sourceEventId: "src-c1", laneId: "lane-1" }),
    ])
    expect(plan.skipped).toEqual([])
  })

  it("skips (and lists) a cell someone else edited after the tool", () => {
    const plan = planToolRevert([write("e1", "c1", 1)], [cell("c1", "human-1", "Jesucristo", "Jesus", "bob")])
    expect(plan.commits).toEqual([])
    expect(plan.skipped).toEqual([{ fileId: "f", cellId: "c1", targetLang: "", reason: "edited-since", by: "bob" }])
  })

  it("uses the value before the tool's FIRST write when it wrote a cell twice", () => {
    const plan = planToolRevert(
      [write("e1", "c1", 1), write("e2", "c1", 2, { parentId: "e1" })],
      [cell("c1", "e2", "third", "original")],
    )
    expect(plan.commits.map((c) => c.value)).toEqual(["original"])
  })

  it("counts no-op cells as unchanged and lists missing cells", () => {
    const plan = planToolRevert([write("e1", "c1", 1), write("e2", "c2", 2)], [cell("c1", "e1", "same", "same")])
    expect(plan.unchanged).toBe(1)
    expect(plan.skipped).toEqual([expect.objectContaining({ cellId: "c2", reason: "missing" })])
  })

  it("withdraws a tool validation only while it anchors to the live head", () => {
    const v = (id: string, cellId: string, edit: string) => write(id, cellId, 5, { kind: "cell.validate", editEventId: edit })
    const plan = planToolRevert(
      [v("v1", "c1", "h1"), v("v2", "c2", "old")],
      [cell("c1", "h1", "x", "x"), cell("c2", "h2", "y", "y")],
    )
    expect(plan.unvalidates).toEqual([expect.objectContaining({ cellId: "c1", editEventId: "h1" })])
  })

  it("keeps lanes apart", () => {
    const plan = planToolRevert(
      [write("e1", "c1", 1, { targetLang: "fr" })],
      [cell("c1", "e1", "a", "b"), { ...cell("c1", "e1", "a", "b"), targetLang: "fr", headEventId: "e1" }],
    )
    expect(plan.commits).toHaveLength(1)
    expect(plan.commits[0].targetLang).toBe("fr")
  })

  it("puts back a validation the tool withdrew while the text it validated is still live (the reverting user's own)", () => {
    const writes = [
      write("v1", "c1", 1, { kind: "cell.unvalidate", editEventId: "h1", author: "alice" }),
      write("v2", "c2", 2, { kind: "cell.unvalidate", editEventId: "old", author: "alice" }),
      write("v3", "c3", 3, { kind: "cell.unvalidate", editEventId: "h3", author: "bob" }),
      write("v4", "c4", 4, { kind: "cell.unvalidate", editEventId: "h4", author: "alice" }),
      write("v5", "c4", 5, { kind: "cell.validate", editEventId: "h4", author: "alice" }),
    ]
    const cells = [cell("c1", "h1", "x", "x"), cell("c2", "h2", "y", "y"), cell("c3", "h3", "z", "z"), cell("c4", "h4", "w", "w")]
    const plan = planToolRevert(writes, cells, "alice")
    expect(plan.revalidates).toEqual([{ fileId: "f", cellId: "c1", targetLang: "", laneId: "lane-1", editEventId: "h1" }])
  })
})

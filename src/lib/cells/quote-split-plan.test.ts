// AQU-1759. The events a split sends, and what each language's translation
// becomes. The contract that matters most is the last test's: a translation is
// only ever divided when it splits the same way, and is otherwise left exactly
// where it was — never deleted, never rewritten on a guess.

import { describe, it, expect } from "vitest"
import type { CellRow } from "@/lib/sync/cells-read-types"
import { planQuoteSplits, quoteSplitCandidates, quoteSplitForRow, voiceAssignmentsForSplits } from "./quote-split-plan"

function row(over: Partial<CellRow> & Pick<CellRow, "cellId" | "side" | "value">): CellRow {
  return {
    targetLang: "",
    valueHtml: null,
    type: null,
    canonicalRef: null,
    anchorCellId: null,
    eventId: `head-${over.cellId}-${over.side}-${over.targetLang ?? ""}`,
    sourceEventId: null,
    lastEditor: null,
    lastEditAt: 0,
    validated: false,
    wordCount: 0,
    ...over,
  }
}

function minter() {
  let n = 0
  return () => `id${++n}`
}

const JHN_6_5 = "Jesus said to Philip, “Where are we to buy bread?” He said this to test him."

describe("planQuoteSplits", () => {
  it("keeps the row as the first piece, inserts the rest after it, and moves its follower onto the last", () => {
    const plan = planQuoteSplits({
      projectId: "p",
      fileId: "f",
      author: "sam",
      mintId: minter(),
      rows: [
        {
          source: row({ cellId: "v5", side: "source", value: JHN_6_5, type: "verse", canonicalRef: "JHN 6:5", sequenceIndex: 5 }),
          targets: [
            // Splits the same way: divided.
            row({
              cellId: "v5", side: "target", targetLang: "fr", laneId: "lane-fr",
              value: "Jésus dit à Philippe : « Où achèterons-nous du pain ? » Il disait cela pour l’éprouver.",
            }),
            // No quotation marks of its own: kept whole, untouched.
            row({ cellId: "v5", side: "target", targetLang: "es", value: "Jesús dijo a Felipe dónde comprar pan." }),
          ],
          successor: { cellId: "v6", eventId: "head-v6" },
          nextSequenceIndex: 6,
        },
      ],
    })

    expect(plan.refused).toEqual([])
    const [split] = plan.splits
    expect(split.pieces.map((p) => p.kind)).toEqual(["narration", "quote", "narration"])
    expect(split.newCellIds).toHaveLength(2)
    // Narration after narration keeps the row's voice; the quote is left to cast.
    expect(split.sameKindAsFirst).toEqual([split.newCellIds[1]])
    expect(split.lanes).toEqual([
      { targetLang: "fr", outcome: "divided" },
      { targetLang: "es", outcome: "kept" },
    ])

    const [n2, n3] = split.newCellIds
    const shape = plan.events.map((e) => [e.kind, e.cellId, e.parentId])
    const commitId = plan.events[0].id
    const [c2, c3] = [plan.events[1].id, plan.events[2].id]
    expect(shape).toEqual([
      ["source.cell.commit", "v5", "head-v5-source-"],
      ["source.cell.create", n2, null],
      ["source.cell.create", n3, null],
      ["source.cell.reorder", "v6", "head-v6"],
      // Only French: its translation of the row is cut at its own quotes.
      ["target.cell.commit", "v5", "head-v5-target-fr"],
      ["target.cell.commit", n2, c2],
      ["target.cell.commit", n3, c3],
    ])
    expect(plan.events[0].payload).toEqual({ value: "Jesus said to Philip," })
    expect(plan.events[1].payload).toMatchObject({
      cellId: n2,
      anchorCellId: "v5",
      value: "“Where are we to buy bread?”",
      type: "verse",
      sequenceIndex: 5 + 1 / 3,
      metadata: { aquillaOrigin: { kind: "user-insert", splitFrom: "v5" } },
    })
    // No verse reference on a piece: the exporters place an unreferenced
    // added line under the verse it follows, which reassembles the verse.
    expect(plan.events[1].payload).not.toHaveProperty("canonicalRef")
    expect(plan.events[2].payload).toMatchObject({ anchorCellId: n2, value: "He said this to test him." })
    expect(plan.events[3].payload).toEqual({ anchorCellId: n3 })
    expect(plan.events[4].payload).toEqual({
      value: "Jésus dit à Philippe :",
      sourceEventId: commitId,
      targetLang: "fr",
      laneId: "lane-fr",
    })
    expect(plan.events[5].payload).toMatchObject({ value: "« Où achèterons-nous du pain ? »", sourceEventId: c2 })
    expect(plan.events[6].payload).toMatchObject({ value: "Il disait cela pour l’éprouver.", sourceEventId: c3 })
  })

  it("chains a split follower's reorder on its own commit", () => {
    // v5 and v6 are both split, and v6 follows v5: v6's head moves twice in
    // one plan. Both moves claiming the same parent would be a stale sibling.
    const plan = planQuoteSplits({
      projectId: "p",
      fileId: "f",
      author: "sam",
      mintId: minter(),
      rows: [
        {
          source: row({ cellId: "v5", side: "source", value: JHN_6_5 }),
          targets: [],
          successor: { cellId: "v6", eventId: "head-v6-source-" },
        },
        {
          source: row({ cellId: "v6", side: "source", value: "Philip answered, “Not enough.”" }),
          targets: [],
          successor: null,
        },
      ],
    })
    const v6Commit = plan.events.find((e) => e.kind === "source.cell.commit" && e.cellId === "v6")!
    const v6Reorder = plan.events.find((e) => e.kind === "source.cell.reorder" && e.cellId === "v6")!
    expect(v6Reorder.parentId).toBe(v6Commit.id)
    expect(plan.events.indexOf(v6Reorder)).toBeGreaterThan(plan.events.indexOf(v6Commit))
  })

  it("refuses a row it cannot split, and touches nothing for it", () => {
    const plan = planQuoteSplits({
      projectId: "p",
      fileId: "f",
      author: "sam",
      mintId: minter(),
      rows: [
        { source: row({ cellId: "a", side: "source", value: "After this Jesus went away." }), targets: [], successor: null },
        { source: row({ cellId: "b", side: "source", value: JHN_6_5, eventId: "" }), targets: [], successor: null },
        {
          source: row({ cellId: "c", side: "source", value: JHN_6_5, valueHtml: `<p>Jesus <em>said</em>, “Go.”</p>` }),
          targets: [],
          successor: null,
        },
      ],
    })
    expect(plan.events).toEqual([])
    expect(plan.refused).toEqual([
      { cellId: "a", refusal: "single" },
      { cellId: "b", refusal: "unsaved" },
      { cellId: "c", refusal: "formatted" },
    ])
  })
})

describe("quoteSplitForRow", () => {
  it("accepts paragraph-only HTML, which says nothing the plain text does not", () => {
    expect(quoteSplitForRow({ value: JHN_6_5, valueHtml: `<p>${JHN_6_5}</p>` }).refusal).toBeNull()
  })
})

describe("voiceAssignmentsForSplits", () => {
  it("gives the row's voice to its later narration pieces and leaves quotations to cast", () => {
    const splits = [
      { cellId: "v5", sameKindAsFirst: ["v5-c"] },
      { cellId: "v6", sameKindAsFirst: ["v6-c"] },
    ]
    expect(voiceAssignmentsForSplits(splits, { v5: "narrator", other: "jesus" })).toEqual({ "v5-c": "narrator" })
    expect(voiceAssignmentsForSplits(splits, {})).toBeNull()
  })
})

describe("quoteSplitCandidates", () => {
  it("lists the rows a file-wide split would cut, and how many lines they become", () => {
    expect(quoteSplitCandidates([
      { id: "v4", original: "Now the Passover was at hand." },
      { id: "v5", original: JHN_6_5 },
      { id: "v9", original: "“There is a boy here.”" },
      { id: "v10", original: "Jesus said, “Sit down.”", originalHtml: "<p>Jesus <b>said</b>, “Sit down.”</p>" },
    ])).toEqual({ cellIds: ["v5"], lines: 3 })
  })
})

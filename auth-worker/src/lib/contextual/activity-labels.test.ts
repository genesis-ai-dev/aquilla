import { describe, expect, it } from "vitest"
import { decorateActivityLabels, indexFromRows } from "./activity-labels"

describe("decorateActivityLabels", () => {
  it("replaces cell UUID endpoints with a first–last semantic range", () => {
    const index = indexFromRows([
      { cell_id: "aaaaaaa1-0000-7000-8000-000000000001", canonical_ref: "LUK 1:1", sequence_index: 0, anchor_cell_id: null, metadata: null, start_ms: null, end_ms: null },
      { cell_id: "aaaaaaa2-0000-7000-8000-000000000002", canonical_ref: "LUK 1:2", sequence_index: 1, anchor_cell_id: "aaaaaaa1-0000-7000-8000-000000000001", metadata: null, start_ms: null, end_ms: null },
      { cell_id: "aaaaaaa3-0000-7000-8000-000000000003", canonical_ref: "LUK 1:8", sequence_index: 2, anchor_cell_id: "aaaaaaa2-0000-7000-8000-000000000002", metadata: null, start_ms: null, end_ms: null },
    ])
    const decorated = decorateActivityLabels({
      events: [{
        spanLabel: "aaaaaaa1-0000-7000-8000-000000000001…aaaaaaa3-0000-7000-8000-000000000003",
        details: {
          cellIds: [
            "aaaaaaa1-0000-7000-8000-000000000001",
            "aaaaaaa2-0000-7000-8000-000000000002",
            "aaaaaaa3-0000-7000-8000-000000000003",
          ],
        },
      }],
      sceneBriefs: [{
        id: "brief-1",
        startCellId: "aaaaaaa1-0000-7000-8000-000000000001",
        endCellId: "aaaaaaa3-0000-7000-8000-000000000003",
      }],
      drafts: [{
        cellId: "aaaaaaa2-0000-7000-8000-000000000002",
        sceneBriefId: "brief-1",
      }],
    }, index)

    expect(decorated.sceneBriefs[0]?.spanLabel).toBe("LUK 1:1–LUK 1:8")
    expect(decorated.drafts[0]).toMatchObject({ cellLabel: "LUK 1:2", spanLabel: "LUK 1:1–LUK 1:8" })
    expect(decorated.events[0]?.spanLabel).toBe("LUK 1:1–LUK 1:8")
  })

  it("falls back to 1-based cell ordinals when a file has no refs or tags", () => {
    const index = indexFromRows([
      { cell_id: "c1", canonical_ref: null, sequence_index: 0, anchor_cell_id: null, metadata: null, start_ms: null, end_ms: null },
      { cell_id: "c2", canonical_ref: null, sequence_index: 1, anchor_cell_id: "c1", metadata: null, start_ms: null, end_ms: null },
      { cell_id: "c3", canonical_ref: null, sequence_index: 2, anchor_cell_id: "c2", metadata: { spreadsheetLabel: "Intro" }, start_ms: null, end_ms: null },
    ])
    const decorated = decorateActivityLabels({
      events: [],
      sceneBriefs: [{ startCellId: "c1", endCellId: "c3" }],
      drafts: [{ cellId: "c3" }],
    }, index)

    expect(decorated.sceneBriefs[0]?.spanLabel).toBe("1–Intro")
    expect(decorated.drafts[0]?.cellLabel).toBe("Intro")
  })
})

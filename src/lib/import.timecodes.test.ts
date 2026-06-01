import { describe, it, expect } from "vitest"
import { buildBulkCells } from "./import"

describe("buildBulkCells timecodes", () => {
  it("maps parsed cue seconds to integer startMs/endMs", () => {
    const cells = buildBulkCells([
      { id: "", original: "Hi", translated: "", context: "", group: "g1", type: "cue", start: 1.5, end: 3.25 },
    ])
    expect(cells[0].startMs).toBe(1500)
    expect(cells[0].endMs).toBe(3250)
  })

  it("omits timecodes for non-cue strings", () => {
    const cells = buildBulkCells([
      { id: "", original: "v", translated: "", context: "", group: "g1", type: "verse" },
    ])
    expect(cells[0].startMs).toBeUndefined()
    expect(cells[0].endMs).toBeUndefined()
  })
})

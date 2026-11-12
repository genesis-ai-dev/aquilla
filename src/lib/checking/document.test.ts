import { describe, expect, it } from "vitest"
import type { CheckingRow } from "./api"
import { checkingDocument, segmentMarker } from "./document"

const row = (cellId: string, extra: Partial<CheckingRow> = {}): CheckingRow =>
  ({ fileId: "f", cellId, fileName: "Mark", label: null, text: cellId, side: "source", ...extra })
const shape = (rows: CheckingRow[]) => checkingDocument(rows).map(section => ({
  file: section.fileName,
  blocks: section.blocks.map(block => `${block.kind}:${block.segments.map(segment => segment.row.cellId).join(",")}`),
}))

describe("checking document layout", () => {
  it("reads a file without paragraph markers as one continuous paragraph, not one block per verse", () => {
    expect(shape([row("1"), row("2"), row("3")])).toEqual([{ file: "Mark", blocks: ["paragraph:1,2,3"] }])
  })
  it("breaks paragraphs only where the file marks them, and keeps headings on their own line", () => {
    expect(shape([
      row("h", { type: "heading" }), row("1", { paragraphStart: true }), row("2"), row("3", { paragraphStart: true }),
    ])).toEqual([{ file: "Mark", blocks: ["heading:h", "paragraph:1,2", "paragraph:3"] }])
  })
  it("starts a new section per file and keeps each passage's position for playback", () => {
    const sections = checkingDocument([row("1"), row("2", { fileId: "g", fileName: "Luke" })])
    expect(sections.map(section => section.fileName)).toEqual(["Mark", "Luke"])
    expect(sections[1].blocks[0].segments[0].index).toBe(1)
  })
  it("marks passages in running text with their verse or unit number, not the whole reference", () => {
    expect(segmentMarker("MRK 1:2")).toBe("1:2")
    expect(segmentMarker("Unit 3")).toBe("3")
  })
})

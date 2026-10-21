import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { validateIdmlTranslation, type IdmlFormatMetadataV2 } from "@aquilla/idml-roundtrip"
import {
  readSegmentPiecesFromHtml,
  reflowSegmentEdge,
  rewriteIdmlSlotTexts,
  wordBoundaryOffsets,
  type SegmentPiece,
} from "./segment-edge"

function plain(index: number, text: string, extra?: Partial<Extract<SegmentPiece, { kind: "slot" }>>): SegmentPiece {
  return { kind: "slot", index, text, emphasis: false, editable: true, broken: false, ...extra }
}

function emphasis(index: number, text: string, extra?: Partial<Extract<SegmentPiece, { kind: "slot" }>>): SegmentPiece {
  return { kind: "slot", index, text, emphasis: true, editable: true, broken: false, ...extra }
}

function texts(updates: Map<number, string> | null): Record<number, string> | null {
  if (!updates) return null
  return Object.fromEntries(updates)
}

describe("style segment edge", () => {
  it("moves whole words across a bold or italic edge and stops at a barrier", () => {
    const cases: Array<{
      name: string
      pieces: SegmentPiece[]
      slot: number
      edge: "start" | "end"
      boundary: number
      updates: Record<number, string> | null
    }> = [
      {
        name: "pulls the previous word into bold",
        pieces: [plain(0, "Hello "), plain(1, "world "), emphasis(2, "fox")],
        slot: 2,
        edge: "start",
        boundary: 6,
        updates: { 1: "", 2: "world fox" },
      },
      {
        name: "gives the bold word back to the previous run",
        pieces: [plain(0, "Hello "), emphasis(1, "world")],
        slot: 1,
        edge: "start",
        boundary: 11,
        updates: { 0: "Hello world", 1: "" },
      },
      {
        name: "pulls the next word into bold and leaves the far run",
        pieces: [emphasis(0, "fox"), plain(1, " jumps"), plain(2, " high")],
        slot: 0,
        edge: "end",
        boundary: 9,
        updates: { 0: "fox jumps", 1: "" },
      },
      {
        name: "gives the bold word to the following run",
        pieces: [emphasis(0, "fox"), plain(1, " jumps")],
        slot: 0,
        edge: "end",
        boundary: 0,
        updates: { 0: "", 1: "fox jumps" },
      },
      {
        name: "does not move when the edge is already on that word",
        pieces: [plain(0, "Hello "), emphasis(1, "world")],
        slot: 1,
        edge: "start",
        boundary: 6,
        updates: null,
      },
      {
        name: "does not cross another emphasis run",
        pieces: [emphasis(0, "bold"), plain(1, " and "), emphasis(2, "italic")],
        slot: 0,
        edge: "end",
        boundary: 9,
        updates: { 0: "bold and ", 1: "" },
      },
      {
        name: "does not cross a locked run",
        pieces: [plain(0, "Hello "), plain(1, "LOCK", { editable: false }), emphasis(2, "Go")],
        slot: 2,
        edge: "start",
        boundary: 0,
        updates: null,
      },
      {
        name: "does not cross a token",
        pieces: [plain(0, "Hello "), { kind: "barrier" }, emphasis(1, "Go")],
        slot: 1,
        edge: "start",
        boundary: 0,
        updates: null,
      },
      {
        name: "does not travel through a line break",
        pieces: [plain(0, "Hello\n", { broken: true }), emphasis(1, "Go")],
        slot: 1,
        edge: "start",
        boundary: 0,
        updates: null,
      },
      {
        name: "leaves a trailing period outside the bold word",
        pieces: [emphasis(0, "fox."), plain(1, " Then")],
        slot: 0,
        edge: "end",
        boundary: 3,
        updates: { 0: "fox", 1: ". Then" },
      },
      {
        name: "gives a trailing comma back to the following run",
        pieces: [emphasis(0, "Hello,"), plain(1, " world")],
        slot: 0,
        edge: "end",
        boundary: 5,
        updates: { 0: "Hello", 1: ", world" },
      },
    ]

    for (const sample of cases) {
      expect(texts(reflowSegmentEdge(sample.pieces, sample.slot, sample.edge, sample.boundary)), sample.name)
        .toEqual(sample.updates)
    }

    const boundaries: Array<[string, "start" | "end", number[]]> = [
      ["Hello world", "start", [0, 6, 11]],
      ["Hello world", "end", [0, 5, 11]],
      ["fox.", "end", [0, 3, 4]],
      ["Hello, world.", "start", [0, 5, 7, 12, 13]],
      ["Hello, world.", "end", [0, 5, 6, 12, 13]],
      ["don't.", "end", [0, 5, 6]],
      ["(word)", "start", [0, 1, 5, 6]],
      ["why?", "end", [0, 3, 4]],
    ]
    for (const [sample, edge, offsets] of boundaries) {
      expect(wordBoundaryOffsets(sample, edge), `${edge} ${sample}`).toEqual(offsets)
    }
  })

  it("writes the moved words back into the protected paragraph", () => {
    const html =
      `<p data-idml-version="2">`
      + `<span data-idml-slot="0" data-idml-character-style="CharacterStyle/Body" data-idml-protected="slot">Hello world </span>`
      + `<span data-idml-token="0" data-idml-token-kind="tab" data-idml-protected="token" contenteditable="false"></span>`
      + `<span data-idml-slot="1" data-idml-character-style="CharacterStyle/Bold" data-idml-protected="slot">fox</span>`
      + `</p>`
    const pieces = readSegmentPiecesFromHtml(html)
    expect(pieces.map((piece) => piece.kind)).toEqual(["slot", "barrier", "slot"])
    const updates = reflowSegmentEdge(pieces, 1, "start", 0)
    expect(updates).toBeNull()

    const moved = rewriteIdmlSlotTexts(html, new Map([[1, "quick fox"]]))
    expect(moved).toContain(">quick fox</span>")
    expect(moved).toContain("data-idml-token-kind=\"tab\"")
    expect(moved).not.toContain("idml-style-")

    const metadata: IdmlFormatMetadataV2 = {
      version: 2,
      slotCount: 2,
      editableSlotIndexes: [0, 1],
      protectedTokenCount: 1,
      anchorSequenceHash: createHash("sha256").update([
        "slot:0:editable:CharacterStyle/Body",
        "token:0:tab",
        "slot:1:editable:CharacterStyle/Bold",
      ].join("\u0000")).digest("hex"),
    }
    expect(validateIdmlTranslation(html, moved ?? "", metadata).valid).toBe(true)
  })
})

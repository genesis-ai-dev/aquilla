// The cue-link graph, both directions. (AQU-646 stage 4)
//
// The route returns a flat edge list touching one file from either side; this
// is the index every caller actually uses. Many-to-many is the normal case,
// not an edge case: on episode 101, 93 subtitle cells are performed as two or
// more heard lines and 154 heard lines span two or more subtitle rows.

import { describe, it, expect } from "vitest"

import { buildCueLinkIndex, EMPTY_CUE_LINK_INDEX, type CueLink } from "./cell-links-read"

const edge = (fromCellId: string, toCellId: string): CueLink => ({
  kind: "text-audio",
  fromFileId: "f-subs",
  fromCellId,
  toFileId: "f-cues",
  toCellId,
  origin: "auto",
  confidence: 0.9,
})

describe("buildCueLinkIndex", () => {
  it("indexes a plain one-to-one pairing both ways", () => {
    const idx = buildCueLinkIndex([edge("sub-1", "cue-1")])
    expect(idx.cuesForText.get("sub-1")).toEqual(["cue-1"])
    expect(idx.textForCue.get("cue-1")).toEqual(["sub-1"])
  })

  it("holds a SPLIT sentence — one subtitle performed as several cues", () => {
    // The case that forces takes onto cue cells: cell_audio allows one selected
    // recording per cell, so this line could never hold three takes.
    const idx = buildCueLinkIndex([
      edge("sub-1", "cue-1"),
      edge("sub-1", "cue-2"),
      edge("sub-1", "cue-3"),
    ])
    expect(idx.cuesForText.get("sub-1")).toEqual(["cue-1", "cue-2", "cue-3"])
    expect(idx.textForCue.get("cue-2")).toEqual(["sub-1"])
  })

  it("holds a MERGED line — one heard line covering several subtitle rows", () => {
    const idx = buildCueLinkIndex([edge("sub-1", "cue-1"), edge("sub-2", "cue-1")])
    expect(idx.textForCue.get("cue-1")).toEqual(["sub-1", "sub-2"])
    expect(idx.cuesForText.get("sub-1")).toEqual(["cue-1"])
  })

  it("leaves an unlinked cue absent rather than mapping it to an empty list", () => {
    // Absent and empty must stay distinguishable: the timeline marks a cue with
    // no subtitle behind it, and that is a real state, not a missing lookup.
    const idx = buildCueLinkIndex([edge("sub-1", "cue-1")])
    expect(idx.textForCue.has("cue-9")).toBe(false)
    expect(idx.cuesForText.has("sub-9")).toBe(false)
  })

  it("returns empty maps for no edges", () => {
    const idx = buildCueLinkIndex([])
    expect(idx.cuesForText.size).toBe(0)
    expect(EMPTY_CUE_LINK_INDEX.textForCue.size).toBe(0)
  })
})

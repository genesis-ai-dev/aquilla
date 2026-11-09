// AQU-2493 (review, Nov 9): which Undo steps the Station's own button acts on.
import { describe, expect, it } from "vitest"
import { stationStepMatch } from "./own-steps"

describe("the Station's own Undo steps", () => {
  const mine = stationStepMatch("c331", "t2.webm")

  it("are changes to the open take: trim, volume and fades, move, rename, a saved version, a delete, an approval", () => {
    for (const kind of ["take.window", "take.gain", "take.place", "take.rename", "take.add", "take.remove", "vote.audio"]) {
      expect(mine(kind, { cellId: "c331", audioId: "t2.webm" })).toBe(true)
    }
  })

  it("include a version made of a cut take when the open take is one of its later pieces", () => {
    expect(mine("take.add", { cellId: "c331", audioId: "dn.wav", pieces: ["t2.webm"] })).toBe(true)
  })

  it("are never the line's own changes, which name no take", () => {
    expect(mine("text.commit", { cellId: "c331", side: "target", lane: "" })).toBe(false)
    expect(mine("vote.text", { cellId: "c331", lane: "", voted: true })).toBe(false)
    expect(mine("row.retime", { cellId: "c331" })).toBe(false)
    expect(mine("row.hidden", { cellId: "c331", hidden: true })).toBe(false)
    expect(mine("cast.assign", { cellId: "c331" })).toBe(false)
  })

  it("are never another take's, another line's, or a choice of which take plays", () => {
    expect(mine("take.gain", { cellId: "c331", audioId: "t1.webm" })).toBe(false)
    expect(mine("take.gain", { cellId: "c9", audioId: "t2.webm" })).toBe(false)
    expect(mine("take.select", { cellId: "c331", slot: "recording", before: "t1.webm", after: "t2.webm" })).toBe(false)
    // A non-take step that happens to carry the same ids.
    expect(mine("comment.create", { cellId: "c331", audioId: "t2.webm" })).toBe(false)
    expect(mine("take.gain", null)).toBe(false)
  })
})

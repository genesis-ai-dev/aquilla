// SUB-28: the discourse windows (preceding target context / following source)
// must read media sections through their transcript — never the import
// filename — and skip untranscribed sections entirely.

import { describe, it, expect } from "vitest"
import { gatherPrecedingContext, gatherFollowingSource } from "./draft-context"

const text = (id: string, original: string, translated = "", status = "unvalidated") =>
  ({ id, fileId: "f1", original, translated, status })
const media = (id: string, transcription: string | undefined, translated = "", status = "unvalidated") =>
  ({ id, fileId: "f1", original: "episode.mp3", translated, status, medium: "media" as const, transcription })

describe("draft-context — media sections (SUB-28)", () => {
  it("preceding context shows a validated media cell's TRANSCRIPT, not the filename", () => {
    const cells = [
      media("m1", "in the beginning", "au commencement", "validated"),
      text("t1", "verse two"),
    ]
    const out = gatherPrecedingContext(cells, "t1", 3)
    expect(out).toEqual([{ source: "in the beginning", target: "au commencement" }])
  })

  it("an untranscribed media cell is skipped in the preceding window", () => {
    const cells = [
      media("m0", undefined, "quelque chose", "validated"),
      text("t1", "verse two"),
    ]
    expect(gatherPrecedingContext(cells, "t1", 3)).toEqual([])
  })

  it("following source shows transcripts and skips untranscribed sections", () => {
    const cells = [
      text("t1", "verse one"),
      media("m1", "and the word", ""),
      media("m2", undefined, ""),
      media("m3", "was with god", ""),
    ]
    expect(gatherFollowingSource(cells, "t1", 5)).toEqual([
      { source: "and the word" },
      { source: "was with god" },
    ])
  })
})

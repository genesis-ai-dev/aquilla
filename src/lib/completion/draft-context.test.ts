// SUB-28: the discourse windows (preceding target context / following source)
// must read media sections through their transcript — never the import
// filename — and skip untranscribed sections entirely.

import { describe, it, expect } from "vitest"
import { gatherPrecedingContext, gatherFollowingSource, mergeInRunDraftContext } from "./draft-context"

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

describe("mergeInRunDraftContext (AQU-1386)", () => {
  const approved = [
    { source: "s1", target: "t1" },
    { source: "s2", target: "t2" },
  ]
  const drafts = [
    { source: "s3", target: "d3" },
    { source: "s4", target: "d4" },
  ]

  it("appends this run's drafts after the approved window, newest last", () => {
    expect(mergeInRunDraftContext(approved, drafts, 10)).toEqual([
      { source: "s1", target: "t1" },
      { source: "s2", target: "t2" },
      { source: "s3", target: "d3", draft: true },
      { source: "s4", target: "d4", draft: true },
    ])
  })

  it("marks every carried draft, and nothing approved", () => {
    const out = mergeInRunDraftContext(approved, drafts, 10)
    expect(out.filter((r) => r.draft)).toHaveLength(2)
    expect(out.slice(0, 2).every((r) => r.draft === undefined)).toBe(true)
  })

  it("applies the budget to the COMBINED list, keeping the nearest rows", () => {
    // The point of the window is proximity. A run's fresh drafts are the
    // closest context there is, so they displace the oldest approved rows
    // rather than being appended past the budget.
    expect(mergeInRunDraftContext(approved, drafts, 3)).toEqual([
      { source: "s2", target: "t2" },
      { source: "s3", target: "d3", draft: true },
      { source: "s4", target: "d4", draft: true },
    ])
  })

  it("returns nothing at budget 0", () => {
    // `slice(-0)` is `slice(0)` and would hand back the ENTIRE run. A project
    // that turned the discourse window off must get an empty window.
    expect(mergeInRunDraftContext(approved, drafts, 0)).toEqual([])
    expect(mergeInRunDraftContext(approved, drafts, -1)).toEqual([])
  })

  it("is the identity on the approved window when the run has drafted nothing", () => {
    // The first call of a run must be byte-identical to today's behaviour.
    expect(mergeInRunDraftContext(approved, [], 5)).toEqual(approved)
  })
})

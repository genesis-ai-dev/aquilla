import { describe, it, expect } from "vitest"
import { parseLabelTrack, groupSegmentsByVerse } from "./label-track"

describe("parseLabelTrack", () => {
  it("parses tab-separated start/end/label lines into segments", () => {
    const content = "0.000000\t1.841582\t1a\n1.841582\t12.049205\t1b\n"
    const segs = parseLabelTrack(content)
    expect(segs).toEqual([
      { start: 0, end: 1.841582, label: "1a", verseId: "1", phrase: "a" },
      { start: 1.841582, end: 12.049205, label: "1b", verseId: "1", phrase: "b" },
    ])
  })
})

describe("groupSegmentsByVerse", () => {
  it("collapses the phrase segments of a verse into one [startMs,endMs] window", () => {
    const segs = parseLabelTrack(
      [
        "0.000000\t1.841582\t1a",
        "1.841582\t12.049205\t1b",
        "12.049205\t14.758961\t1c",
        "23.440703\t29.616521\t2a",
        "29.616521\t34.006511\t2b",
      ].join("\n"),
    )
    expect(groupSegmentsByVerse(segs)).toEqual([
      { verseId: "1", startMs: 0, endMs: 14759 },
      { verseId: "2", startMs: 23441, endMs: 34007 },
    ])
  })

  it("keeps a verse range as a single grouping key matching the USFM \\v range", () => {
    const segs = parseLabelTrack(
      ["100.0\t101.0\t32-34a", "101.0\t105.5\t32-34b", "105.5\t110.0\t35a"].join("\n"),
    )
    expect(groupSegmentsByVerse(segs)).toEqual([
      { verseId: "32-34", startMs: 100000, endMs: 105500 },
      { verseId: "35", startMs: 105500, endMs: 110000 },
    ])
  })
})

describe("parseLabelTrack — real-data shapes", () => {
  it("handles a phrase-less verse label (no trailing letter)", () => {
    const [seg] = parseLabelTrack("133.640179\t140.765959\t9\n")
    expect(seg).toMatchObject({ verseId: "9", phrase: "", label: "9" })
  })

  it("splits a verse-range label into range id + phrase letter", () => {
    const [seg] = parseLabelTrack("206.833606\t212.439587\t32-34q\n")
    expect(seg).toMatchObject({ verseId: "32-34", phrase: "q" })
  })

  it("tolerates Windows CRLF, blank lines, and skips malformed rows", () => {
    // \r\n endings, a blank line, and a header row that lacks the 3rd column.
    const content = "0.0\t1.0\t1a\r\n\r\ngarbage-without-tabs\r\n2.0\t3.0\t1b\r\n"
    const segs = parseLabelTrack(content)
    expect(segs.map((s) => s.label)).toEqual(["1a", "1b"])
    expect(segs[0].end).toBe(1)
  })

  it("skips rows whose timestamps are not numeric", () => {
    const segs = parseLabelTrack("abc\tdef\t1a\n0.0\t1.0\t1b\n")
    expect(segs.map((s) => s.label)).toEqual(["1b"])
  })
})

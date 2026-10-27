// AQU-1758: a book or document on the timeline — one chapter at a time, and
// headings, section breaks and hidden lines off it unless recorded.
import { describe, expect, it } from "vitest"
import type { CellData } from "@/hooks/useCells"
import {
  chapterOfCell,
  hasRealChapters,
  nextPlayableChapter,
  PART_MAX_SEC,
  resolveTimelineChapter,
  scopeCells,
  sequenceTimelineCells,
  splitIntoParts,
  staysOffSequenceTimeline,
  type TimelineChapter,
  type TimelineLineSpan,
} from "./sequence-timeline"

const line = (id: string, opts: { type?: string; hidden?: boolean; recorded?: boolean } = {}): CellData =>
  ({
    id,
    fileId: "f1",
    medium: "text",
    original: `Text of ${id}`,
    translated: "",
    ...(opts.type ? { type: opts.type } : {}),
    ...(opts.hidden ? { hidden: true } : {}),
    ...(opts.recorded
      ? {
          selectedAudioId: `audio-${id}-take.webm`,
          attachments: { [`audio-${id}-take.webm`]: { type: "audio", url: "frontier-audio://t", durationMs: 3000 } },
        }
      : {}),
  }) as unknown as CellData

const CHAPTERS: TimelineChapter[] = [
  { key: "RUT 1", cellIds: ["h1", "v1", "v2"] },
  { key: "RUT 2", cellIds: ["h2", "v3", "v4"] },
  { key: "RUT 3", cellIds: ["v5", "v6"] },
]

describe("which lines a sequence file's timeline leaves off", () => {
  // Sam's decision 2: headings follow "Count headings as translatable content".
  it("draws a heading and a section break like any line when headings count", () => {
    expect(staysOffSequenceTimeline(line("h", { type: "heading" }), true)).toBe(false)
    expect(staysOffSequenceTimeline(line("p", { type: "paratext" }), true)).toBe(false)
    // The setting's own default: project, else org, else true.
    expect(staysOffSequenceTimeline(line("h", { type: "heading" }))).toBe(false)
  })

  it("leaves off an unrecorded heading and section break when headings do not count", () => {
    expect(staysOffSequenceTimeline(line("h", { type: "heading" }), false)).toBe(true)
    expect(staysOffSequenceTimeline(line("p", { type: "paratext" }), false)).toBe(true)
  })

  it("leaves off a hidden line nobody recorded, whatever the setting", () => {
    expect(staysOffSequenceTimeline(line("x", { hidden: true }), true)).toBe(true)
    expect(staysOffSequenceTimeline(line("x", { hidden: true }), false)).toBe(true)
  })

  it("draws any of them once it has a recording", () => {
    expect(staysOffSequenceTimeline(line("h", { type: "heading", recorded: true }), false)).toBe(false)
    expect(staysOffSequenceTimeline(line("p", { type: "paratext", recorded: true }), false)).toBe(false)
    expect(staysOffSequenceTimeline(line("x", { hidden: true, recorded: true }))).toBe(false)
  })

  it("always draws a verse, recorded or not", () => {
    expect(staysOffSequenceTimeline(line("v"))).toBe(false)
    expect(staysOffSequenceTimeline(line("v", { type: "verse" }))).toBe(false)
    expect(staysOffSequenceTimeline(line("v", { recorded: true }))).toBe(false)
  })
})

describe("the lines one chapter puts on the timeline", () => {
  const cells = [
    line("h1", { type: "heading" }), line("v1", { recorded: true }), line("v2"),
    line("h2", { type: "heading", recorded: true }), line("v3"), line("v4", { hidden: true }),
    line("v5"), line("v6"),
  ]

  it("keeps only the chapter's lines, in the file's order, without its unrecorded heading when headings do not count", () => {
    expect(sequenceTimelineCells(cells, CHAPTERS[0], false).map((c) => c.id)).toEqual(["v1", "v2"])
  })

  it("keeps the chapter's heading when headings count", () => {
    expect(sequenceTimelineCells(cells, CHAPTERS[0], true).map((c) => c.id)).toEqual(["h1", "v1", "v2"])
  })

  it("keeps a recorded heading and drops an unrecorded hidden verse", () => {
    expect(sequenceTimelineCells(cells, CHAPTERS[1], false).map((c) => c.id)).toEqual(["h2", "v3"])
  })

  it("covers the whole file when there are no chapters", () => {
    expect(sequenceTimelineCells(cells, null, false).map((c) => c.id)).toEqual(["v1", "v2", "h2", "v3", "v5", "v6"])
    expect(scopeCells(cells, null)).toHaveLength(cells.length)
    expect(scopeCells(cells, CHAPTERS[2]).map((c) => c.id)).toEqual(["v5", "v6"])
  })
})

describe("the chapter the timeline shows", () => {
  it("is the chapter the person is on", () => {
    expect(resolveTimelineChapter({ chapters: CHAPTERS, chosenKey: "RUT 2", queueCellId: null })?.key).toBe("RUT 2")
  })

  it("is the chapter playback is on, so a run carries it into the next chapter", () => {
    expect(resolveTimelineChapter({ chapters: CHAPTERS, chosenKey: "RUT 1", queueCellId: "v3" })?.key).toBe("RUT 2")
  })

  it("ignores a playing line from another file", () => {
    expect(resolveTimelineChapter({ chapters: CHAPTERS, chosenKey: "RUT 3", queueCellId: "elsewhere" })?.key).toBe("RUT 3")
  })

  it("starts on the first chapter, and is null for a file with no chapters", () => {
    expect(resolveTimelineChapter({ chapters: CHAPTERS, chosenKey: null, queueCellId: null })?.key).toBe("RUT 1")
    expect(resolveTimelineChapter({ chapters: CHAPTERS, chosenKey: "gone", queueCellId: null })?.key).toBe("RUT 1")
    expect(resolveTimelineChapter({ chapters: [], chosenKey: "RUT 1", queueCellId: null })).toBeNull()
  })

  it("finds the chapter holding a line", () => {
    expect(chapterOfCell(CHAPTERS, "v6")?.key).toBe("RUT 3")
    expect(chapterOfCell(CHAPTERS, "nope")).toBeNull()
    expect(chapterOfCell(CHAPTERS, null)).toBeNull()
  })
})

describe("where Play all goes at the end of a chapter", () => {
  it("goes on to the next chapter", () => {
    expect(nextPlayableChapter(CHAPTERS, "RUT 1", () => true)?.key).toBe("RUT 2")
  })

  it("steps over a chapter with nothing to play", () => {
    expect(nextPlayableChapter(CHAPTERS, "RUT 1", (c) => c.key !== "RUT 2")?.key).toBe("RUT 3")
  })

  it("stops at the end of the file", () => {
    expect(nextPlayableChapter(CHAPTERS, "RUT 3", () => true)).toBeNull()
    expect(nextPlayableChapter(CHAPTERS, "RUT 1", () => false)).toBeNull()
    expect(nextPlayableChapter(CHAPTERS, "unknown", () => true)).toBeNull()
  })
})

describe("which divisions are chapters", () => {
  it("counts the divisions that came from the file", () => {
    expect(hasRealChapters([{ kind: "chapter" }, { kind: "chapter" }])).toBe(true)
    expect(hasRealChapters([{ kind: "preface" }, { kind: "chapter" }])).toBe(true)
    expect(hasRealChapters([{ kind: "section" }])).toBe(true)
  })

  it("does not count the app's own 50-line parts or 5-minute ranges", () => {
    expect(hasRealChapters([{ kind: "part" }, { kind: "part" }])).toBe(false)
    expect(hasRealChapters([{ kind: "time-range" }])).toBe(false)
    expect(hasRealChapters([])).toBe(false)
  })
})

// Sam's decision 1: over 90 minutes, a file with no chapters shows in parts.
describe("a long file's parts", () => {
  /** `n` lines of `lenSec` each, end to end from 0. */
  const even = (n: number, lenSec: number): TimelineLineSpan[] =>
    Array.from({ length: n }, (_, i) => ({ cellId: `l${i}`, startSec: i * lenSec, lenSec }))

  it("is the whole file at 90 minutes or less", () => {
    expect(PART_MAX_SEC).toBe(5400)
    expect(splitIntoParts(even(450, 12))).toEqual([]) // exactly 90:00
    expect(splitIntoParts(even(10, 60))).toEqual([])
  })

  it("is the fewest roughly equal parts, each 90 minutes or less, cut at line boundaries", () => {
    const parts = splitIntoParts(even(600, 12)) // 2 h
    expect(parts.map((p) => p.cellIds.length)).toEqual([300, 300])
    expect(parts.map((p) => [p.startSec, p.endSec])).toEqual([[0, 3600], [3600, 7200]])
    expect(parts.map((p) => `${p.key} ${p.index + 1}/${p.count}`)).toEqual(["part:1 1/2", "part:2 2/2"])
    // Every line in exactly one part, in order.
    expect(parts.flatMap((p) => p.cellIds)).toEqual(even(600, 12).map((l) => l.cellId))
  })

  it("takes a third part only when two would not fit", () => {
    expect(splitIntoParts(even(900, 12)).map((p) => p.cellIds.length)).toEqual([450, 450]) // 3 h: two of 90
    const three = splitIntoParts(even(901, 12)).map((p) => p.cellIds.length)
    expect(three).toHaveLength(3)
    expect(Math.max(...three) - Math.min(...three)).toBeLessThanOrEqual(1)
  })

  it("measures a timed file from its first line, with the gaps between lines", () => {
    // A subtitle file just over 3 hours: a line every 10 s, each 6 s long, from 0:30.
    const lines = Array.from({ length: 1100 }, (_, i) => ({ cellId: `c${i}`, startSec: 30 + i * 10, lenSec: 6 }))
    const parts = splitIntoParts(lines)
    expect(parts).toHaveLength(3)
    for (const p of parts) expect(p.endSec - p.startSec).toBeLessThanOrEqual(PART_MAX_SEC)
    expect(parts[0].startSec).toBe(30)
  })

  it("never cuts a line: one longer than 90 minutes is a part of its own", () => {
    const lines = [
      { cellId: "a", startSec: 0, lenSec: 60 },
      { cellId: "long", startSec: 60, lenSec: 6000 },
      { cellId: "b", startSec: 6060, lenSec: 60 },
    ]
    const parts = splitIntoParts(lines)
    expect(parts.flatMap((p) => p.cellIds)).toEqual(["a", "long", "b"])
    expect(parts.some((p) => p.cellIds.length === 1 && p.cellIds[0] === "long")).toBe(true)
  })
})

// AQU-1758: a book or document on the timeline — one chapter at a time, and
// headings, section breaks and hidden lines off it unless recorded.
import { describe, expect, it } from "vitest"
import type { CellData } from "@/hooks/useCells"
import {
  chapterOfCell,
  nextPlayableChapter,
  resolveTimelineChapter,
  sequenceTimelineCells,
  staysOffSequenceTimeline,
  type TimelineChapter,
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
  it("leaves off a heading, a section break and a hidden line that nobody recorded", () => {
    expect(staysOffSequenceTimeline(line("h", { type: "heading" }))).toBe(true)
    expect(staysOffSequenceTimeline(line("p", { type: "paratext" }))).toBe(true)
    expect(staysOffSequenceTimeline(line("x", { hidden: true }))).toBe(true)
  })

  it("draws any of them once it has a recording", () => {
    expect(staysOffSequenceTimeline(line("h", { type: "heading", recorded: true }))).toBe(false)
    expect(staysOffSequenceTimeline(line("p", { type: "paratext", recorded: true }))).toBe(false)
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

  it("keeps only the chapter's lines, in the file's order, without its unrecorded heading", () => {
    expect(sequenceTimelineCells(cells, CHAPTERS[0]).map((c) => c.id)).toEqual(["v1", "v2"])
  })

  it("keeps a recorded heading and drops an unrecorded hidden verse", () => {
    expect(sequenceTimelineCells(cells, CHAPTERS[1]).map((c) => c.id)).toEqual(["h2", "v3"])
  })

  it("covers the whole file when there are no chapters", () => {
    expect(sequenceTimelineCells(cells, null).map((c) => c.id)).toEqual(["v1", "v2", "h2", "v3", "v5", "v6"])
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

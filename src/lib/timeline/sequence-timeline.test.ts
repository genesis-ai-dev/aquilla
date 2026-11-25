// AQU-1758: a book or document on the timeline — one chapter at a time, and
// headings, section breaks and hidden lines off it unless recorded.
import { describe, expect, it } from "vitest"
import type { CellData } from "@/hooks/useCells"
import {
  chapterOfCell,
  hasRealChapters,
  heardLinesOfMilestone,
  nextPlayableChapter,
  resolveTimelineChapter,
  scopeCells,
  sequenceTimelineCells,
  staysOffSequenceTimeline,
  timelineCellsForMilestoneSplit,
  timelineChaptersOf,
  type TimelineChapter,
} from "./sequence-timeline"
import { layOutProgramme } from "./programme"

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

  it("covers every chapter when the timeline draws the whole file", () => {
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

describe("split into milestones on the timeline", () => {
  const cells = [line("a"), line("b"), line("c"), line("d")]
  const milestones = [
    { key: "m1", cellIds: ["a", "b"] },
    { key: "m2", cellIds: ["c", "d"] },
  ]

  it("draws the open milestone when the split is on, and the whole file when it is off", () => {
    const cases: {
      name: string
      split: boolean
      milestones: { key: string; cellIds: string[] }[]
      key: string | null
      want: string[] | "same"
    }[] = [
      { name: "split off", split: false, milestones, key: "m2", want: "same" },
      { name: "the milestone on the page", split: true, milestones, key: "m2", want: ["c", "d"] },
      { name: "no page chosen yet", split: true, milestones, key: null, want: ["a", "b"] },
      { name: "a key from another file", split: true, milestones, key: "gone", want: ["a", "b"] },
      { name: "a file with no milestones", split: true, milestones: [], key: "m1", want: "same" },
      { name: "the only milestone is the whole file", split: true, milestones: [{ key: "all", cellIds: ["a", "b", "c", "d"] }], key: "all", want: "same" },
      { name: "an empty milestone", split: true, milestones: [{ key: "empty", cellIds: [] }], key: "empty", want: [] },
    ]
    for (const entry of cases) {
      const shown = timelineCellsForMilestoneSplit(cells, {
        split: entry.split,
        milestones: entry.milestones,
        milestoneKey: entry.key,
      })
      if (entry.want === "same") expect(shown, entry.name).toBe(cells)
      else expect(shown.map((cell) => cell.id), entry.name).toEqual(entry.want)
    }
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

// Sam, Oct 28: the long-file parts are dropped. A file with no chapters
// shows WHOLE on the timeline, however long; a book still goes one chapter at
// a time.
describe("a file with no chapters, however long", () => {
  it("shows all of a 100-minute document's lines on the timeline", () => {
    // 500 recorded lines of 12 s: 1 h 40 min. The table pages a file with no
    // chapters in 50-line "Part"s; those are not chapters.
    const lines = Array.from({ length: 500 }, (_, i) => ({
      id: `l${i}`,
      fileId: "f1",
      medium: "text",
      original: `Line ${i}`,
      translated: "",
      selectedAudioId: `audio-l${i}-take.webm`,
      attachments: { [`audio-l${i}-take.webm`]: { type: "audio", url: "frontier-audio://t", durationMs: 12_000 } },
    }) as unknown as CellData)
    const navigation = Array.from({ length: 10 }, (_, k) => ({
      key: `part-${k + 1}`,
      kind: "part",
      cellIds: lines.slice(k * 50, k * 50 + 50).map((l) => l.id),
    }))
    const chapters = timelineChaptersOf(navigation)
    expect(chapters).toEqual([])
    const shown = scopeCells(
      sequenceTimelineCells(lines, null),
      resolveTimelineChapter({ chapters, chosenKey: "part-2", queueCellId: "l300" }),
    )
    expect(shown).toHaveLength(500)
    const { programme } = layOutProgramme(shown)
    expect(programme.slots).toHaveLength(500)
    expect(programme.totalSec).toBeCloseTo(6000, 5)
  })

  it("keeps a book's own chapters, one at a time", () => {
    const chapters = timelineChaptersOf([
      { key: "RUT 1", kind: "chapter", cellIds: ["v1", "v2"] },
      { key: "RUT 2", kind: "chapter", cellIds: ["v3"] },
    ])
    expect(chapters.map((c) => c.key)).toEqual(["RUT 1", "RUT 2"])
    expect(resolveTimelineChapter({ chapters, chosenKey: "RUT 2", queueCellId: null })?.key).toBe("RUT 2")
  })
})

// AQU-2711 x AQU-2253 (review, Nov 25): a subtitle file paired with an audio
// cue file, split into milestones. The heard lines are cut to the milestone
// once, so the timeline and Play show the same page as the subtitle cards.
describe("heardLinesOfMilestone", () => {
  const timed = (id: string, startTime?: number, endTime?: number): CellData =>
    ({ id, value: id, startTime, endTime } as unknown as CellData)
  const all = [timed("s1", 0, 4), timed("s2", 4, 8), timed("s3", 8, 12), timed("s4", 12, 16)]
  const milestone = [all[1], all[2]]
  const heard = [timed("c1", 1, 3), timed("c2", 5, 7), timed("c3", 9, 11), timed("c4", 13, 15), timed("c5"), timed("c6", 20, 22)]

  it("keeps the heard lines paired with the milestone's lines or inside its time range", () => {
    // c6 sits outside the range but is paired with s2; c1 sits outside and is
    // paired with nothing on the page; c5 has no times and no pair.
    const textForCue = new Map<string, readonly string[]>([["c6", ["s2"]], ["c1", ["s1"]]])
    expect(heardLinesOfMilestone(heard, milestone, all, textForCue)?.map((c) => c.id)).toEqual(["c2", "c3", "c6"])
  })

  it("a cue paired only with lines off the page stays off it, even inside the range", () => {
    const textForCue = new Map<string, readonly string[]>([["c2", ["s4"]]])
    expect(heardLinesOfMilestone(heard, milestone, all, textForCue)?.map((c) => c.id)).toEqual(["c3"])
  })

  it("the whole file on the timeline (split off): the heard lines, unchanged", () => {
    expect(heardLinesOfMilestone(heard, all, all, new Map())).toBe(heard)
  })

  it("no heard lines: none", () => {
    expect(heardLinesOfMilestone(null, milestone, all, new Map())).toBeNull()
  })
})

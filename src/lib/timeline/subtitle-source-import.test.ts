import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  importSubtitleSourceCells,
  parseSubtitleSidecar,
  planSubtitleSourceCells,
  SUBTITLE_SIDECAR_ACCEPT,
  subtitleExtractionRefusal,
} from "./subtitle-source-import"

// Typed with its argument so `mock.calls[n][0]` is inspectable — an untyped
// `vi.fn()` infers a zero-arg tuple and every assertion below becomes a cast.
const emitSourceCellCreate = vi.hoisted(() =>
  vi.fn(async (input: Record<string, unknown>) => `event-${String(input.cellId)}`),
)
vi.mock("@/lib/sync/events-emit", () => ({ emitSourceCellCreate }))

const VTT = `WEBVTT

00:00:01.000 --> 00:00:03.500
The art of survival

00:00:04.000 --> 00:00:06.250
begins with water.
`

describe("parseSubtitleSidecar", () => {
  it("refuses a file that isn't a subtitle format", () => {
    expect(() => parseSubtitleSidecar("episode.mp4", "")).toThrow(/isn't a subtitle file/)
  })

  it("refuses a subtitle file with no cues", () => {
    expect(() => parseSubtitleSidecar("episode.vtt", "WEBVTT\n\n")).toThrow(/No subtitle cues/)
  })

  it("parses VTT cues with their timings and span", () => {
    const { cues, report } = parseSubtitleSidecar("episode.vtt", VTT)
    expect(cues.map((c) => c.original)).toEqual(["The art of survival", "begins with water."])
    expect(report.format).toBe("vtt")
    expect(report.totalCues).toBe(2)
    expect(report.untimedCues).toBe(0)
    expect(report.droppedCues).toBe(0)
    expect(report.spanStartMs).toBe(1000)
    expect(report.spanEndMs).toBe(6250)
  })

  it("rescues a short-form VTT timestamp and counts the repair", () => {
    // `01:03.209 --> 01:03.667` is legal WebVTT but `extractVttStrings` is
    // strict, so without the padding pass this cue vanishes WITH ITS WORDS —
    // the silent-loss trap `repairShortFormCueTimestamps` exists for.
    const { cues, report } = parseSubtitleSidecar(
      "episode.vtt",
      "WEBVTT\n\n01:03.209 --> 01:03.667\nshort form\n",
    )
    expect(cues).toHaveLength(1)
    expect(cues[0].original).toBe("short form")
    expect(report.repairedShortForm).toBe(1)
    expect(report.spanStartMs).toBe(63_209)
  })

  it("counts a timestamp line that produced no cue as dropped", () => {
    const { cues, report } = parseSubtitleSidecar(
      "episode.vtt",
      `WEBVTT

00:00:01.000 --> 00:00:02.000
kept

00:00:03.000 --> 00:00:04.000
`,
    )
    expect(cues).toHaveLength(1)
    expect(report.droppedCues).toBe(1)
  })

  it("parses SRT comma fractions without treating them as repairs", () => {
    const { cues, report } = parseSubtitleSidecar(
      "episode.srt",
      "1\n00:00:02,000 --> 00:00:04,000\nSrt line\n",
    )
    expect(cues.map((c) => c.original)).toEqual(["Srt line"])
    expect(report.format).toBe("srt")
    expect(report.repairedShortForm).toBe(0)
    expect(report.spanStartMs).toBe(2000)
    expect(report.spanEndMs).toBe(4000)
  })

  it("parses SBV, and reports no drop count for it", () => {
    // SBV ranges are comma-separated, so the `-->` denominator the other two
    // formats use does not exist — 0 here means "not countable", not "clean".
    const { cues, report } = parseSubtitleSidecar(
      "episode.sbv",
      "0:00:05.000,0:00:07.000\nSbv line\n\n0:00:08.000,0:00:09.000\n",
    )
    expect(cues.map((c) => c.original)).toEqual(["Sbv line"])
    expect(report.format).toBe("sbv")
    expect(report.droppedCues).toBe(0)
  })

  it("reads the span from the extremes, not the first and last cue", () => {
    // An unsorted sidecar is legal, and a span read off the ends of one is
    // wrong in the direction that still looks plausible.
    const { report } = parseSubtitleSidecar(
      "episode.vtt",
      `WEBVTT

00:00:09.000 --> 00:00:10.000
later

00:00:01.000 --> 00:00:02.000
earlier
`,
    )
    expect(report.spanStartMs).toBe(1000)
    expect(report.spanEndMs).toBe(10_000)
  })

  it("accepts exactly the three formats the picker offers", () => {
    expect(SUBTITLE_SIDECAR_ACCEPT).toBe(".vtt,.srt,.sbv")
  })
})

describe("planSubtitleSourceCells", () => {
  it("chains the cues after the file's current tail and continues its sequence", () => {
    const { cues } = parseSubtitleSidecar("episode.vtt", VTT)
    const specs = planSubtitleSourceCells(cues, {
      anchorCellId: "tail-cell",
      startSequenceIndex: 3,
    })
    expect(specs).toHaveLength(2)
    expect(specs[0].anchorCellId).toBe("tail-cell")
    expect(specs[1].anchorCellId).toBe(specs[0].cellId)
    expect(specs.map((s) => s.sequenceIndex)).toEqual([3, 4])
    // Fresh ids, never the parser's — cell identity is minted here.
    expect(specs[0].cellId).not.toBe(specs[1].cellId)
  })

  it("heads the file when there is no tail to anchor on", () => {
    const { cues } = parseSubtitleSidecar("episode.vtt", VTT)
    expect(planSubtitleSourceCells(cues)[0].anchorCellId).toBeNull()
  })

  it("converts cue seconds to milliseconds the way the normalizer does", () => {
    const { cues } = parseSubtitleSidecar(
      "episode.vtt",
      "WEBVTT\n\n00:00:01.001 --> 00:00:02.999\nrounded\n",
    )
    const [spec] = planSubtitleSourceCells(cues)
    expect(spec.startMs).toBe(1001)
    expect(spec.endMs).toBe(2999)
  })

  it("leaves an untimed cue's span absent rather than filing it at the head", () => {
    const specs = planSubtitleSourceCells([
      { id: "a", original: "untimed", translated: "", context: "", group: "g", type: "cue" },
    ])
    expect(specs[0].startMs).toBeUndefined()
    expect(specs[0].endMs).toBeUndefined()
  })
})

describe("importSubtitleSourceCells", () => {
  beforeEach(() => {
    emitSourceCellCreate.mockClear()
  })

  it("emits one chained source.cell.create per cue, typed as a cue", async () => {
    const { cues } = parseSubtitleSidecar("episode.vtt", VTT)
    const result = await importSubtitleSourceCells(cues, {
      projectId: "p1",
      fileId: "f1",
      author: "dev",
      anchorCellId: "tail-cell",
      startSequenceIndex: 2,
    })

    expect(result).toEqual({ cells: 2 })
    expect(emitSourceCellCreate).toHaveBeenCalledTimes(2)

    const first = emitSourceCellCreate.mock.calls[0][0]
    const second = emitSourceCellCreate.mock.calls[1][0]
    expect(first).toMatchObject({
      projectId: "p1",
      fileId: "f1",
      author: "dev",
      anchorCellId: "tail-cell",
      value: "The art of survival",
      type: "cue",
      sequenceIndex: 2,
      startMs: 1000,
      endMs: 3500,
    })
    expect(second.anchorCellId).toBe(first.cellId)
    expect(second).toMatchObject({ sequenceIndex: 3, startMs: 4000, endMs: 6250 })
  })

  it("never sets `medium`, so the cues stay translatable text rather than media", async () => {
    const { cues } = parseSubtitleSidecar("episode.vtt", VTT)
    await importSubtitleSourceCells(cues, { projectId: "p1", fileId: "f1", author: "dev" })
    for (const [input] of emitSourceCellCreate.mock.calls) {
      expect(input).not.toHaveProperty("medium")
    }
  })
})

describe("subtitleExtractionRefusal", () => {
  const clip = [{ medium: "media" }]

  it("lets an extraction through on a clip-only file that is still the active one", () => {
    expect(
      subtitleExtractionRefusal({ dialogFileId: "f1", activeFileId: "f1", cells: clip }),
    ).toBeNull()
  })

  it("refuses once the active file has switched away from the one the report was read for", () => {
    expect(
      subtitleExtractionRefusal({ dialogFileId: "f1", activeFileId: "f2", cells: clip }),
    ).toBe("wrong-file")
    expect(
      subtitleExtractionRefusal({ dialogFileId: "f1", activeFileId: null, cells: clip }),
    ).toBe("wrong-file")
    expect(
      subtitleExtractionRefusal({ dialogFileId: null, activeFileId: null, cells: clip }),
    ).toBe("wrong-file")
  })

  it("refuses a file with no clip — the cues would have no clock to be timed against", () => {
    expect(
      subtitleExtractionRefusal({ dialogFileId: "f1", activeFileId: "f1", cells: [] }),
    ).toBe("no-clip")
    expect(
      subtitleExtractionRefusal({
        dialogFileId: "f1",
        activeFileId: "f1",
        cells: [{ medium: "text" }],
      }),
    ).toBe("no-clip")
  })

  it("refuses a file that gained source rows while the dialog was open", () => {
    // The duplication guard, checked at WRITE time. A second extraction after a
    // first one succeeded is the realistic way this fires.
    expect(
      subtitleExtractionRefusal({
        dialogFileId: "f1",
        activeFileId: "f1",
        cells: [...clip, { medium: "text" }],
      }),
    ).toBe("already-has-source-rows")
    // An absent `medium` reads as text, not as media — that is the default
    // everywhere else, and treating it as media here would wave duplicates through.
    expect(
      subtitleExtractionRefusal({
        dialogFileId: "f1",
        activeFileId: "f1",
        cells: [...clip, {}],
      }),
    ).toBe("already-has-source-rows")
  })

  it("never counts media segments as source rows, or nothing could ever be extracted", () => {
    // A clip attaches as several silence-split segments; if those counted, the
    // "no source rows" rule would be unsatisfiable on every real file.
    expect(
      subtitleExtractionRefusal({
        dialogFileId: "f1",
        activeFileId: "f1",
        cells: [{ medium: "media" }, { medium: "media" }, { medium: "media" }],
      }),
    ).toBeNull()
  })
})

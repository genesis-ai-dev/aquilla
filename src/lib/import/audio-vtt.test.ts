// The audio-VTT import's two repairs, and the shape of what it uploads.
//
// These are the riskiest lines of AQU-646 stage 2 and the ones Sam's real
// episode files flow through: a regression in the short-form repair loses cues
// SILENTLY (text and all), and a cell that arrived with `medium` set would put
// a 550-row transcript on the app's media surfaces.

import { describe, it, expect, vi, beforeEach } from "vitest"

import { parseAudioVtt, uploadAudioCueFile } from "./audio-vtt"
import { bulkUploadSource, type BulkUploadArgs } from "@/lib/sync/bulk-import"

vi.mock("@/lib/sync/bulk-import", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sync/bulk-import")>()
  return { ...actual, bulkUploadSource: vi.fn(async () => {}) }
})

beforeEach(() => {
  vi.mocked(bulkUploadSource).mockClear()
})

describe("parseAudioVtt", () => {
  it("rescues short-form timestamps the strict parser would drop, text and all", () => {
    const { cues, report } = parseAudioVtt(
      [
        "WEBVTT",
        "",
        "1",
        "01:03.209 --> 01:03.667",
        "Abba?",
        "",
        "2",
        "00:01:06.626 --> 00:01:07.751",
        "You should be sleeping, little one.",
        "",
      ].join("\n"),
    )

    expect(cues.map((cue) => cue.original)).toEqual([
      "Abba?",
      "You should be sleeping, little one.",
    ])
    expect(cues[0].start).toBeCloseTo(63.209)
    expect(cues[0].end).toBeCloseTo(63.667)
    // Only the short-form line counts — the already-strict one is untouched.
    expect(report.repairedShortForm).toBe(1)
    expect(report.droppedCues).toBe(0)
    expect(report.totalCues).toBe(2)
  })

  it("strips cue markup, and drops a cue that was nothing else", () => {
    const { cues, report } = parseAudioVtt(
      [
        "WEBVTT",
        "",
        "00:00:01.000 --> 00:00:02.000",
        "<i>Abba?</i>",
        "",
        "00:00:03.000 --> 00:00:04.000",
        "<c.loud>Look,</c> <00:00:03.500>it's right there.",
        "",
        "00:00:05.000 --> 00:00:06.000",
        "<i></i>",
        "",
      ].join("\n"),
    )

    expect(cues.map((cue) => cue.original)).toEqual([
      "Abba?",
      "Look, it's right there.",
    ])
    expect(report.strippedTagCues).toBe(3)
    expect(report.droppedCues).toBe(1)
  })

  it("finds no cues in prose or in an empty file", () => {
    expect(parseAudioVtt("").cues).toEqual([])
    expect(parseAudioVtt("Abba? You should be sleeping, little one.\n").cues).toEqual([])
    expect(parseAudioVtt("WEBVTT\n\nNOTE nothing timed here\n").report.totalCues).toBe(0)
  })
})

describe("uploadAudioCueFile", () => {
  it("uploads chained, timed, mediumless cells as a hidden audio-cue sibling", async () => {
    const { cues } = parseAudioVtt(
      [
        "WEBVTT",
        "",
        "00:01:03.209 --> 00:01:03.667",
        "Abba?",
        "",
        "00:01:06.626 --> 00:01:07.751",
        "You should be sleeping, little one.",
        "",
      ].join("\n"),
    )

    const result = await uploadAudioCueFile({
      projectId: "project-1",
      anchorFileId: "text-file-1",
      anchorFileName: "TheChosen_101_en",
      sourceFileName: "TheChosen_101_en_AUDIO_ONLY_5&2.vtt",
      cues,
      getToken: async () => "token",
    })

    expect(result.cellCount).toBe(2)
    expect(vi.mocked(bulkUploadSource)).toHaveBeenCalledTimes(1)
    const args = vi.mocked(bulkUploadSource).mock.calls[0][0] as BulkUploadArgs
    expect(args.fileId).toBe(result.fileId)
    expect(args.file).toMatchObject({
      name: "TheChosen_101_en · audio cues",
      fileType: "vtt",
      role: "audio-cues",
      kind: "vtt",
      anchorFileId: "text-file-1",
      orderedBy: "time",
      importManifest: {
        audioVtt: { sourceFileName: "TheChosen_101_en_AUDIO_ONLY_5&2.vtt", cueCount: 2 },
      },
    })
    // Nothing round-trips these cues back out, so no R2 artifact leg runs.
    expect(args.rawSource).toBeUndefined()
    expect(args.rawBytes).toBeUndefined()
    expect(args.targets).toBeUndefined()

    // Cue order is the anchor chain: first cell genesis, each next one hanging
    // off its predecessor.
    expect(args.cells[0].anchorCellId).toBeNull()
    expect(args.cells[1].anchorCellId).toBe(args.cells[0].cellId)
    expect(args.cells[0]).toMatchObject({ value: "Abba?", startMs: 63209, endMs: 63667, type: "cue" })
    expect(args.cells[1]).toMatchObject({ startMs: 66626, endMs: 67751 })
    // `medium` is the app's only cell→surface discriminator: set it and these
    // become media rows everywhere.
    for (const cell of args.cells) expect(cell).not.toHaveProperty("medium")
  })
})

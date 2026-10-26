import { describe, expect, it } from "vitest"
import type { CellAudioEntry } from "@/lib/sync/cell-audio-read-types"
import type { PlanUnit } from "@/lib/plan/plan-status"
import { findNextUnfinishedIndex } from "@/hooks/useNextUnfinished"
import {
  editorLaneTakes,
  isUnfinishedLine,
  NO_LANE_TAKES,
  planUnitsToFileProgress,
} from "./editor-lane-progress"

/** A line's audio: one selected take OF ITS OWN (seeded with the line's id) on the default track with `votes`. */
function recorded(cellId: string, votes: number): CellAudioEntry {
  const audioId = `audio-${cellId}-1700000000000-abc123`
  return {
    attachments: {
      [audioId]: {
        audioId, url: `frontier-audio://${audioId}`, slot: "recording", role: "dub",
        validatorCount: votes, validators: [],
      } as unknown as CellAudioEntry["attachments"][string],
    },
    selectedBySlot: { recording: audioId },
    selectedAudioId: audioId,
    selectedGeneratedVoiceAudioId: null,
    audioTimings: {},
  }
}

describe("which lines are recorded and approved in the open language", () => {
  const ownAudio = new Map([
    ["v1", recorded("v1", 2)],
    ["v2", recorded("v2", 1)],
    ["v3", recorded("v3", 0)],
  ])

  it("reads the open file's own recordings at the audio threshold", () => {
    const takes = editorLaneTakes({
      delivers: "audio", ownAudio, cueIds: null, cueAudio: null, cuesForText: new Map(), audioThreshold: 2,
    })
    expect([...takes.recorded].sort()).toEqual(["v1", "v2", "v3"])
    expect([...takes.approved]).toEqual(["v1"])
    expect(takes.heard).toBeNull()
  })

  it("never counts a clip that is not the line's own (the file's imported source audio)", () => {
    const fileClip = recorded("v9", 3)
    const audioId = "audio-file-1-1700000000000-abc123"
    const entry = {
      ...fileClip,
      attachments: { [audioId]: { ...Object.values(fileClip.attachments)[0], audioId } },
      selectedBySlot: { recording: audioId },
      selectedAudioId: audioId,
    } as CellAudioEntry
    const takes = editorLaneTakes({
      delivers: "audio", ownAudio: new Map([["v9", entry]]), cueIds: null, cueAudio: null,
      cuesForText: new Map(), audioThreshold: 1,
    })
    expect(takes.recorded.size).toBe(0)
  })

  it("asks nothing in a Text language, or one nobody has chosen for", () => {
    for (const delivers of ["text", null] as const) {
      expect(editorLaneTakes({
        delivers, ownAudio, cueIds: null, cueAudio: null, cuesForText: new Map(), audioThreshold: 1,
      })).toBe(NO_LANE_TAKES)
    }
  })

  it("counts a dubbing file by its heard lines, and a subtitle line by the heard lines performing it (gap 6)", () => {
    const cueAudio = new Map([
      ["q1", recorded("q1", 1)],
      ["q2", recorded("q2", 0)],
      ["q3", recorded("q3", 1)],
    ])
    const takes = editorLaneTakes({
      delivers: "audio",
      ownAudio: new Map(),
      cueIds: ["q1", "q2", "q3", "q4"],
      cueAudio,
      cuesForText: new Map([["s1", ["q1"]], ["s2", ["q2", "q3"]], ["s3", ["q4"]], ["s4", []]]),
      audioThreshold: 1,
    })
    expect(takes.heard).toEqual({ total: 4, recorded: 3, approved: 2 })
    expect([...takes.recorded].sort()).toEqual(["s1", "s2"])
    expect([...takes.approved]).toEqual(["s1"])
    expect([...takes.performed!].sort()).toEqual(["s1", "s2", "s3"])
  })
})

describe("\"Next unfinished\" in a language that counts its recordings", () => {
  const lines = [
    { id: "1:1", laneStatus: "validated" as const, translated: "", activeValidators: [] },
    { id: "1:2", laneStatus: "unvalidated" as const, translated: "", activeValidators: [] },
    { id: "1:3", laneStatus: "empty" as const, translated: "", activeValidators: [] },
    { id: "1:4", laneStatus: "validated" as const, translated: "", activeValidators: [] },
  ]

  it("stops only on lines that still lack an approved recording (P2.2)", () => {
    const rule = (cell: (typeof lines)[number]) => isUnfinishedLine(cell, null)
    expect(findNextUnfinishedIndex(lines, 0, 1, rule)).toBe(1)
    expect(findNextUnfinishedIndex(lines, 1, 1, rule)).toBe(2)
    expect(findNextUnfinishedIndex(lines, 2, 1, rule)).toBe(1)
  })

  it("never stops on a subtitle line no heard line performs (P2.7)", () => {
    const performed = new Set(["1:3"])
    const rule = (cell: (typeof lines)[number]) => isUnfinishedLine(cell, performed)
    expect(findNextUnfinishedIndex(lines, 0, 1, rule)).toBe(2)
  })

  it("keeps the text rule in a Text language", () => {
    const text = [
      { translated: "a", activeValidators: ["x"] },
      { translated: "", activeValidators: [] },
    ]
    expect(findNextUnfinishedIndex(text, 0, 1)).toBe(1)
  })
})

describe("the other files' bars come from the Plan's own read", () => {
  const unit = (over: Partial<PlanUnit>): PlanUnit => ({
    fileId: "ruth", fileName: "Ruth", sectionKey: "", totalCount: 22, filledCount: 0, validatedCount: 0,
    audioCount: 0, audioValidatedCount: 0, lastEditAt: null, targetDate: null, doneAt: null, doneBy: null,
    ...over,
  })

  it("Audio: a book's units add up to recorded and approved lines (P2.1)", () => {
    const map = planUnitsToFileProgress([
      unit({ sectionKey: "RUT 1", totalCount: 22, audioCount: 10, audioValidatedCount: 6 }),
      unit({ sectionKey: "RUT 2", totalCount: 23 }),
    ], "audio")
    expect(map.get("ruth")).toEqual({ total: 45, translated: 10, validated: 6, recorded: 10, audioValidated: 6, delivers: "audio" })
  })

  it("Audio: a dubbing episode is measured against its cue sheet (P2.7)", () => {
    const map = planUnitsToFileProgress(
      [unit({ fileId: "ep", totalCount: 300, audioTotalCount: 40, audioCount: 20, audioValidatedCount: 8 })],
      "audio",
    )
    expect(map.get("ep")).toEqual({ total: 40, translated: 20, validated: 8, recorded: 20, audioValidated: 8, delivers: "audio" })
  })

  it("Text and audio: lines done on both halves, from the joint count (P2.6)", () => {
    const map = planUnitsToFileProgress(
      [unit({ totalCount: 10, filledCount: 9, validatedCount: 7, audioCount: 6, audioValidatedCount: 6, bothValidatedCount: 4 })],
      "text_and_audio",
    )
    expect(map.get("ruth")).toEqual({
      total: 10, translated: 9, validated: 4, delivers: "text_and_audio",
      // …and the two halves on their own, for the file row's two bars.
      textTranslated: 9, textValidated: 7, recorded: 6, audioValidated: 6,
    })
  })
})

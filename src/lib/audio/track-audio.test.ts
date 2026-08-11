// Round 5 (AQU-646): the single definition of "the section's source clip"
// vs "the section's dub" — everything the two timeline tracks and the
// master/overlay playback elements rely on.

import { describe, expect, it } from "vitest"
import { activeTargetForCell, sourceClipAudioForCell } from "./track-audio"
import type { CellData } from "@/hooks/useCells"

const SOURCE_ID = "audio-file-9-1700000000-src1.mp3"
const TAKE_ID = "audio-sec-1-1700000001-tk1.webm"
const GEN_ID = "audio-sec-1-1700000002-gv1.wav"

const cell = (over: Partial<CellData>): CellData =>
  ({
    id: "sec-1", fileId: "file-9", original: "", translated: "", context: "", group: "",
    type: "text", status: "empty", validationStatus: "unvalidated",
    activeValidators: [], validationHistory: [], history: [], threads: [],
    medium: "media",
    ...over,
  }) as CellData

const att = (url: string, isDeleted = false) => ({ url, type: "audio", isDeleted })

describe("sourceClipAudioForCell", () => {
  it("returns the selected clip when the selection is the fileId-seeded source", () => {
    const c = cell({
      selectedAudioId: SOURCE_ID,
      attachments: { [SOURCE_ID]: att("frontier-audio://src") },
    })
    expect(sourceClipAudioForCell(c)).toEqual({ audioId: SOURCE_ID, url: "frontier-audio://src" })
  })

  it("finds the displaced source clip when a TAKE is selected", () => {
    const c = cell({
      selectedAudioId: TAKE_ID,
      attachments: {
        [TAKE_ID]: att("frontier-audio://take"),
        [SOURCE_ID]: att("frontier-audio://src"),
      },
    })
    expect(sourceClipAudioForCell(c)).toEqual({ audioId: SOURCE_ID, url: "frontier-audio://src" })
  })

  it("returns null for a take-only section (source clip gone)", () => {
    const c = cell({
      selectedAudioId: TAKE_ID,
      attachments: { [TAKE_ID]: att("frontier-audio://take") },
    })
    expect(sourceClipAudioForCell(c)).toBeNull()
  })

  it("legacy/ambiguous selected ids (neither seed) default to SOURCE", () => {
    const c = cell({
      selectedAudioId: "a1",
      attachments: { a1: att("frontier-audio://legacy") },
    })
    expect(sourceClipAudioForCell(c)).toEqual({ audioId: "a1", url: "frontier-audio://legacy" })
  })

  it("skips deleted attachments", () => {
    const c = cell({
      selectedAudioId: TAKE_ID,
      attachments: {
        [TAKE_ID]: att("frontier-audio://take"),
        [SOURCE_ID]: att("frontier-audio://src", true),
      },
    })
    expect(sourceClipAudioForCell(c)).toBeNull()
  })

  it("returns null for non-media cells", () => {
    const c = cell({
      medium: "text",
      selectedAudioId: SOURCE_ID,
      attachments: { [SOURCE_ID]: att("frontier-audio://src") },
    })
    expect(sourceClipAudioForCell(c)).toBeNull()
  })
})

describe("activeTargetForCell", () => {
  it("a selected take wins, tagged as a take", () => {
    const c = cell({
      selectedAudioId: TAKE_ID,
      selectedGeneratedVoiceAudioId: GEN_ID,
      attachments: {
        [TAKE_ID]: att("frontier-audio://take"),
        [GEN_ID]: att("frontier-audio://gen"),
      },
    })
    expect(activeTargetForCell(c)).toEqual({ audioId: TAKE_ID, url: "frontier-audio://take", kind: "take" })
  })

  it("falls to the generated voice when the recording selection is the source clip", () => {
    const c = cell({
      selectedAudioId: SOURCE_ID,
      selectedGeneratedVoiceAudioId: GEN_ID,
      attachments: {
        [SOURCE_ID]: att("frontier-audio://src"),
        [GEN_ID]: att("frontier-audio://gen"),
      },
    })
    expect(activeTargetForCell(c)).toEqual({ audioId: GEN_ID, url: "frontier-audio://gen", kind: "generated" })
  })

  it("null when the section has only its source clip", () => {
    const c = cell({
      selectedAudioId: SOURCE_ID,
      attachments: { [SOURCE_ID]: att("frontier-audio://src") },
    })
    expect(activeTargetForCell(c)).toBeNull()
  })

  it("null when the generated voice is deleted", () => {
    const c = cell({
      selectedGeneratedVoiceAudioId: GEN_ID,
      attachments: { [GEN_ID]: att("frontier-audio://gen", true) },
    })
    expect(activeTargetForCell(c)).toBeNull()
  })

  it("null for non-media cells (subtitle takes are the Dialogue-lane story, not this track)", () => {
    const c = cell({
      medium: "text",
      selectedAudioId: TAKE_ID,
      attachments: { [TAKE_ID]: att("frontier-audio://take") },
    })
    expect(activeTargetForCell(c)).toBeNull()
  })
})

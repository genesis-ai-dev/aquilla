// Round 5 (AQU-646): the single definition of "the section's source clip"
// vs "the section's dub" — everything the two timeline tracks and the
// master/overlay playback elements rely on.

import { describe, expect, it } from "vitest"
import { activeTargetForCell, resolveTargetAudio, sourceClipAudioForCell } from "./track-audio"
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

// ── AQU-646 stage 3: resolving a take on an ADDED target track ──────────────
//
// An added track stores every take — recorded and generated alike — in one slot
// of its own, so what a take IS comes off the attachment rather than off which
// slot it sits in. These cases pin both halves of that, plus the thing that
// must NOT change: the default track's resolution is byte-for-byte what it was.

describe("resolveTargetAudio — an added track's own slot", () => {
  const TRK = "019fd21a-a5a4-75d1-b8c4-3b60072a4fc2"
  const TRK_TAKE = "audio-sec-1-1700000003-t2.webm"

  it("reads the selection out of the slot map", () => {
    const c = cell({
      selectedBySlot: { [TRK]: TRK_TAKE },
      attachments: { [TRK_TAKE]: att("frontier-audio://t2") },
    })
    expect(resolveTargetAudio(c, TRK)).toEqual({
      audioId: TRK_TAKE,
      url: "frontier-audio://t2",
      kind: "take",
    })
  })

  // ONE SLOT HOLDS BOTH KINDS, so the tone comes from the take. `voiceId` is
  // set unconditionally by all three paths that mint a generated voice, which
  // is what makes this sound rather than a guess.
  it("calls a take with a voiceId generated, in the same slot", () => {
    const c = cell({
      selectedBySlot: { [TRK]: TRK_TAKE },
      attachments: { [TRK_TAKE]: { ...att("frontier-audio://t2"), voiceId: "v-1" } },
    })
    expect(resolveTargetAudio(c, TRK)?.kind).toBe("generated")
  })

  it("finds nothing when that track has no selected take on this line", () => {
    const c = cell({
      selectedAudioId: TAKE_ID,
      attachments: { [TAKE_ID]: att("frontier-audio://tk") },
    })
    expect(resolveTargetAudio(c, TRK)).toBeNull()
  })

  it("ignores a deleted take rather than pointing at it", () => {
    const c = cell({
      selectedBySlot: { [TRK]: TRK_TAKE },
      attachments: { [TRK_TAKE]: att("frontier-audio://t2", true) },
    })
    expect(resolveTargetAudio(c, TRK)).toBeNull()
  })

  // THE SEEDING GUARD IS DELIBERATELY ABSENT on a track slot. It exists only to
  // keep the shared imported SOURCE clip — which lives in the recording slot,
  // seeded with the fileId — from passing as a dub. Import writes the two
  // legacy slots and nothing else, so a track slot can never hold it.
  it("does not require a cell-seeded id, unlike the default track", () => {
    const fileSeeded = "audio-file-9-1700000000-src1.mp3"
    const c = cell({
      selectedBySlot: { [TRK]: fileSeeded },
      attachments: { [fileSeeded]: att("frontier-audio://src") },
    })
    expect(resolveTargetAudio(c, TRK)?.audioId).toBe(fileSeeded)
  })

  // The other half of that: the DEFAULT track still refuses it, which is the
  // behaviour every existing project depends on.
  it("still keeps the source clip out of the default track's chips", () => {
    const fileSeeded = "audio-file-9-1700000000-src1.mp3"
    const c = cell({
      selectedAudioId: fileSeeded,
      attachments: { [fileSeeded]: att("frontier-audio://src") },
    })
    expect(resolveTargetAudio(c)).toBeNull()
  })

  it("resolves the default track exactly as before, slot named or not", () => {
    const c = cell({
      selectedAudioId: TAKE_ID,
      selectedGeneratedVoiceAudioId: GEN_ID,
      attachments: { [TAKE_ID]: att("frontier-audio://tk"), [GEN_ID]: att("frontier-audio://gv") },
    })
    const expected = { audioId: TAKE_ID, url: "frontier-audio://tk", kind: "take" }
    expect(resolveTargetAudio(c)).toEqual(expected)
    expect(resolveTargetAudio(c, "recording")).toEqual(expected)
  })
})

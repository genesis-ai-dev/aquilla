// AQU-2148: A DEAD SELECTION POINTER MUST NOT SILENCE A LINE.
//
// A cell's slot pointer outlives its take — removing a take leaves
// `selectedAudioId` behind until something re-selects — so a line whose old
// recording was deleted and whose new voice arrived in the `generatedVoice`
// slot used to resolve to the dead id, find no attachment, and drop out of the
// deliverable entirely. On The Journey — Arabic that was one cell silent on
// every character track of the zip while the line's own audio control played
// its new take, with nothing in the preview to say so (Joel, 2026-10-23).
//
// The rule these tests pin, across all four audio deliverables and the
// preview: the default track ships the selected recording take WHEN IT IS
// STILL THERE, else the selected generated voice. It is a fall-through, never
// a re-ordering — a live recording still wins, exactly as it always did.
import { describe, it, expect } from "vitest"
import type { CellData } from "@/hooks/useCells"
import type { CodexCellAttachment } from "@/lib/codex-editor/types"
import type { ProjectTtsSettings } from "@/lib/parsers/types"
import { defaultTrackTakeId, scopeAudioCellsForExport } from "./audio-validation-scope"
import { groupAudioByCharacter, previewAudioByCharacter } from "./audio-by-character"
import { groupAudioByChapter } from "./audio-chapter"
import { collectPerLineClips } from "./audio-per-line"
import { assembleAudioEntries } from "./audio-assembly"

const SETTINGS: ProjectTtsSettings = {
  voices: [{ id: "v-chip", name: "Chip" }],
  defaultVoiceId: "v-chip",
  castAssignments: { c1: "v-chip" },
}

function cell(over: Partial<CellData>): CellData {
  return {
    id: "c1", fileId: "f1", original: "", translated: "", context: "", group: "",
    type: "cue", status: "unvalidated", validationStatus: "none",
    activeValidators: [], validationHistory: [], history: [], threads: [], ...over,
  }
}

const take = (over: Partial<CodexCellAttachment> = {}): CodexCellAttachment => ({
  url: "frontier-audio://x.wav", type: "audio/wav", slot: "recording",
  durationMs: 1000, validatorCount: 1, ...over,
})

/**
 * The LOTE shape: an old recording-slot take the user removed, and the new
 * API-attached voice in the `generatedVoice` slot. `removal` says how the
 * removal shows up on the merged read — the key gone, or still present and
 * flagged. Both happen, and both used to silence the line.
 */
const recast = (removal: "absent" | "flagged"): CellData =>
  cell({
    startTime: 1,
    endTime: 2,
    selectedAudioId: "a-old",
    selectedGeneratedVoiceAudioId: "g-new",
    attachments: {
      ...(removal === "flagged"
        ? { "a-old": take({ url: "frontier-audio://a-old.wav", isDeleted: true }) }
        : {}),
      "g-new": take({ url: "frontier-audio://g-new.wav", slot: "generatedVoice" }),
    },
  })

/** Both takes live — the pin that this is a fall-through, not a re-ordering. */
const bothLive = (): CellData =>
  cell({
    startTime: 1,
    endTime: 2,
    selectedAudioId: "a-old",
    selectedGeneratedVoiceAudioId: "g-new",
    attachments: {
      "a-old": take({ url: "frontier-audio://a-old.wav" }),
      "g-new": take({ url: "frontier-audio://g-new.wav", slot: "generatedVoice" }),
    },
  })

describe("defaultTrackTakeId", () => {
  it.each(["absent", "flagged"] as const)(
    "falls through to the generated voice when the recording slot's take is %s",
    (removal) => {
      expect(defaultTrackTakeId(recast(removal))).toBe("g-new")
    },
  )

  it("still prefers the recording slot while its take is live", () => {
    expect(defaultTrackTakeId(bothLive())).toBe("a-old")
  })

  it("has no answer when neither slot has a take left", () => {
    expect(defaultTrackTakeId(cell({ selectedAudioId: "a-gone" }))).toBeNull()
    expect(defaultTrackTakeId(cell({}))).toBeNull()
  })

  it("ignores a selection whose attachment carries no url", () => {
    const c = cell({
      selectedAudioId: "a-old",
      selectedGeneratedVoiceAudioId: "g-new",
      attachments: {
        "a-old": take({ url: "" }),
        "g-new": take({ url: "frontier-audio://g-new.wav", slot: "generatedVoice" }),
      },
    })
    expect(defaultTrackTakeId(c)).toBe("g-new")
  })

  it("keeps the slot when the pointer names a removed PIECE whose siblings still sound", () => {
    // AQU-1767: a cut take is several selected pieces over one recording.
    // Deleting the piece the pointer happens to name does not empty the slot,
    // and falling through to a generated voice there would drop the rest of
    // the performance.
    const c = cell({
      selectedAudioId: "a-p1",
      selectedGeneratedVoiceAudioId: "g-new",
      attachments: {
        "a-p1": take({ url: "frontier-audio://a-p1.wav", isDeleted: true, trimStartMs: 0, pieceOf: "a-cut" }),
        "a-p2": take({ url: "frontier-audio://a-p2.wav", trimStartMs: 500, pieceOf: "a-cut" }),
        "g-new": take({ url: "frontier-audio://g-new.wav", slot: "generatedVoice" }),
      },
    })
    expect(defaultTrackTakeId(c)).toBe("a-p1")
  })
})

describe("every audio deliverable ships the take that is still there", () => {
  it.each(["absent", "flagged"] as const)(
    "by character: the line lands on its cast member's track (%s removal)",
    (removal) => {
      const groups = groupAudioByCharacter([recast(removal)], SETTINGS)
      expect(groups).toHaveLength(1)
      expect(groups[0].key).toBe("v-chip")
      expect(groups[0].clips.map((c) => c.audioId)).toEqual(["g-new"])
    },
  )

  it("by character: the preview counts it as recorded, not as still to record", () => {
    const rows = previewAudioByCharacter([recast("absent")], SETTINGS)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ name: "Chip", clipCount: 1, missingCount: 0 })
  })

  it("by chapter: the stitch writes the take instead of a gap", () => {
    const groups = groupAudioByChapter([recast("absent")])
    expect(groups.flatMap((g) => g.clips).map((c) => c.audioId)).toEqual(["g-new"])
  })

  it("by line: the line gets a file, flagged as the generated take it is", () => {
    const clips = collectPerLineClips([recast("absent")], SETTINGS)
    expect(clips).toHaveLength(1)
    expect(clips[0]).toMatchObject({ cellId: "c1", audioId: "g-new", generated: true })
  })

  it("assembly: the manifest no longer reports the line as having no audio", async () => {
    const result = await assembleAudioEntries({
      cells: [recast("absent")],
      settings: SETTINGS,
      projectId: "p1",
      fileSlug: "journey",
      langCode: "arb",
      mode: "separate-clips",
      fetchBytes: async () => new Uint8Array([1]),
      decode: async () => new Float32Array([0]),
    })
    expect(result.skipped).toEqual([])
    expect(result.entries).toHaveLength(1)
  })

  it("by character: a live recording take is unchanged by all of this", () => {
    const groups = groupAudioByCharacter([bothLive()], SETTINGS)
    expect(groups[0].clips.map((c) => c.audioId)).toEqual(["a-old"])
  })
})

describe("validated-only still withdraws, and never falls through to escape it", () => {
  it("a withdrawn recording take leaves silence in place rather than shipping the voice", () => {
    // AQU-965's promise is the one thing a fall-through could quietly undo:
    // the recording take is the one the line's validation is measured over, so
    // reaching past it to an unsigned-off generated voice would ship exactly
    // the audio the mode exists to hold back.
    const unsigned = cell({
      startTime: 1,
      endTime: 2,
      selectedAudioId: "a-old",
      selectedGeneratedVoiceAudioId: "g-new",
      attachments: {
        "a-old": take({ url: "frontier-audio://a-old.wav", validatorCount: 0 }),
        "g-new": take({ url: "frontier-audio://g-new.wav", slot: "generatedVoice", validatorCount: 0 }),
      },
    })
    const scoped = scopeAudioCellsForExport([unsigned], "validated-only", 1)
    expect(groupAudioByCharacter(scoped, SETTINGS).flatMap((g) => g.clips)).toEqual([])
  })
})

/**
 * AQU-782: the TEXT-section row hydration (applyRowOverlays) must forward the
 * imported clip's trim window onto the cell attachment. transcribeCell reads
 * `attachment.trimStartMs/trimEndMs` to window Whisper to just this section;
 * when the overlay dropped them, every section transcribed the WHOLE clip.
 *
 * This guards the exact boundary the regression escaped at: the audio read
 * (CellAudioEntry carries the trim) → row overlay → CellData attachment (the
 * shape transcribeCell consumes). mergeCellsWithAudio already forwarded it for
 * the media pane; the text section's separate overlay path did not.
 */

import { describe, it, expect } from "vitest"
import { applyRowOverlays } from "./EditorTable"
import type { CellData } from "@/hooks/useCells"
import type { CellAudioEntry } from "@/lib/sync/cell-audio-read-types"

const SHARED_CLIP = "audio-file-1-1700000000-abcdefgh.mp3"

function mediaCell(): CellData {
  return {
    id: "cell-1", fileId: "file-1", original: "episode.mp3", translated: "",
    context: "", group: "", type: "text", status: "unvalidated",
    validationStatus: "none", activeValidators: [], validationHistory: [],
    history: [], threads: [], medium: "media",
  } as unknown as CellData
}

// A source segment: shared clip (seeded with the FILE id) attached with a tight
// trim window — exactly what emitMediaFile / diarization / attach-media produce.
function audioEntry(): CellAudioEntry {
  return {
    attachments: {
      [SHARED_CLIP]: {
        audioId: SHARED_CLIP,
        url: `frontier-audio://${SHARED_CLIP}`,
        slot: "recording",
        mimeType: "audio/mpeg",
        voiceId: null,
        referenceAudioId: null,
        durationMs: 90_000,
        trimStartMs: 12_000,
        trimEndMs: 18_000,
      },
    },
    selectedAudioId: SHARED_CLIP,
    selectedGeneratedVoiceAudioId: null,
    audioTimings: {},
  }
}

describe("applyRowOverlays — trim window (AQU-782)", () => {
  it("forwards the section's trim window onto the cell attachment", () => {
    const cell = applyRowOverlays(mediaCell(), { audioEntry: audioEntry() })
    const att = cell.attachments?.[SHARED_CLIP]
    expect(att?.trimStartMs).toBe(12_000)
    expect(att?.trimEndMs).toBe(18_000)
    // Sanity: the other fields still come through.
    expect(att?.durationMs).toBe(90_000)
    expect(cell.selectedAudioId).toBe(SHARED_CLIP)
  })

  it("omits trim keys when the clip has none (recorded take → whole clip)", () => {
    const entry = audioEntry()
    entry.attachments[SHARED_CLIP].trimStartMs = null
    entry.attachments[SHARED_CLIP].trimEndMs = null
    const cell = applyRowOverlays(mediaCell(), { audioEntry: entry })
    const att = cell.attachments?.[SHARED_CLIP]
    expect(att && "trimStartMs" in att).toBe(false)
    expect(att && "trimEndMs" in att).toBe(false)
  })
})

/**
 * AQU-490 fell into the SAME gap this file was created for, which is why the
 * tests live here rather than in a new one.
 *
 * `mergeCellsWithAudio` and `applyRowOverlays` both rebuild a cell's
 * attachments field by field, and the editor's rows go through the second.
 * Guarding only the first left the audio validation control drawing an empty
 * gutter on every line of a fully recorded file — `role` never arrived, so
 * every take read as an imported source clip and none of them counted. No
 * type error anywhere: every field is optional on both sides.
 *
 * Caught in the browser, against the live stack, after the unit tests passed.
 */
describe("applyRowOverlays — the audio validation fields (AQU-490)", () => {
  const entry = (attachment: Record<string, unknown>, slot = "take"): CellAudioEntry => ({
    attachments: { "take-1": { audioId: "take-1", url: "frontier-audio://take-1", slot, mimeType: null, voiceId: null, referenceAudioId: null, durationMs: null, label: null, trimStartMs: null, trimEndMs: null, ...attachment } },
    selectedBySlot: { [slot]: "take-1" },
    selectedAudioId: null,
    selectedGeneratedVoiceAudioId: null,
    audioTimings: {},
  } as unknown as CellAudioEntry)

  it("forwards the vote count, the validators, the role, the recorder and the label", () => {
    const out = applyRowOverlays(mediaCell(), {
      audioEntry: entry({ validatorCount: 2, validators: ["ana", "bo"], role: "dub", recordedBy: "cy", label: "Take 3" }),
    })
    expect(out.attachments?.["take-1"]).toMatchObject({
      validatorCount: 2, validators: ["ana", "bo"], role: "dub", recordedBy: "cy", label: "Take 3",
    })
  })

  // Without `role` every take reads as a dub by default, which sounds safe and
  // is not: the imported programme audio would then be offered for validation
  // on every line of a media file.
  it("forwards role=source, so the shared programme audio still does not count", () => {
    const out = applyRowOverlays(mediaCell(), { audioEntry: entry({ role: "source" }) })
    expect(out.attachments?.["take-1"]?.role).toBe("source")
  })

  // AQU-646's blind spot, in this second copy. The slot and the per-slot
  // selection were both dropped here, so a take on an added target-audio track
  // was unreachable from the text view even after the rest was fixed.
  it("forwards the slot and the per-slot selection", () => {
    const out = applyRowOverlays(mediaCell(), { audioEntry: entry({}, "track-2") })
    expect(out.attachments?.["take-1"]?.slot).toBe("track-2")
    expect(out.selectedBySlot).toEqual({ "track-2": "take-1" })
  })

  // A count of zero is a real answer — "recorded, nobody has listened" — and
  // is exactly what a truthiness check would swallow.
  it("keeps a vote count of zero", () => {
    const out = applyRowOverlays(mediaCell(), { audioEntry: entry({ validatorCount: 0 }) })
    expect(out.attachments?.["take-1"]?.validatorCount).toBe(0)
  })
})

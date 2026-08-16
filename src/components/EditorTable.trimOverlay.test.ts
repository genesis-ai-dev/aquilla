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

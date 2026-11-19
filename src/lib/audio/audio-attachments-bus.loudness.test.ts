// AQU-2664 (re-check S4): a take's reading, measured just after it was made,
// shows on the page at once — also while its own attach is still in flight
// (the optimistic overlay used to stamp only the trim onto a live attach).
import { beforeEach, describe, expect, it } from "vitest"
import { clearOptimisticShadows, getOptimisticShadows, injectOptimisticAudioAttachment, injectOptimisticAudioTrim } from "./audio-attachments-bus"
import type { AudioAttachmentOut } from "@/lib/sync/cell-audio-read-types"

const FILE = "f-loud"
const CELL = "c1"
const take = (over: Partial<AudioAttachmentOut> = {}): AudioAttachmentOut => ({
  audioId: "dn-1.webm", url: "frontier-audio://dn-1.webm", slot: "recording", mimeType: "audio/webm",
  voiceId: null, referenceAudioId: "t.webm", durationMs: 3000, trimStartMs: null, trimEndMs: null, ...over,
})

describe("a reading on a take still being attached", () => {
  beforeEach(() => clearOptimisticShadows(FILE))

  it("is stamped on the live attach, with its window, keeping the attach's own values", () => {
    injectOptimisticAudioAttachment(FILE, CELL, take({ evenTargetLufs: -16, label: "Take 2" }), "evt-attach")
    injectOptimisticAudioTrim(FILE, CELL, take({ loudnessLufs: -24, truePeakDb: -9, loudnessFromMs: 0, loudnessToMs: null }), "evt-measure")
    const live = (getOptimisticShadows(FILE).get(CELL) ?? []).find((s) => s.kind === "attach")
    expect(live).toMatchObject({ att: { loudnessLufs: -24, truePeakDb: -9, loudnessFromMs: 0, evenTargetLufs: -16, label: "Take 2" } })
  })

  it("a trim's overlay without a reading leaves the attach's reading alone", () => {
    injectOptimisticAudioAttachment(FILE, CELL, take({ loudnessLufs: -24, truePeakDb: -9 }), "evt-attach")
    injectOptimisticAudioTrim(FILE, CELL, take({ trimEndMs: 2000 }), "evt-trim")
    const live = (getOptimisticShadows(FILE).get(CELL) ?? []).find((s) => s.kind === "attach")
    expect(live).toMatchObject({ att: { loudnessLufs: -24, trimEndMs: 2000 } })
  })
})

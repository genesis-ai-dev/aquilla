import { beforeEach, describe, expect, it, vi } from "vitest"

const emitCellAudioTrim = vi.fn(async () => "evt-1")
const injectOptimisticAudioTrim = vi.fn()
const notifyAudioAttachmentsChanged = vi.fn()
vi.mock("@/lib/sync/events-emit", () => ({ emitCellAudioTrim: (...a: unknown[]) => emitCellAudioTrim(...(a as [])) }))
vi.mock("@/lib/audio/audio-attachments-bus", () => ({
  injectOptimisticAudioTrim: (...a: unknown[]) => injectOptimisticAudioTrim(...(a as [])),
  notifyAudioAttachmentsChanged: (...a: unknown[]) => notifyAudioAttachmentsChanged(...(a as [])),
}))

import { persistTakeTrim, trimMs } from "./persist-trim"

beforeEach(() => { vi.clearAllMocks() })

const base = {
  projectId: "p1", fileId: "cues", cellId: "cue-4", audioId: "rec-cue-4-a.wav",
  att: { url: "frontier-audio://rec-cue-4-a.wav", durationMs: 3000, validatorCount: 1, validators: ["sam"] },
  selectedAudioId: "rec-cue-4-a.wav",
  trimStartMs: 300, trimEndMs: null, author: "sam",
}

describe("persistTakeTrim", () => {
  it("emits the trim against the cell that holds the take, both ends stated", async () => {
    await persistTakeTrim(base)
    expect(emitCellAudioTrim).toHaveBeenCalledWith({
      projectId: "p1", fileId: "cues", cellId: "cue-4", audioId: "rec-cue-4-a.wav",
      trimStartMs: 300, trimEndMs: null, author: "sam",
    })
  })

  it("paints the window at once without dropping the take's votes", () => {
    void persistTakeTrim(base)
    const [fileId, cellId, att] = injectOptimisticAudioTrim.mock.calls[0] as unknown as [string, string, Record<string, unknown>]
    expect([fileId, cellId]).toEqual(["cues", "cue-4"])
    expect(att).toMatchObject({ slot: "recording", trimStartMs: 300, trimEndMs: null, validatorCount: 1, validators: ["sam"] })
    expect(notifyAudioAttachmentsChanged).toHaveBeenCalledWith("cues")
  })

  it("keeps a clip's own slot", () => {
    void persistTakeTrim({ ...base, att: { ...base.att, slot: "track-2" } })
    expect((injectOptimisticAudioTrim.mock.calls[0] as unknown as [string, string, { slot: string }])[2].slot).toBe("track-2")
  })
})

describe("trimMs", () => {
  it("rounds to whole milliseconds and keeps null as the clip's edge", () => {
    expect(trimMs(0.3004)).toBe(300)
    expect(trimMs(null)).toBeNull()
  })
})

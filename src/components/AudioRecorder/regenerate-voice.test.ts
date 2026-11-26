// AQU-1767 / round 8c: a regenerated voice is named like any take and becomes
// the one that sounds. (These used to run through the recording modal's
// Generate button; generating now lives in the Voices sidebar, so they drive
// the shared helper directly.)

import { describe, it, expect, vi, beforeEach } from "vitest"
import type { CellData } from "@/hooks/useCells"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { CellAudioEntry } from "@/lib/sync/cell-audio-read-types"
import type { FrontierSession } from "@/lib/frontier/types"

const generateCellVoice = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => true))
vi.mock("@/lib/audio/voice-generate-helpers", () => ({
  generateCellVoice: (...args: unknown[]) => generateCellVoice(...args),
}))
const injectOptimistic = vi.hoisted(() => vi.fn((..._args: unknown[]) => {}))
const injectDeselect = vi.hoisted(() => vi.fn((..._args: unknown[]) => {}))
vi.mock("@/lib/audio/audio-attachments-bus", () => ({
  notifyAudioAttachmentsChanged: vi.fn(),
  injectOptimisticAudioAttachment: (...args: unknown[]) => injectOptimistic(...args),
  injectOptimisticAudioDeselect: (...args: unknown[]) => injectDeselect(...args),
}))
const emitSelect = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => "evt-select"))
const emitDeselect = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => "evt-deselect"))
vi.mock("@/lib/sync/events-emit", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitCellAudioSelect: (...args: unknown[]) => emitSelect(...args),
  emitCellAudioDeselect: (...args: unknown[]) => emitDeselect(...args),
}))

import { regenerateVoiceTake } from "./regenerate-voice"

const project = { id: "p1", name: "P", ttsSettings: {} } as unknown as ProjectRecord
const cell = {
  id: "c1", fileId: "f1", original: "hello", translated: "bonjour",
  medium: "media", startTime: 0, endTime: 5,
} as unknown as CellData
const session = { jwt: "tok", username: "sam" } as unknown as FrontierSession

const att = (audioId: string, over: Record<string, unknown> = {}) => ({
  audioId, url: `frontier-audio://${audioId}`, slot: "recording", mimeType: "audio/mpeg",
  voiceId: null, referenceAudioId: null, durationMs: 4000,
  trimStartMs: null, trimEndMs: null, label: "Take 1", ...over,
})

const entryWith = (attachments: Record<string, unknown>, selectedAudioId: string | null) =>
  ({ attachments, selectedAudioId, selectedGeneratedVoiceAudioId: null, audioTimings: {} }) as unknown as CellAudioEntry

const regenerate = (entry: CellAudioEntry) =>
  regenerateVoiceTake({
    project, cell, entry, session, username: "sam",
    surface: "recorder",
    targetSlot: "recording",
  })

describe("regenerateVoiceTake — the new voice becomes the sounding take", () => {
  beforeEach(() => {
    generateCellVoice.mockClear()
    emitSelect.mockClear()
    emitDeselect.mockClear()
    injectOptimistic.mockClear()
    injectDeselect.mockClear()
  })

  it("names the TTS take at birth and hands the recording slot to the source clip", async () => {
    const entry = entryWith({
      "audio-f1-100-clip.mp3": att("audio-f1-100-clip.mp3", { label: null }),
      "audio-c1-200-take.webm": att("audio-c1-200-take.webm"),
    }, "audio-c1-200-take.webm") // a recorded take holds the slot
    await expect(regenerate(entry)).resolves.toBe(true)
    expect(generateCellVoice).toHaveBeenCalledTimes(1)
    const [args] = generateCellVoice.mock.calls[0] as unknown as [{ label?: string }]
    expect(args.label).toBe("Take 2")
    expect(emitSelect).toHaveBeenCalledTimes(1)
    expect(emitSelect).toHaveBeenCalledWith(expect.objectContaining({
      audioId: "audio-f1-100-clip.mp3", slot: "recording",
    }))
  })

  // Sam, 2026-09-28 (Mark 1:3): a line with no imported source clip had
  // nothing to hand the slot to, so the new voice was saved and never played.
  it("with no source clip, empties the recording slot so the new voice sounds", async () => {
    const entry = entryWith({ "audio-c1-200-take.webm": att("audio-c1-200-take.webm") }, "audio-c1-200-take.webm")
    await regenerate(entry)
    expect(emitDeselect).toHaveBeenCalledTimes(1)
    expect(emitDeselect).toHaveBeenCalledWith(expect.objectContaining({ cellId: "c1", slot: "recording" }))
    expect(injectDeselect).toHaveBeenCalledWith("f1", "c1", "recording", expect.anything())
    expect(emitSelect).not.toHaveBeenCalled()
  })

  it("no displacement when the source clip already holds the slot", async () => {
    const entry = entryWith({
      "audio-f1-100-clip.mp3": att("audio-f1-100-clip.mp3", { label: null }),
    }, "audio-f1-100-clip.mp3")
    await regenerate(entry)
    expect(generateCellVoice).toHaveBeenCalledTimes(1)
    expect(emitSelect).not.toHaveBeenCalled()
    expect(emitDeselect).not.toHaveBeenCalled()
  })

  it("resolves false and displaces nothing when generation fails", async () => {
    generateCellVoice.mockResolvedValueOnce(false)
    const entry = entryWith({ "audio-c1-200-take.webm": att("audio-c1-200-take.webm") }, "audio-c1-200-take.webm")
    await expect(regenerate(entry)).resolves.toBe(false)
    expect(emitDeselect).not.toHaveBeenCalled()
  })
})

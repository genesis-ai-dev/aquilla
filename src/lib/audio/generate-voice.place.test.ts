// AQU-2491 (review, Nov 9): a line recorded before AQU-2491 still holds the
// recorder's pre-roll as ITS place (-200 ms), and a take with no place of its
// own reads that one, so a voice generated onto that line started 0.2 s
// before its cue. A generated voice is given its own place, the line's start,
// on both ways a voice is made: synthesized on the server, and in the browser.
import { describe, expect, it, vi } from "vitest"
import { bornTakePlace } from "./new-take-place"
import { targetChipGeom } from "@/lib/timeline/lane-timing"
import type { CellData } from "@/hooks/useCells"

const oldLine = { id: "c", fileId: "f", startTime: 10, endTime: 14, metadata: { target_offset_ms: -200 } } as unknown as CellData

function mockCommon() {
  // Each test sets its own engine: nothing from the one before carries over.
  for (const m of ["./tts-providers", "./opus-encode", "./bytes-cache", "./lossless-sibling", "@/lib/import"]) vi.doUnmock(m)
  const emitAttach = vi.fn(async () => "evt-attach")
  const emitPlace = vi.fn(async () => "evt-place")
  const inject = vi.fn()
  vi.doMock("@/lib/sync/events-emit", () => ({ emitCellAudioAttach: emitAttach, emitCellAudioPlace: emitPlace }))
  vi.doMock("./audio-attachments-bus", () => ({ notifyAudioAttachmentsChanged: vi.fn(), injectOptimisticAudioAttachment: inject }))
  vi.doMock("./sync-token-fetcher", () => ({ audioSyncTokenFetcherForSession: () => async () => "tok" }))
  vi.doMock("./voice-clone", () => ({ convertToLibraryVoice: vi.fn() }))
  return { emitAttach, emitPlace, inject }
}

describe("AQU-2491: a generated voice sits on its line's start, whatever place the line holds", () => {
  it("synthesized on the server: its own place 0, and drawn on its cue", async () => {
    vi.resetModules()
    const { emitPlace, inject } = mockCommon()
    vi.doMock("@/lib/sync/tts", () => ({
      synthesizeCellTts: vi.fn(async () => ({
        audioId: "audio-tts-1", durationSeconds: 1.2, objectName: "audio-tts-1.wav", url: "frontier-audio://audio-tts-1.wav",
      })),
    }))
    vi.doMock("./tts", () => ({ synthesizeForCell: vi.fn(), setTtsStatus: vi.fn(), ttsStatusKey: (s: string) => s }))
    vi.doMock("./upload", () => ({ buildAudioId: () => "id", uploadCellAudio: vi.fn(), fetchCellAudio: vi.fn(async () => new ArrayBuffer(4)) }))
    vi.doMock("./voices", () => ({ resolveVoice: () => ({ id: "v", name: "N", provider: "inworld", voiceName: "Dennis" }) }))
    const { generateAndAttachCellVoice } = await import("./generate-voice")
    await generateAndAttachCellVoice({
      projectId: "p", fileId: "f", cellId: "c", text: "hello", targetLang: "fr",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      session: { jwt: "j", username: "u" } as any, username: "u",
      place: bornTakePlace(oldLine),
    })
    expect(emitPlace).toHaveBeenCalledTimes(1)
    expect(emitPlace).toHaveBeenCalledWith({
      projectId: "p", fileId: "f", cellId: "c", audioId: "audio-tts-1.wav",
      targetOffsetMs: 0, recordingsOffsetMs: null, targetLang: "fr", author: "u",
    })
    const painted = (inject.mock.calls[0] as unknown[])[2] as { targetOffsetMs?: number; durationMs: number }
    expect(painted.targetOffsetMs).toBe(0)
    expect(targetChipGeom(oldLine, painted)!.start).toBe(10)
  })

  it("synthesized in the browser: its own place 0 too", async () => {
    vi.resetModules()
    const { emitPlace, inject } = mockCommon()
    vi.doMock("@/lib/sync/tts", () => ({ synthesizeCellTts: vi.fn() }))
    vi.doMock("./tts", () => ({
      synthesizeForCell: vi.fn(async () => new Blob(["wav"], { type: "audio/wav" })), setTtsStatus: vi.fn(), ttsStatusKey: (s: string) => s,
    }))
    vi.doMock("./voices", () => ({ resolveVoice: () => ({ id: "v", name: "N", provider: "gemini" }) }))
    vi.doMock("./tts-providers", () => ({
      resolveTtsProvider: () => "gemini",
      effectiveTtsProvider: (p: string | undefined) => p ?? "gemini",
      isServerTtsProvider: () => false,
      normalizeVoiceForProvider: (voice: { id: string }) => voice,
    }))
    vi.doMock("./opus-encode", () => ({ canEncodeOpus: () => false, encodeMonoToWebmOpus: vi.fn() }))
    vi.doMock("./bytes-cache", () => ({ audioCachePutBlob: vi.fn(async () => {}) }))
    vi.doMock("./lossless-sibling", () => ({ uploadLosslessSiblingBestEffort: vi.fn() }))
    vi.doMock("./upload", () => ({
      buildAudioId: () => "base-id",
      uploadCellAudio: vi.fn(async (a: { audioId: string; ext: string }) => ({ audioId: a.audioId, ext: a.ext, url: `frontier-audio://${a.audioId}.${a.ext}`, sizeBytes: 1 })),
      fetchCellAudio: vi.fn(),
    }))
    vi.doMock("@/lib/import", async (importActual) => ({
      ...(await importActual<Record<string, unknown>>()),
      probeDurationMsSafe: vi.fn(async () => 999),
    }))
    const { generateAndAttachCellVoice } = await import("./generate-voice")
    await generateAndAttachCellVoice({
      projectId: "p", fileId: "f", cellId: "c", text: "hello",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      session: { jwt: "j", username: "u" } as any, username: "u",
      place: bornTakePlace(oldLine),
    })
    expect(emitPlace).toHaveBeenCalledWith(expect.objectContaining({ audioId: "base-id.wav", targetOffsetMs: 0, recordingsOffsetMs: null }))
    expect((inject.mock.calls[0] as unknown[])[2]).toMatchObject({ audioId: "base-id.wav", targetOffsetMs: 0 })
  })

  it("on a line with no times, nothing is placed, as before", async () => {
    vi.resetModules()
    const { emitPlace } = mockCommon()
    vi.doMock("@/lib/sync/tts", () => ({
      synthesizeCellTts: vi.fn(async () => ({
        audioId: "audio-tts-1", durationSeconds: 1.2, objectName: "audio-tts-1.wav", url: "frontier-audio://audio-tts-1.wav",
      })),
    }))
    vi.doMock("./tts", () => ({ synthesizeForCell: vi.fn(), setTtsStatus: vi.fn(), ttsStatusKey: (s: string) => s }))
    vi.doMock("./upload", () => ({ buildAudioId: () => "id", uploadCellAudio: vi.fn(), fetchCellAudio: vi.fn(async () => new ArrayBuffer(4)) }))
    vi.doMock("./voices", () => ({ resolveVoice: () => ({ id: "v", name: "N", provider: "inworld", voiceName: "Dennis" }) }))
    const { generateAndAttachCellVoice } = await import("./generate-voice")
    await generateAndAttachCellVoice({
      projectId: "p", fileId: "f", cellId: "c", text: "hello",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      session: { jwt: "j", username: "u" } as any, username: "u",
      place: bornTakePlace({ startTime: undefined } as CellData),
    })
    expect(emitPlace).not.toHaveBeenCalled()
  })
})

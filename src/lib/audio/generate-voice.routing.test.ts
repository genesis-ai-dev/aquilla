import { describe, expect, it, vi } from "vitest"

describe("generateAndAttachCellVoice routing", () => {
  it("omnivoice voice uses the server TTS path, not client synth", async () => {
    vi.resetModules()
    const synthCellTts = vi.fn(async () => ({
      audioId: "audio-tts-1", durationSeconds: 1.2,
      objectName: "audio-tts-1.wav", url: "frontier-audio://audio-tts-1.wav",
    }))
    const synthForCell = vi.fn(async () => new Blob(["x"], { type: "audio/wav" }))
    const emitAttach = vi.fn(async () => {})
    vi.doMock("@/lib/sync/tts", () => ({ synthesizeCellTts: synthCellTts }))
    vi.doMock("./tts", () => ({
      synthesizeForCell: synthForCell, setTtsStatus: vi.fn(),
      ttsStatusKey: (s: string) => s,
    }))
    vi.doMock("@/lib/sync/events-emit", () => ({ emitCellAudioAttach: emitAttach }))
    vi.doMock("./audio-attachments-bus", () => ({ notifyAudioAttachmentsChanged: vi.fn(), injectOptimisticAudioAttachment: vi.fn() }))
    vi.doMock("./sync-token-fetcher", () => ({ audioSyncTokenFetcherForSession: () => async () => "tok" }))
    vi.doMock("./upload", () => ({
      buildAudioId: () => "id", uploadCellAudio: vi.fn(),
      fetchCellAudio: vi.fn(async () => new ArrayBuffer(4)),
    }))
    vi.doMock("./voice-clone", () => ({ convertToCloneVoice: vi.fn() }))
    vi.doMock("./voices", () => ({
      resolveVoice: () => ({ id: "v", name: "N", provider: "omnivoice" }),
    }))
    const { generateAndAttachCellVoice } = await import("./generate-voice")
    await generateAndAttachCellVoice({
      projectId: "p", fileId: "f", cellId: "c", text: "hello",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      session: { jwt: "j", username: "u" } as any, username: "u",
      geminiContext: { targetLanguage: "es" },
    })
    expect(synthCellTts).toHaveBeenCalledTimes(1)
    expect(synthForCell).not.toHaveBeenCalled()
    expect(emitAttach).toHaveBeenCalledWith(
      expect.objectContaining({ audioId: "audio-tts-1.wav", slot: "generatedVoice", durationMs: 1200 }),
    )
  })
})

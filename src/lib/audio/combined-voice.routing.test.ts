import { describe, expect, it, vi } from "vitest"

describe("generateCombinedVoice routing", () => {
  it("omnivoice voice uses server TTS path and attaches to all cells", async () => {
    vi.resetModules()
    const synthCellTts = vi.fn(async () => ({
      audioId: "a", durationSeconds: 1,
      objectName: "a.wav", url: "frontier-audio://a.wav",
    }))
    const synthForCell = vi.fn(async () => new Blob(["x"], { type: "audio/wav" }))
    const emitAttach = vi.fn(async () => {})
    vi.doMock("@/lib/sync/tts", () => ({ synthesizeCellTts: synthCellTts }))
    vi.doMock("./tts", () => ({
      synthesizeForCell: synthForCell,
      setTtsStatus: vi.fn(),
      ttsStatusKey: (s: string) => s,
    }))
    vi.doMock("./voices", () => ({
      resolveCastVoice: () => ({ id: "v", name: "N", provider: "omnivoice" }),
    }))
    vi.doMock("./upload", () => ({
      buildAudioId: () => "id",
      uploadCellAudio: vi.fn(),
      fetchCellAudio: vi.fn(async () => new ArrayBuffer(4)),
    }))
    vi.doMock("./sync-token-fetcher", () => ({
      audioSyncTokenFetcherForSession: () => async () => "tok",
    }))
    vi.doMock("./voice-clone", () => ({ convertToCloneVoice: vi.fn() }))
    vi.doMock("@/lib/sync/events-emit", () => ({ emitCellAudioAttach: emitAttach }))
    vi.doMock("./audio-attachments-bus", () => ({ notifyAudioAttachmentsChanged: vi.fn() }))

    const { generateCombinedVoice } = await import("./combined-voice")

    const makeCell = (id: string) => ({
      id,
      fileId: "f",
      type: "text",
      translated: "hi",
      original: "",
      context: "",
      cellLabel: "",
      group: "",
      status: "unvalidated" as const,
      validationStatus: "none" as const,
      activeValidators: [],
      validationHistory: [],
      history: [],
      threads: [],
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const session = { jwt: "j", username: "u" } as any

    await generateCombinedVoice({
      project: { id: "p" } as any,
      fileId: "f",
      cells: [makeCell("c1"), makeCell("c2")],
      settings: {},
      session,
      username: "u",
    })

    expect(synthCellTts).toHaveBeenCalledTimes(1)
    expect(synthForCell).not.toHaveBeenCalled()
    expect(emitAttach).toHaveBeenCalledTimes(2)
  })
})

import { afterEach, describe, expect, it, vi } from "vitest"

const uploadVoiceReference = vi.fn(async () => {})
vi.mock("./voice-clone", () => ({
  buildVoiceReferenceId: (ext: string) => `ref-x.${ext}`,
  uploadVoiceReference: (...a: unknown[]) => uploadVoiceReference(...(a as [])),
}))
vi.mock("@/lib/sync/sync-worker-url", () => ({ syncWorkerHttpOrigin: () => "https://sync.test" }))

const { CUSTOM_VOICE_CONSENT_VERSION, isCustomVoice, startCustomVoiceTraining, voiceFromCustomTraining } =
  await import("./custom-voice")

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
  uploadVoiceReference.mockClear()
})

const getSyncToken = async () => "tok"
const file = (name: string) => new File([new Uint8Array([1])], name, { type: "audio/webm" })

describe("startCustomVoiceTraining", () => {
  it("refuses before uploading anything when consent isn't confirmed", async () => {
    await expect(startCustomVoiceTraining({
      projectId: "p1", fileId: "f1", speakerName: "Ana", recordings: [file("a.webm")], consentConfirmed: false, getSyncToken,
    })).rejects.toThrow(/consent/)
    expect(uploadVoiceReference).not.toHaveBeenCalled()
  })

  it("uploads each recording, then starts training with the consent statement version", async () => {
    const calls: { url: string; body: unknown }[] = []
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) })
      return Response.json({ voiceId: "c-0123456789abcdef", audioMinutes: 12, attestedAt: "2026-10-23T10:00:00Z", statementVersion: CUSTOM_VOICE_CONSENT_VERSION })
    }) as unknown as typeof fetch
    const progress: number[] = []
    const res = await startCustomVoiceTraining({
      projectId: "p1", fileId: "f1", speakerName: "Ana", recordings: [file("a.WAV"), file("b.m4a")],
      consentConfirmed: true, getSyncToken, onProgress: (done) => progress.push(done),
    })
    expect(uploadVoiceReference).toHaveBeenCalledTimes(2)
    expect(progress).toEqual([1, 2])
    expect(calls).toEqual([{
      url: "https://sync.test/api/v1/voice/custom/p1",
      body: {
        speakerName: "Ana",
        referenceAudioIds: ["ref-x.wav", "ref-x.m4a"],
        consent: { confirmed: true, statementVersion: CUSTOM_VOICE_CONSENT_VERSION },
      },
    }])
    expect(res.voiceId).toBe("c-0123456789abcdef")
  })
})

describe("voiceFromCustomTraining", () => {
  it("routes on libraryVoiceId and keeps a display copy of the consent confirmation", () => {
    const voice = voiceFromCustomTraining(
      { voiceId: "c-0123456789abcdef", audioMinutes: 12, attestedAt: "2026-10-23T10:00:00Z", statementVersion: CUSTOM_VOICE_CONSENT_VERSION },
      { id: "v1", name: "Ana", color: "#475569", attestedByUsername: "dev" },
    )
    expect(voice).toMatchObject({
      id: "v1", name: "Ana", libraryVoiceId: "c-0123456789abcdef",
      customVoice: { speakerName: "Ana", consentAttestedBy: "dev", consentStatementVersion: CUSTOM_VOICE_CONSENT_VERSION },
    })
    expect(isCustomVoice(voice)).toBe(true)
    expect(isCustomVoice({ libraryVoiceId: "narrator-hearth" })).toBe(false)
  })
})

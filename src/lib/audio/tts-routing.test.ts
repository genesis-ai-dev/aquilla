import { describe, expect, it, vi, beforeEach } from "vitest"

// Mock the heavy engine deps so we test ONLY routing, not synthesis.
const geminiMock = vi.fn(async () => new Blob(["g"], { type: "audio/wav" }))
vi.mock("./gemini-tts", () => ({
  synthesizeGeminiTtsToWavBlob: (...a: Parameters<typeof geminiMock>) => geminiMock(...a),
  GEMINI_TTS_VOICES: [{ name: "Kore", description: "" }],
}))

import { synthesizeForCell, synthesizeToWavBlob } from "./tts"
import type { ProjectTtsSettings } from "@/lib/parsers/types"

beforeEach(() => geminiMock.mockClear())

describe("provider precedence", () => {
  it("uses the voice's own provider over a conflicting project default", async () => {
    // Force a conflict: project says omnivoice (server-only), the voice says
    // gemini. Voice-first -> gemini synth is called. If this were project-first
    // it would hit the omnivoice guard and reject instead, so gemini=0 and the
    // assertion fails — i.e. this test actually catches a precedence regression.
    const settings: ProjectTtsSettings = {
      provider: "omnivoice",
      apiKey: "k",
      voices: [{ id: "v1", name: "N", provider: "gemini", voiceName: "Kore" }],
      defaultVoiceId: "v1",
    }
    await synthesizeForCell("hello", { projectTtsSettings: settings, cellVoiceId: "v1" })
    expect(geminiMock).toHaveBeenCalledTimes(1)
  })
})

describe("omnivoice guard", () => {
  it("synthesizeToWavBlob refuses omnivoice (server-only)", async () => {
    await expect(
      synthesizeToWavBlob("hi", {
        voice: { id: "v", name: "N", provider: "omnivoice" },
        projectProvider: "omnivoice",
      }),
    ).rejects.toThrow(/server-side/i)
  })
})

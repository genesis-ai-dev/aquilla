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
  it("uses the voice's own provider over the project default", async () => {
    // Project default is gemini; the voice says gemini explicitly -> gemini called.
    const settings: ProjectTtsSettings = {
      provider: "gemini",
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

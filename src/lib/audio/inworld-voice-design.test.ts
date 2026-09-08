import { describe, expect, it } from "vitest"
import {
  INWORLD_DESIGN_DEFAULT_PREVIEW_TEXT,
  INWORLD_DESIGN_PREVIEW_TEXT_MIN,
  isInworldDesignedVoiceId,
  previewAudioMime,
  previewAudioSrc,
} from "./inworld-voice-design"

describe("INWORLD_DESIGN_DEFAULT_PREVIEW_TEXT", () => {
  it("is BSB Revelation 1:17–18 and long enough for Voice Design", () => {
    expect(INWORLD_DESIGN_DEFAULT_PREVIEW_TEXT).toMatch(/I was dead/i)
    expect(INWORLD_DESIGN_DEFAULT_PREVIEW_TEXT).toMatch(/alive forever and ever/i)
    expect(INWORLD_DESIGN_DEFAULT_PREVIEW_TEXT.length).toBeGreaterThanOrEqual(INWORLD_DESIGN_PREVIEW_TEXT_MIN)
  })
})

describe("isInworldDesignedVoiceId", () => {
  it("matches Inworld Voice Design ids", () => {
    expect(isInworldDesignedVoiceId("ws__design-voice-38b05df9")).toBe(true)
    expect(isInworldDesignedVoiceId("Dennis")).toBe(false)
    expect(isInworldDesignedVoiceId("ws__narrator_20260907_120000z")).toBe(false)
  })
})

describe("previewAudioMime", () => {
  it("sniffs WAV and MP3 from the base64 prefix", () => {
    expect(previewAudioMime("UklGRQAAAAA=")).toBe("audio/wav")
    expect(previewAudioMime("SUQzAAAA")).toBe("audio/mpeg")
    expect(previewAudioSrc("UklGRQAAAAA=")).toMatch(/^data:audio\/wav;base64,UklGRQ/)
  })
})

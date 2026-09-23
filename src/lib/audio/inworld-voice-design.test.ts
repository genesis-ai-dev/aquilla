import { describe, expect, it } from "vitest"
import {
  INWORLD_DESIGN_DEFAULT_PREVIEW_TEXT,
  INWORLD_DESIGN_PRESET_IDS,
  INWORLD_DESIGN_PREVIEW_TEXT_MIN,
  INWORLD_DESIGN_PROMPT_MAX,
  blankInworldVoiceProfile,
  blankStructuredDesignPrompt,
  buildDesignPreviewAudioId,
  initialInworldDesignMode,
  inworldDesignPresetPrompt,
  inworldDesignPreviewBlob,
  inworldDesignPreviewExt,
  inworldVoiceProfileHasValue,
  isInworldDesignedVoiceId,
  looksLikeInworldVoiceProfile,
  matchingInworldDesignPreset,
  parseInworldVoiceProfile,
  previewAudioMime,
  previewAudioSrc,
  serializeInworldVoiceProfile,
  structuredDesignPromptHasValue,
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

  it("builds a typed blob and R2 object name for a picked sample", () => {
    expect(inworldDesignPreviewExt("UklGRQAAAAA=")).toBe("wav")
    expect(inworldDesignPreviewExt("SUQzAAAA")).toBe("mp3")
    const blob = inworldDesignPreviewBlob("UklGRQAAAAA=")
    expect(blob.type).toBe("audio/wav")
    expect(buildDesignPreviewAudioId("wav")).toMatch(/^design-preview-\d+-[a-z0-9]+\.wav$/)
  })
})

describe("Inworld structured voice profile", () => {
  it("serializes the blank template as one attribute per line", () => {
    const text = serializeInworldVoiceProfile(blankInworldVoiceProfile())
    expect(text).toBe([
      "dialect:",
      "gender:",
      "age:",
      "emotion:",
      "tone:",
      "pitch:",
      "volume:",
      "speed:",
      "clarity:",
      "fluency:",
      "personality:",
      "texture:",
      "environment:",
    ].join("\n"))
    expect(looksLikeInworldVoiceProfile(text)).toBe(true)
    expect(inworldVoiceProfileHasValue(blankInworldVoiceProfile())).toBe(false)
    expect(structuredDesignPromptHasValue(text)).toBe(false)
    expect(initialInworldDesignMode(text)).toBe("structured")
  })

  it("seeds the Structured textarea with a trailing space after each key", () => {
    expect(blankStructuredDesignPrompt()).toBe([
      "dialect: ",
      "gender: ",
      "age: ",
      "emotion: ",
      "tone: ",
      "pitch: ",
      "volume: ",
      "speed: ",
      "clarity: ",
      "fluency: ",
      "personality: ",
      "texture: ",
      "environment: ",
    ].join("\n"))
    expect(structuredDesignPromptHasValue(blankStructuredDesignPrompt())).toBe(false)
    expect(looksLikeInworldVoiceProfile(blankStructuredDesignPrompt())).toBe(true)
  })

  it("round-trips filled attributes and extra lines", () => {
    const profile = {
      ...blankInworldVoiceProfile(),
      dialect: "British English",
      gender: "male",
      age: "middle-aged",
      tone: "warm, neutral",
    }
    const extras = [{ key: "accent", value: "Received Pronunciation" }]
    const text = serializeInworldVoiceProfile(profile, extras)
    expect(text).toContain("dialect: British English")
    expect(text).toContain("accent: Received Pronunciation")
    const parsed = parseInworldVoiceProfile(text)
    expect(parsed.profile).toEqual(profile)
    expect(parsed.extras).toEqual(extras)
    expect(inworldVoiceProfileHasValue(parsed.profile, parsed.extras)).toBe(true)
  })

  it("does not treat a freeform paragraph as a profile", () => {
    const prose =
      "A middle-aged male voice with a clear British accent speaking at a steady pace and with a warm, neutral tone."
    expect(looksLikeInworldVoiceProfile(prose)).toBe(false)
    expect(initialInworldDesignMode(prose)).toBe("freeform")
    expect(parseInworldVoiceProfile(prose).profile).toEqual(blankInworldVoiceProfile())
  })
})

describe("Inworld Voice Design presets", () => {
  it("keeps every preset inside the prompt budget and ready to generate", () => {
    for (const id of INWORLD_DESIGN_PRESET_IDS) {
      const freeform = inworldDesignPresetPrompt(id, "freeform")
      const structured = inworldDesignPresetPrompt(id, "structured")
      expect(freeform.length).toBeGreaterThanOrEqual(30)
      expect(freeform.length).toBeLessThanOrEqual(INWORLD_DESIGN_PROMPT_MAX)
      expect(structured.length).toBeGreaterThanOrEqual(30)
      expect(structured.length).toBeLessThanOrEqual(INWORLD_DESIGN_PROMPT_MAX)
      expect(looksLikeInworldVoiceProfile(structured)).toBe(true)
      expect(structuredDesignPromptHasValue(structured)).toBe(true)
      expect(matchingInworldDesignPreset(freeform, "freeform")).toBe(id)
      expect(matchingInworldDesignPreset(structured, "structured")).toBe(id)
    }
  })

  it("clears the match after the prompt is edited", () => {
    const agent = inworldDesignPresetPrompt("agent", "freeform")
    expect(matchingInworldDesignPreset(`${agent} extra`, "freeform")).toBeNull()
    const structured = inworldDesignPresetPrompt("pirate", "structured")
    expect(matchingInworldDesignPreset(structured.replace("male", "female"), "structured")).toBeNull()
  })
})

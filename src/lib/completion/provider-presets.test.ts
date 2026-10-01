import { describe, it, expect } from "vitest"
import {
  CUSTOM_PRESETS,
  CUSTOM_PRESET_ID,
  endpointForPresetChange,
  findPreset,
  presetIdForEndpoint,
  presetLabel,
} from "./provider-presets"
import type { TFunction } from "@/lib/i18n/I18nProvider"

const fakeT = ((key: string) => `t:${key}`) as unknown as TFunction

describe("provider presets (AQU-796)", () => {
  it("offers the well-known BYO providers plus local and custom", () => {
    const ids = CUSTOM_PRESETS.map((p) => p.id)
    expect(ids).toContain("openai")
    expect(ids).toContain("openrouter")
    expect(ids).toContain("local")
    expect(ids).toContain(CUSTOM_PRESET_ID)
  })

  it("gives every preset a resolvable label", () => {
    for (const preset of CUSTOM_PRESETS) {
      expect(presetLabel(fakeT, preset)).not.toBe("")
    }
  })

  it("translates labelKey entries and passes brand names through verbatim", () => {
    expect(presetLabel(fakeT, { labelKey: "projectSettings.advancedLlm.presetCustomLabel" }))
      .toBe("t:projectSettings.advancedLlm.presetCustomLabel")
    expect(presetLabel(fakeT, { label: "OpenRouter" })).toBe("OpenRouter")
  })

  describe("presetIdForEndpoint", () => {
    it("reads an empty endpoint as local", () => {
      expect(presetIdForEndpoint("")).toBe("local")
      expect(presetIdForEndpoint("   ")).toBe("local")
    })

    it("recognises a known provider, ignoring case and trailing slashes", () => {
      expect(presetIdForEndpoint("https://api.openai.com/v1")).toBe("openai")
      expect(presetIdForEndpoint("https://API.OpenAI.com/v1/")).toBe("openai")
      expect(presetIdForEndpoint("https://openrouter.ai/api/v1")).toBe("openrouter")
    })

    it("falls back to custom for an unrecognised endpoint", () => {
      expect(presetIdForEndpoint("https://llm.example.internal/v1")).toBe(CUSTOM_PRESET_ID)
    })
  })

  describe("endpointForPresetChange", () => {
    it("pre-fills the endpoint for a known provider so no URL is hand-typed", () => {
      expect(endpointForPresetChange("openai", "")).toBe("https://api.openai.com/v1")
      expect(endpointForPresetChange("openrouter", "https://api.openai.com/v1"))
        .toBe("https://openrouter.ai/api/v1")
    })

    it("keeps whatever the user typed when they pick custom", () => {
      expect(endpointForPresetChange(CUSTOM_PRESET_ID, "https://llm.example.internal/v1"))
        .toBe("https://llm.example.internal/v1")
      expect(endpointForPresetChange(CUSTOM_PRESET_ID, "")).toBe("")
    })

    it("leaves the endpoint alone for an unknown preset id", () => {
      expect(endpointForPresetChange("nope", "https://api.openai.com/v1"))
        .toBe("https://api.openai.com/v1")
    })
  })

  it("round-trips: selecting a preset yields an endpoint that maps back to it", () => {
    for (const preset of CUSTOM_PRESETS) {
      if (preset.id === CUSTOM_PRESET_ID) continue
      expect(presetIdForEndpoint(endpointForPresetChange(preset.id, ""))).toBe(preset.id)
    }
  })

  it("findPreset resolves by id and returns undefined otherwise", () => {
    expect(findPreset("groq")?.endpoint).toBe("https://api.groq.com/openai/v1")
    expect(findPreset("not-a-preset")).toBeUndefined()
  })
})

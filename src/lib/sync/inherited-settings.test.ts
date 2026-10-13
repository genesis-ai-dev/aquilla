import { describe, expect, it } from "vitest"
import {
  INHERIT_DEFAULTS,
  INHERIT_FIELD_KEYS,
  INHERIT_NEVER_KEYS,
  applyUpstreamSettingsCopy,
  emptyInheritedFromLink,
  inheritChoiceFromRequest,
  isReceiving,
} from "./inherited-settings"

describe("inherited settings vocabulary (AQU-1075)", () => {
  it("leaves AI instructions, living memory, and smart quotes off by default", () => {
    const choice = inheritChoiceFromRequest(undefined)
    expect(choice).toEqual(INHERIT_DEFAULTS)
    expect(choice.translationBrief).toBe(true)
    expect(choice.knowledgeDocs).toBe(true)
    expect(choice.workflowPolicy).toBe(true)
    expect(choice.livingMemory).toBe(false)
    expect(choice.smartQuotes).toBe(false)
    expect(choice.systemPrompt).toBe(false)
  })

  it("never copies people, lanes, languages, rules, terminology, direction, speech, or timing", () => {
    const copied = new Set(Object.values(INHERIT_FIELD_KEYS).flat())
    for (const key of INHERIT_NEVER_KEYS) {
      expect(copied.has(key)).toBe(false)
    }
    expect(copied.has("systemPrompt")).toBe(true)
    expect(copied.has("translationBrief")).toBe(true)
    expect(copied.has("validationNamedUsers")).toBe(false)
    expect(copied.has("rules")).toBe(false)
  })

  it("a detached field is not part of the downstream patch", () => {
    const config = emptyInheritedFromLink()
    config.detached.translationBrief = true
    const downstream = {
      translationBrief: { summary: "kept" },
      systemPrompt: "local instructions",
      inheritedFromLink: config,
    }
    const patched = applyUpstreamSettingsCopy(
      { translationBrief: { summary: "one" }, systemPrompt: "pair A" },
      { translationBrief: { summary: "two" }, systemPrompt: "pair A revised" },
      downstream,
    )
    expect(patched).toBeNull()
    expect(isReceiving(config, "translationBrief")).toBe(false)
    expect(isReceiving(config, "systemPrompt")).toBe(false)
  })

  it("copies a received brief and leaves an unreceived system prompt", () => {
    const config = emptyInheritedFromLink()
    const patched = applyUpstreamSettingsCopy(
      { translationBrief: { summary: "one" }, systemPrompt: "pair A" },
      { translationBrief: { summary: "two" }, systemPrompt: "pair A revised" },
      {
        translationBrief: { summary: "one" },
        systemPrompt: "local instructions",
        inheritedFromLink: config,
      },
    )
    expect(patched?.translationBrief).toEqual({ summary: "two" })
    expect(patched?.systemPrompt).toBe("local instructions")
    expect(patched?.inheritedFromLink).toEqual(config)
  })
})

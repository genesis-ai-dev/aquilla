// A line's own delivery (AQU-2577).
//
// WHY: the tags and the per-line speed are spoken, never written. They must
// reach the engine for the line they were set on, only for a model that reads
// tags (another model would say "whispers" aloud), and must never touch the
// voice that every other line shares.
import { describe, expect, it } from "vitest"
import { lineDeliveryFor, lineDeliveryPatch, normalizeLineTag, withLineDelivery } from "./line-delivery"
import type { ProjectTtsSettings, Voice } from "@/lib/parsers/types"

const voice = (modelId?: string): Voice => ({
  id: "v1", name: "Layla", provider: "elevenlabs",
  elevenLabs: { voiceId: "el1", modelId, settings: { stability: 0.5, similarityBoost: 0.75, style: 0, speed: 1, speakerBoost: true } },
})

describe("withLineDelivery", () => {
  it("lays the line's knobs over the voice's and puts its tags before the text, for a model that reads tags", () => {
    const v = voice("eleven_v4")
    const spoken = withLineDelivery(v, "الله ليس غاضبًا منك.", { settings: { speed: 0.9, style: 0.6 }, tags: ["crying", "[Sighs]", ""] })
    expect(spoken.text).toBe("[crying] [sighs] الله ليس غاضبًا منك.")
    expect(spoken.voice.elevenLabs?.settings).toEqual({ stability: 0.5, similarityBoost: 0.75, style: 0.6, speed: 0.9, speakerBoost: true })
    expect(spoken.voice.id).toBe("v1")
    // The shared voice is untouched: every other line still reads at its speed.
    expect(v.elevenLabs?.settings?.speed).toBe(1)
  })

  it("keeps tags out of the text for a model that would speak them, but still applies the knobs", () => {
    for (const modelId of [undefined, "eleven_multilingual_v2", "eleven_flash_v2_5"]) {
      const spoken = withLineDelivery(voice(modelId), "Hello.", { settings: { speed: 0.8 }, tags: ["whispers"] })
      expect(spoken.text, String(modelId)).toBe("Hello.")
      expect(spoken.voice.elevenLabs?.settings?.speed).toBe(0.8)
    }
  })

  it("changes nothing for a line with no delivery or a voice from another engine", () => {
    const v = voice("eleven_v4")
    expect(withLineDelivery(v, "Hello.", undefined)).toEqual({ voice: v, text: "Hello." })
    const inworld: Voice = { id: "v2", name: "Narrator", provider: "inworld" }
    expect(withLineDelivery(inworld, "Hello.", { tags: ["whispers"], settings: { speed: 0.8 } })).toEqual({ voice: inworld, text: "Hello." })
  })
})

describe("lineDeliveryPatch", () => {
  it("sets one line and leaves the others, and drops a line whose delivery is emptied", () => {
    const settings: ProjectTtsSettings = { lineDelivery: { a: { tags: ["sighs"] } } }
    const set = lineDeliveryPatch(settings, "b", { settings: { speed: 0.9 } })
    expect(set.lineDelivery).toEqual({ a: { tags: ["sighs"] }, b: { settings: { speed: 0.9 } } })
    expect(lineDeliveryFor({ ...settings, ...set }, "b")).toEqual({ settings: { speed: 0.9 } })
    expect(lineDeliveryPatch(settings, "a", { tags: [], settings: {} }).lineDelivery).toEqual({})
    expect(lineDeliveryPatch(settings, "a", null).lineDelivery).toEqual({})
  })
})

describe("normalizeLineTag", () => {
  it("stores a tag as plain lower-case words, whatever was typed", () => {
    expect(["[Whispers]", "  strong  French accent ", "laughs!!", "[]"].map(normalizeLineTag))
      .toEqual(["whispers", "strong french accent", "laughs", ""])
  })
})

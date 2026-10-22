import { describe, expect, it } from "vitest"
import { incomingRewritesHiddenVoices, leadMaySaveTtsSettings } from "./voice-wall"

const lanes = [
  { id: "ln-es", name: "Spanish", legacyTag: "es" },
  { id: "ln-de", name: "German", legacyTag: "de" },
]

const stored = {
  apiKey: "device",
  voices: [
    { id: "narrator", name: "Narrator" },
    { id: "es-1", name: "Spanish", laneId: "ln-es" },
    { id: "de-1", name: "German", laneId: "ln-de" },
  ],
  defaultVoiceId: "narrator",
  castAssignments: { hero: "de-1" },
  laneCastAssignments: { es: { guide: "es-1" }, de: { hero: "de-1" } },
  laneDefaultVoiceId: { es: "es-1", de: "de-1" },
}

const spanish = new Set(["ln-es"])

describe("lead voice saves (AQU-2041)", () => {
  it("allows a change to the lead's own lane and nothing else", () => {
    const next = {
      ...stored,
      voices: stored.voices.map((voice) => (voice.id === "es-1" ? { ...voice, name: "Español" } : voice)),
      laneDefaultVoiceId: { ...stored.laneDefaultVoiceId, es: "es-1" },
    }
    expect(leadMaySaveTtsSettings(stored, next, spanish, lanes)).toBe(true)
  })

  it("refuses a shared voice, a hidden lane, the project-wide cast, and another voice setting", () => {
    const renamedNarrator = {
      ...stored,
      voices: stored.voices.map((voice) => (voice.id === "narrator" ? { ...voice, name: "Host" } : voice)),
    }
    expect(leadMaySaveTtsSettings(stored, renamedNarrator, spanish, lanes)).toBe(false)
    const renamedGerman = {
      ...stored,
      voices: stored.voices.map((voice) => (voice.id === "de-1" ? { ...voice, name: "Deutsch" } : voice)),
    }
    expect(leadMaySaveTtsSettings(stored, renamedGerman, spanish, lanes)).toBe(false)
    expect(leadMaySaveTtsSettings(stored, { ...stored, castAssignments: {} }, spanish, lanes)).toBe(false)
    expect(leadMaySaveTtsSettings(stored, { ...stored, apiKey: "other" }, spanish, lanes)).toBe(false)
    expect(leadMaySaveTtsSettings(stored, { ...stored, laneCastAssignments: { es: { guide: "es-1" } } }, spanish, lanes)).toBe(false)
  })

  it("treats a crafted hidden voice as a rewrite and an omission as an echo", () => {
    const crafted = {
      ...stored,
      voices: stored.voices.map((voice) => (voice.id === "de-1" ? { ...voice, name: "Deutsch" } : voice)),
    }
    expect(incomingRewritesHiddenVoices(stored, crafted, spanish, lanes)).toBe(true)
    const echo = {
      ...stored,
      voices: stored.voices.filter((voice) => voice.id !== "de-1"),
      laneCastAssignments: { es: { guide: "es-1" } },
      laneDefaultVoiceId: { es: "es-1" },
    }
    expect(incomingRewritesHiddenVoices(stored, echo, spanish, lanes)).toBe(false)
    expect(incomingRewritesHiddenVoices(stored, crafted, null, lanes)).toBe(false)
  })
})

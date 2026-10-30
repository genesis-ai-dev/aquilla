import { describe, expect, it } from "vitest"
import {
  CHARACTER_VOICES,
  CHARACTER_VOICE_FILTERS,
  characterVoicePreviewUrl,
  filterCharacterVoices,
  findCharacterVoice,
  voiceFromCharacter,
} from "./character-voices"

describe("character voice catalog", () => {
  it("uses ids the voice forge and the worker accept", () => {
    // sync-worker LIBRARY_VOICE_ID_RE / voice_forge.py _voice_dir
    for (const c of CHARACTER_VOICES) expect(c.id).toMatch(/^[a-z0-9][a-z0-9_-]{1,40}$/)
    expect(new Set(CHARACTER_VOICES.map((c) => c.id)).size).toBe(CHARACTER_VOICES.length)
  })

  it("gives every filter someone to find", () => {
    for (const f of CHARACTER_VOICE_FILTERS) {
      expect(filterCharacterVoices(CHARACTER_VOICES, [f]).length).toBeGreaterThan(0)
    }
  })

  it("narrows across groups and widens within one", () => {
    const oldWomen = filterCharacterVoices(CHARACTER_VOICES, ["female", "old"])
    expect(oldWomen.map((c) => c.name)).toEqual(["Sage"])
    const youngOrOld = filterCharacterVoices(CHARACTER_VOICES, ["young", "old"])
    expect(youngOrOld.every((c) => c.age !== "middle-aged")).toBe(true)
    expect(youngOrOld.some((c) => c.age === "young") && youngOrOld.some((c) => c.age === "old")).toBe(true)
  })

  it("builds a cast Voice that routes on libraryVoiceId alone", () => {
    const hearth = findCharacterVoice("narrator-hearth")!
    expect(voiceFromCharacter(hearth, { id: "v1", color: "#475569" })).toEqual({
      id: "v1", name: "Hearth", color: "#475569", libraryVoiceId: "narrator-hearth",
    })
    expect(characterVoicePreviewUrl("narrator-hearth")).toBe("/character-voices/narrator-hearth.mp3")
  })
})

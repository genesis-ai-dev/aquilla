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

  it("tags every voice with a sex and an age band, so each filter finds someone", () => {
    for (const c of CHARACTER_VOICES) {
      expect(c.tags.some((t) => t === "male" || t === "female")).toBe(true)
    }
    for (const f of CHARACTER_VOICE_FILTERS) {
      expect(filterCharacterVoices(CHARACTER_VOICES, [f]).length).toBeGreaterThan(0)
    }
  })

  it("ANDs filters together", () => {
    const elderlyWomen = filterCharacterVoices(CHARACTER_VOICES, ["female", "elderly"])
    expect(elderlyWomen.length).toBeGreaterThan(0)
    for (const c of elderlyWomen) expect(c.tags).toEqual(expect.arrayContaining(["female", "elderly"]))
  })

  it("builds a cast Voice that routes on libraryVoiceId alone", () => {
    const hearth = findCharacterVoice("narrator-hearth")!
    expect(voiceFromCharacter(hearth, { id: "v1", color: "#475569" })).toEqual({
      id: "v1", name: "Hearth", color: "#475569", libraryVoiceId: "narrator-hearth",
    })
    expect(characterVoicePreviewUrl("narrator-hearth")).toBe("/character-voices/narrator-hearth.mp3")
  })
})

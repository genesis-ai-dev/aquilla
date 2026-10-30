// Character voices: the pre-built cast a project can add to its voice library
// with one click. Each entry is an RVC voice model trained by
// infra/modal/voice_forge.py from a voice designed with Qwen3-TTS — a synthetic
// voice that belongs to no real person, so no speaker release is needed.
//
// A character voice is speech-to-speech: Change voice re-voices a line's take
// (typically a native reader) into the character, keeping the reader's words,
// pronunciation, timing and intonation, so it works in any language. Generate
// reads the text with the stock TTS voice first, then re-voices that.
//
// Keep in step with infra/modal/voice_forge_cast.json (the forge's build list).
// A voice listed here but not yet trained fails Change voice with a 404 from the
// forge, so add entries only after `modal run …::cast` has built them. Previews
// all read the same line (voice_forge.py PREVIEW_TEXT) through the trained
// model, served from public/character-voices/<id>.mp3.

import type { Voice } from "@/lib/parsers/types"
import { newVoiceId } from "./voices"

export type CharacterVoiceSex = "male" | "female"
/** Young: children to late twenties. Middle-aged: thirties to fifties. Old: sixties on. */
export type CharacterVoiceAge = "young" | "middle-aged" | "old"
/** Vocal range, highest to lowest. */
export const CHARACTER_VOICE_RANGES = ["treble", "soprano", "mezzo", "alto", "tenor", "baritone", "bass"] as const
export type CharacterVoiceRange = (typeof CHARACTER_VOICE_RANGES)[number]

export interface CharacterVoice {
  /** voice_forge.py voice id; sent to the worker as `libraryVoiceId`. */
  id: string
  name: string
  sex: CharacterVoiceSex
  age: CharacterVoiceAge
  range: CharacterVoiceRange
}

// The descriptions each voice was designed from stay in voice_forge_cast.json;
// the picker shows only who it is (sex, age) and where it sits (range).
export const CHARACTER_VOICES: readonly CharacterVoice[] = [
  { id: "narrator-hearth", name: "Hearth", sex: "male", age: "middle-aged", range: "baritone" },
  { id: "narrator-willow", name: "Willow", sex: "female", age: "middle-aged", range: "alto" },
  { id: "fisherman", name: "Tide", sex: "male", age: "middle-aged", range: "baritone" },
  { id: "elder-oak", name: "Oak", sex: "male", age: "old", range: "bass" },
  { id: "elder-sage", name: "Sage", sex: "female", age: "old", range: "mezzo" },
  { id: "youth-ember", name: "Ember", sex: "male", age: "young", range: "tenor" },
  { id: "youth-lark", name: "Lark", sex: "female", age: "young", range: "soprano" },
  { id: "mother-dove", name: "Dove", sex: "female", age: "middle-aged", range: "mezzo" },
  { id: "commander-iron", name: "Iron", sex: "male", age: "middle-aged", range: "bass" },
  { id: "official-frost", name: "Frost", sex: "male", age: "middle-aged", range: "baritone" },
  { id: "merchant-wren", name: "Wren", sex: "male", age: "middle-aged", range: "tenor" },
  { id: "zealot-flint", name: "Flint", sex: "male", age: "middle-aged", range: "baritone" },
  { id: "laborer-stone", name: "Stone", sex: "male", age: "middle-aged", range: "baritone" },
  { id: "scholar-quill", name: "Quill", sex: "male", age: "old", range: "tenor" },
  { id: "widow-ash", name: "Ash", sex: "female", age: "middle-aged", range: "alto" },
  { id: "healer-balm", name: "Balm", sex: "female", age: "middle-aged", range: "mezzo" },
  { id: "servant-fern", name: "Fern", sex: "female", age: "young", range: "soprano" },
  { id: "rebel-vale", name: "Vale", sex: "female", age: "young", range: "alto" },
  { id: "teen-sparrow", name: "Sparrow", sex: "male", age: "young", range: "tenor" },
  { id: "child-poppy", name: "Poppy", sex: "female", age: "young", range: "soprano" },
  { id: "child-pip", name: "Pip", sex: "male", age: "young", range: "treble" },
]

/** Filters offered above the grid, in display order. */
export const CHARACTER_VOICE_FILTERS = ["female", "male", "young", "middle-aged", "old"] as const
export type CharacterVoiceFilter = (typeof CHARACTER_VOICE_FILTERS)[number]

export function characterVoicePreviewUrl(id: string): string {
  return `/character-voices/${encodeURIComponent(id)}.mp3`
}

export function findCharacterVoice(id: string | undefined): CharacterVoice | undefined {
  return id ? CHARACTER_VOICES.find((c) => c.id === id) : undefined
}

/**
 * Filters within a group (sex, age) widen; the groups narrow each other:
 * female + old = old women; young + old = both.
 */
export function filterCharacterVoices(
  voices: readonly CharacterVoice[],
  filters: readonly CharacterVoiceFilter[],
): CharacterVoice[] {
  const sexes = filters.filter((f): f is CharacterVoiceSex => f === "male" || f === "female")
  const ages = filters.filter((f): f is CharacterVoiceAge => f !== "male" && f !== "female")
  return voices.filter((v) =>
    (sexes.length === 0 || sexes.includes(v.sex)) && (ages.length === 0 || ages.includes(v.age)))
}

/**
 * A project Voice that points at a character. No provider, reference clip or
 * TTS voice name: Change voice and Generate route on `libraryVoiceId` alone.
 */
export function voiceFromCharacter(character: CharacterVoice, base: { id?: string; color?: string } = {}): Voice {
  return {
    id: base.id ?? newVoiceId(),
    name: character.name,
    ...(base.color ? { color: base.color } : {}),
    libraryVoiceId: character.id,
  }
}

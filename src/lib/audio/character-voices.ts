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
// are the forge's anchor clips, served from public/character-voices/<id>.mp3.

import type { Voice } from "@/lib/parsers/types"
import { newVoiceId } from "./voices"

export interface CharacterVoice {
  /** voice_forge.py voice id; sent to the worker as `libraryVoiceId`. */
  id: string
  name: string
  /** Sex, age band, register and a character note, e.g. ["female", "elderly", "mezzo", "wise"]. */
  tags: string[]
  /** The description the voice was designed from (English, shown as the card blurb). */
  description: string
}

export const CHARACTER_VOICES: readonly CharacterVoice[] = [
  {
    id: "narrator-hearth",
    name: "Hearth",
    tags: ["male", "adult", "baritone", "narrator"],
    description:
      "A warm, rich mature male narrator in his fifties: smooth baritone, calm and steady, like a trusted storyteller by a fire.",
  },
  {
    id: "narrator-willow",
    name: "Willow",
    tags: ["female", "adult", "alto", "narrator"],
    description:
      "A warm mature female narrator in her forties: rich, clear alto, unhurried and gentle, with quiet authority.",
  },
  {
    id: "fisherman",
    name: "Tide",
    tags: ["male", "adult", "baritone", "gravelly"],
    description:
      "A weathered middle-aged fisherman: warm, gravelly baritone, slow and deliberate, slightly hoarse, kind.",
  },
  {
    id: "elder-oak",
    name: "Oak",
    tags: ["male", "elderly", "bass", "dignified"],
    description:
      "An elderly man in his late seventies: deep, slightly raspy and unsteady voice, dignified and wise, speaking slowly.",
  },
  {
    id: "elder-sage",
    name: "Sage",
    tags: ["female", "elderly", "mezzo", "wise"],
    description:
      "An elderly woman in her eighties: thin, gentle, slightly trembling voice, warm and joyful, full of wisdom.",
  },
  {
    id: "youth-ember",
    name: "Ember",
    tags: ["male", "young-adult", "tenor", "earnest"],
    description:
      "A young man in his early twenties: bright, clear tenor, eager and sincere, a little impulsive, full of energy.",
  },
  {
    id: "youth-lark",
    name: "Lark",
    tags: ["female", "young-adult", "soprano", "lively"],
    description:
      "A young woman in her early twenties: bright, clear, light soprano voice, lively and expressive, quick to laugh.",
  },
  {
    id: "mother-dove",
    name: "Dove",
    tags: ["female", "adult", "mezzo", "tender"],
    description:
      "A woman in her thirties: soft, warm mezzo-soprano, tender and hushed, deeply caring, with quiet strength.",
  },
  {
    id: "commander-iron",
    name: "Iron",
    tags: ["male", "adult", "bass", "authority"],
    description:
      "A man in his forties used to command: deep, resonant bass voice, measured and authoritative, controlled and serious.",
  },
  {
    id: "official-frost",
    name: "Frost",
    tags: ["male", "adult", "baritone", "antagonist"],
    description:
      "A refined official in his fifties: crisp, precise, cool baritone with a slightly nasal, aristocratic edge, calculating and condescending.",
  },
  {
    id: "merchant-wren",
    name: "Wren",
    tags: ["male", "adult", "tenor", "comic"],
    description:
      "A quick-witted merchant in his thirties: slightly nasal tenor, speaks fast and precisely, a bit anxious, clever and self-deprecating.",
  },
  {
    id: "zealot-flint",
    name: "Flint",
    tags: ["male", "adult", "baritone", "intense"],
    description:
      "A passionate man in his thirties: intense, slightly hoarse baritone with sharp edges, fiery and urgent, restless.",
  },
  {
    id: "laborer-stone",
    name: "Stone",
    tags: ["male", "adult", "baritone", "rough"],
    description:
      "A burly laborer in his forties: loud, rough, earthy voice, plain-spoken and blunt, with a hearty laugh.",
  },
  {
    id: "scholar-quill",
    name: "Quill",
    tags: ["male", "elderly", "tenor", "soft-spoken"],
    description:
      "A scholar in his sixties: soft-spoken, thoughtful, slightly breathy light voice, precise and careful with every word.",
  },
  {
    id: "widow-ash",
    name: "Ash",
    tags: ["female", "adult", "alto", "husky"],
    description:
      "A woman in her fifties who has known hardship: low, husky alto, weary but unbroken, dry humor, strong.",
  },
  {
    id: "healer-balm",
    name: "Balm",
    tags: ["female", "adult", "mezzo", "calm"],
    description:
      "A healer in her forties: calm, measured, soothing mezzo voice, steady and reassuring, never hurried.",
  },
  {
    id: "servant-fern",
    name: "Fern",
    tags: ["female", "young-adult", "soprano", "timid"],
    description:
      "A shy young woman of about eighteen: quiet, slightly breathy light voice, timid and hesitant, but sincere.",
  },
  {
    id: "rebel-vale",
    name: "Vale",
    tags: ["female", "adult", "alto", "fierce"],
    description:
      "A fierce woman in her late twenties: strong, slightly raspy alto, bold and defiant, quick-tongued and confident.",
  },
  {
    id: "teen-sparrow",
    name: "Sparrow",
    tags: ["male", "teen", "tenor", "curious"],
    description:
      "A boy of about fourteen whose voice is just starting to change: curious, a little awkward, earnest and talkative.",
  },
  {
    id: "child-poppy",
    name: "Poppy",
    tags: ["female", "child", "soprano", "innocent"],
    description:
      "A girl of about eight: light, high, clear voice, innocent and curious, speaking with wonder.",
  },
  {
    id: "child-pip",
    name: "Pip",
    tags: ["male", "child", "treble", "playful"],
    description:
      "A boy of about nine: high, bright voice, playful and mischievous, full of energy and questions.",
  },
]

/** Tag filters offered above the grid, in display order. */
export const CHARACTER_VOICE_FILTERS = ["female", "male", "child", "teen", "young-adult", "adult", "elderly"] as const
export type CharacterVoiceFilter = (typeof CHARACTER_VOICE_FILTERS)[number]

export function characterVoicePreviewUrl(id: string): string {
  return `/character-voices/${encodeURIComponent(id)}.mp3`
}

export function findCharacterVoice(id: string | undefined): CharacterVoice | undefined {
  return id ? CHARACTER_VOICES.find((c) => c.id === id) : undefined
}

/** Every filter must match (female + elderly = elderly women). */
export function filterCharacterVoices(
  voices: readonly CharacterVoice[],
  filters: readonly CharacterVoiceFilter[],
): CharacterVoice[] {
  return voices.filter((v) => filters.every((f) => v.tags.includes(f)))
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

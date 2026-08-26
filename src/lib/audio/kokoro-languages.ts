// Kokoro voice ids are `{lang}{gender}_{name}` (e.g. af_heart, bm_george).
// The first letter is the language, from hexgrad/kokoro:
//
//   a  American English   → phonemizer "en-us"
//   b  British English    → phonemizer "en-gb"
//   e  Spanish            → "es"
//   f  French             → "fr-fr"
//   h  Hindi              → "hi"
//   i  Italian            → "it"
//   j  Japanese           → "ja"   (Python: misaki[ja])
//   p  Brazilian Portuguese → "pt-br"
//   z  Mandarin Chinese   → "cmn"  (Python: misaki[zh])
//
// The browser bundle (kokoro-js 82M ONNX) only ships `a*` / `b*` voices.
// Other prefixes exist in the Python model; we map them so a project
// language like "en-us" selects American English rather than being
// forwarded as a phonemizer id.

export type KokoroLangPrefix = "a" | "b" | "e" | "f" | "h" | "i" | "j" | "p" | "z"

export const DEFAULT_KOKORO_VOICE = "af_heart"
export const DEFAULT_KOKORO_BRITISH_VOICE = "bf_emma"

export type KokoroVoiceGender = "female" | "male"

export interface KokoroBundledVoice {
  id: string
  name: string
  gender: KokoroVoiceGender
  prefix: "a" | "b"
}

export interface KokoroVoiceGroup {
  prefix: "a" | "b"
  voices: readonly KokoroBundledVoice[]
}

/** 82M ONNX catalog from kokoro-js 1.2.1 (`voices` freeze). Names are proper nouns. */
export const KOKORO_BUNDLED_VOICES: readonly KokoroBundledVoice[] = [
  { id: "af_heart", name: "Heart", gender: "female", prefix: "a" },
  { id: "af_alloy", name: "Alloy", gender: "female", prefix: "a" },
  { id: "af_aoede", name: "Aoede", gender: "female", prefix: "a" },
  { id: "af_bella", name: "Bella", gender: "female", prefix: "a" },
  { id: "af_jessica", name: "Jessica", gender: "female", prefix: "a" },
  { id: "af_kore", name: "Kore", gender: "female", prefix: "a" },
  { id: "af_nicole", name: "Nicole", gender: "female", prefix: "a" },
  { id: "af_nova", name: "Nova", gender: "female", prefix: "a" },
  { id: "af_river", name: "River", gender: "female", prefix: "a" },
  { id: "af_sarah", name: "Sarah", gender: "female", prefix: "a" },
  { id: "af_sky", name: "Sky", gender: "female", prefix: "a" },
  { id: "am_adam", name: "Adam", gender: "male", prefix: "a" },
  { id: "am_echo", name: "Echo", gender: "male", prefix: "a" },
  { id: "am_eric", name: "Eric", gender: "male", prefix: "a" },
  { id: "am_fenrir", name: "Fenrir", gender: "male", prefix: "a" },
  { id: "am_liam", name: "Liam", gender: "male", prefix: "a" },
  { id: "am_michael", name: "Michael", gender: "male", prefix: "a" },
  { id: "am_onyx", name: "Onyx", gender: "male", prefix: "a" },
  { id: "am_puck", name: "Puck", gender: "male", prefix: "a" },
  { id: "am_santa", name: "Santa", gender: "male", prefix: "a" },
  { id: "bf_emma", name: "Emma", gender: "female", prefix: "b" },
  { id: "bf_isabella", name: "Isabella", gender: "female", prefix: "b" },
  { id: "bf_alice", name: "Alice", gender: "female", prefix: "b" },
  { id: "bf_lily", name: "Lily", gender: "female", prefix: "b" },
  { id: "bm_george", name: "George", gender: "male", prefix: "b" },
  { id: "bm_lewis", name: "Lewis", gender: "male", prefix: "b" },
  { id: "bm_daniel", name: "Daniel", gender: "male", prefix: "b" },
  { id: "bm_fable", name: "Fable", gender: "male", prefix: "b" },
]

const BUNDLED_VOICE_IDS = new Set(KOKORO_BUNDLED_VOICES.map((v) => v.id))

const PREFIX_TO_PHONEMIZER: Record<KokoroLangPrefix, string> = {
  a: "en-us",
  b: "en-gb",
  e: "es",
  f: "fr-fr",
  h: "hi",
  i: "it",
  j: "ja",
  p: "pt-br",
  z: "cmn",
}

const TAG_TO_PREFIX: Record<string, KokoroLangPrefix> = {
  a: "a",
  "en-us": "a",
  en_us: "a",
  eng: "a",
  en: "a",
  english: "a",
  american: "a",
  b: "b",
  "en-gb": "b",
  en_gb: "b",
  "en-uk": "b",
  british: "b",
  e: "e",
  es: "e",
  spa: "e",
  spanish: "e",
  f: "f",
  fr: "f",
  "fr-fr": "f",
  fra: "f",
  fre: "f",
  french: "f",
  h: "h",
  hi: "h",
  hin: "h",
  hindi: "h",
  i: "i",
  it: "i",
  ita: "i",
  italian: "i",
  j: "j",
  ja: "j",
  jpn: "j",
  japanese: "j",
  p: "p",
  pt: "p",
  "pt-br": "p",
  por: "p",
  portuguese: "p",
  z: "z",
  zh: "z",
  cmn: "z",
  zho: "z",
  chi: "z",
  chinese: "z",
  mandarin: "z",
}

export function kokoroPrefixFromVoiceName(voiceName: string | undefined): KokoroLangPrefix | undefined {
  const prefix = voiceName?.trim().charAt(0).toLowerCase()
  if (!prefix) return undefined
  return prefix in PREFIX_TO_PHONEMIZER ? (prefix as KokoroLangPrefix) : undefined
}

/**
 * Map a project language tag (BCP-47, ISO 639, name, or Kokoro prefix) to
 * Kokoro's single-letter language code.
 */
export function inferKokoroLangPrefix(tag: string | undefined): KokoroLangPrefix | undefined {
  if (!tag) return undefined
  const normalized = tag.trim().toLowerCase()
  if (!normalized) return undefined
  if (normalized in TAG_TO_PREFIX) return TAG_TO_PREFIX[normalized]
  const head = normalized.split(/[-_]/, 1)[0]
  return TAG_TO_PREFIX[head]
}

export function phonemizerLanguageForPrefix(prefix: KokoroLangPrefix): string {
  return PREFIX_TO_PHONEMIZER[prefix]
}

export function defaultKokoroVoiceForLanguage(tag: string | undefined): string {
  const prefix = inferKokoroLangPrefix(tag)
  if (prefix === "b") return DEFAULT_KOKORO_BRITISH_VOICE
  return DEFAULT_KOKORO_VOICE
}

/** Voice ids the 82M browser model can actually synthesize. */
export function isBundledKokoroVoiceName(value: string | undefined): boolean {
  return Boolean(value && BUNDLED_VOICE_IDS.has(value.trim().toLowerCase()))
}

/** True when the project language is not one Kokoro's 82M model speaks. */
export function kokoroSpeaksEnglishOnlyFor(tag: string | undefined): boolean {
  const prefix = inferKokoroLangPrefix(tag)
  if (!prefix) return Boolean(tag?.trim())
  return prefix !== "a" && prefix !== "b"
}

/**
 * Bundled voices grouped by accent. The group matching `tag` is listed first
 * so a British project opens on British voices without hiding American ones.
 */
export function kokoroVoiceGroupsForLanguage(tag: string | undefined): KokoroVoiceGroup[] {
  const american = KOKORO_BUNDLED_VOICES.filter((v) => v.prefix === "a")
  const british = KOKORO_BUNDLED_VOICES.filter((v) => v.prefix === "b")
  if (inferKokoroLangPrefix(tag) === "b") {
    return [
      { prefix: "b", voices: british },
      { prefix: "a", voices: american },
    ]
  }
  return [
    { prefix: "a", voices: american },
    { prefix: "b", voices: british },
  ]
}

/**
 * Starting-point affix inventories a project admin can load into
 * ProjectWideSettings.termMatching. Data only — nothing at match time reads
 * this file. Lists are editable after loading; a preset is a suggestion.
 */

import type { MessageKey } from "@/lib/i18n/messages/en"

export interface AffixPreset {
  id: string
  labelKey: MessageKey
  prefixes: string[]
  suffixes: string[]
}

export const AFFIX_PRESETS: ReadonlyArray<AffixPreset> = [
  {
    id: "hebrew",
    labelKey: "projectSettings.termMatching.preset.hebrew",
    // Inseparable prefixes: conjunction, article, prepositions, relative.
    prefixes: ["ו", "ה", "ב", "כ", "ל", "מ", "ש"],
    // Plural/dual endings and pronominal suffixes.
    suffixes: ["ים", "ות", "יִם", "י", "ך", "ו", "ה", "נו", "כם", "כן", "הם", "הן"],
  },
  {
    id: "arabic",
    labelKey: "projectSettings.termMatching.preset.arabic",
    prefixes: ["و", "ف", "ب", "ك", "ل", "ال", "س"],
    suffixes: ["ات", "ون", "ين", "ة", "ي", "ك", "ه", "ها", "نا", "كم", "هم"],
  },
  {
    id: "swahili",
    labelKey: "projectSettings.termMatching.preset.swahili",
    prefixes: ["wa", "m", "mi", "ki", "vi", "ma", "ji", "u", "ku", "pa"],
    suffixes: ["ni", "ji"],
  },
  {
    id: "turkish",
    labelKey: "projectSettings.termMatching.preset.turkish",
    prefixes: [],
    suffixes: ["lar", "ler", "ı", "i", "u", "ü", "da", "de", "ta", "te", "dan", "den", "ın", "in", "un", "ün", "a", "e", "ya", "ye"],
  },
]

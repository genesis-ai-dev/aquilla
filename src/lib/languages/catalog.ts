/**
 * AQU-988 — bundled ISO 639-1 language catalog backing the select-or-type
 * language fields (see `@/components/LanguageComboboxInput`).
 *
 * Suggestions only. Language fields stay freeform: the product contract is
 * "any label works — a BCP-47 tag, a language name, or a register description
 * (e.g. 'Grade 7 English')". Picking an entry stores its `name` (the display
 * name), i.e. exactly the string a user would have typed by hand, so nothing
 * downstream (agent prompts, export, lane counting, editor badges) changes
 * shape. Codes are shown as a hint and are searchable, never stored.
 */

export type LanguageEntry = {
  /** ISO 639-1 two-letter code. Searchable; never the stored value. */
  code: string
  /** English display name — this is what gets stored when picked. */
  name: string
}

/** ISO 639-1, English display names, sorted by name. */
export const LANGUAGES: readonly LanguageEntry[] = [
  { code: "ab", name: "Abkhazian" },
  { code: "aa", name: "Afar" },
  { code: "af", name: "Afrikaans" },
  { code: "ak", name: "Akan" },
  { code: "tw", name: "Twi" },
  { code: "sq", name: "Albanian" },
  { code: "am", name: "Amharic" },
  { code: "ar", name: "Arabic" },
  { code: "an", name: "Aragonese" },
  { code: "hy", name: "Armenian" },
  { code: "as", name: "Assamese" },
  { code: "av", name: "Avaric" },
  { code: "ae", name: "Avestan" },
  { code: "ay", name: "Aymara" },
  { code: "az", name: "Azerbaijani" },
  { code: "bm", name: "Bambara" },
  { code: "bn", name: "Bangla" },
  { code: "ba", name: "Bashkir" },
  { code: "eu", name: "Basque" },
  { code: "be", name: "Belarusian" },
  { code: "bh", name: "Bhojpuri" },
  { code: "bi", name: "Bislama" },
  { code: "bs", name: "Bosnian" },
  { code: "br", name: "Breton" },
  { code: "bg", name: "Bulgarian" },
  { code: "my", name: "Burmese" },
  { code: "ca", name: "Catalan" },
  { code: "ch", name: "Chamorro" },
  { code: "ce", name: "Chechen" },
  { code: "zh", name: "Chinese" },
  { code: "cu", name: "Church Slavic" },
  { code: "cv", name: "Chuvash" },
  { code: "kw", name: "Cornish" },
  { code: "co", name: "Corsican" },
  { code: "cr", name: "Cree" },
  { code: "hr", name: "Croatian" },
  { code: "cs", name: "Czech" },
  { code: "da", name: "Danish" },
  { code: "dv", name: "Divehi" },
  { code: "nl", name: "Dutch" },
  { code: "dz", name: "Dzongkha" },
  { code: "en", name: "English" },
  { code: "eo", name: "Esperanto" },
  { code: "et", name: "Estonian" },
  { code: "ee", name: "Ewe" },
  { code: "fo", name: "Faroese" },
  { code: "fj", name: "Fijian" },
  { code: "tl", name: "Filipino" },
  { code: "fi", name: "Finnish" },
  { code: "fr", name: "French" },
  { code: "ff", name: "Fula" },
  { code: "gl", name: "Galician" },
  { code: "lg", name: "Ganda" },
  { code: "ka", name: "Georgian" },
  { code: "de", name: "German" },
  { code: "el", name: "Greek" },
  { code: "gn", name: "Guarani" },
  { code: "gu", name: "Gujarati" },
  { code: "ht", name: "Haitian Creole" },
  { code: "ha", name: "Hausa" },
  { code: "he", name: "Hebrew" },
  { code: "hz", name: "Herero" },
  { code: "hi", name: "Hindi" },
  { code: "ho", name: "Hiri Motu" },
  { code: "hu", name: "Hungarian" },
  { code: "is", name: "Icelandic" },
  { code: "io", name: "Ido" },
  { code: "ig", name: "Igbo" },
  { code: "id", name: "Indonesian" },
  { code: "ia", name: "Interlingua" },
  { code: "ie", name: "Interlingue" },
  { code: "iu", name: "Inuktitut" },
  { code: "ik", name: "Inupiaq" },
  { code: "ga", name: "Irish" },
  { code: "it", name: "Italian" },
  { code: "ja", name: "Japanese" },
  { code: "jv", name: "Javanese" },
  { code: "kl", name: "Kalaallisut" },
  { code: "kn", name: "Kannada" },
  { code: "kr", name: "Kanuri" },
  { code: "ks", name: "Kashmiri" },
  { code: "kk", name: "Kazakh" },
  { code: "km", name: "Khmer" },
  { code: "ki", name: "Kikuyu" },
  { code: "rw", name: "Kinyarwanda" },
  { code: "kv", name: "Komi" },
  { code: "kg", name: "Kongo" },
  { code: "ko", name: "Korean" },
  { code: "kj", name: "Kuanyama" },
  { code: "ku", name: "Kurdish" },
  { code: "ky", name: "Kyrgyz" },
  { code: "lo", name: "Lao" },
  { code: "la", name: "Latin" },
  { code: "lv", name: "Latvian" },
  { code: "li", name: "Limburgish" },
  { code: "ln", name: "Lingala" },
  { code: "lt", name: "Lithuanian" },
  { code: "lu", name: "Luba-Katanga" },
  { code: "lb", name: "Luxembourgish" },
  { code: "mk", name: "Macedonian" },
  { code: "mg", name: "Malagasy" },
  { code: "ms", name: "Malay" },
  { code: "ml", name: "Malayalam" },
  { code: "mt", name: "Maltese" },
  { code: "gv", name: "Manx" },
  { code: "mi", name: "Māori" },
  { code: "mr", name: "Marathi" },
  { code: "mh", name: "Marshallese" },
  { code: "mn", name: "Mongolian" },
  { code: "na", name: "Nauru" },
  { code: "nv", name: "Navajo" },
  { code: "ng", name: "Ndonga" },
  { code: "ne", name: "Nepali" },
  { code: "nd", name: "North Ndebele" },
  { code: "se", name: "Northern Sami" },
  { code: "no", name: "Norwegian" },
  { code: "nb", name: "Norwegian Bokmål" },
  { code: "nn", name: "Norwegian Nynorsk" },
  { code: "ny", name: "Nyanja" },
  { code: "oc", name: "Occitan" },
  { code: "or", name: "Odia" },
  { code: "oj", name: "Ojibwa" },
  { code: "om", name: "Oromo" },
  { code: "os", name: "Ossetic" },
  { code: "pi", name: "Pali" },
  { code: "ps", name: "Pashto" },
  { code: "fa", name: "Persian" },
  { code: "pl", name: "Polish" },
  { code: "pt", name: "Portuguese" },
  { code: "pa", name: "Punjabi" },
  { code: "qu", name: "Quechua" },
  { code: "ro", name: "Romanian" },
  { code: "rm", name: "Romansh" },
  { code: "rn", name: "Rundi" },
  { code: "ru", name: "Russian" },
  { code: "sm", name: "Samoan" },
  { code: "sg", name: "Sango" },
  { code: "sa", name: "Sanskrit" },
  { code: "sc", name: "Sardinian" },
  { code: "gd", name: "Scottish Gaelic" },
  { code: "sr", name: "Serbian" },
  { code: "sn", name: "Shona" },
  { code: "ii", name: "Sichuan Yi" },
  { code: "sd", name: "Sindhi" },
  { code: "si", name: "Sinhala" },
  { code: "sk", name: "Slovak" },
  { code: "sl", name: "Slovenian" },
  { code: "so", name: "Somali" },
  { code: "nr", name: "South Ndebele" },
  { code: "st", name: "Southern Sotho" },
  { code: "es", name: "Spanish" },
  { code: "su", name: "Sundanese" },
  { code: "sw", name: "Swahili" },
  { code: "ss", name: "Swati" },
  { code: "sv", name: "Swedish" },
  { code: "ty", name: "Tahitian" },
  { code: "tg", name: "Tajik" },
  { code: "ta", name: "Tamil" },
  { code: "tt", name: "Tatar" },
  { code: "te", name: "Telugu" },
  { code: "th", name: "Thai" },
  { code: "bo", name: "Tibetan" },
  { code: "ti", name: "Tigrinya" },
  { code: "to", name: "Tongan" },
  { code: "ts", name: "Tsonga" },
  { code: "tn", name: "Tswana" },
  { code: "tr", name: "Turkish" },
  { code: "tk", name: "Turkmen" },
  { code: "uk", name: "Ukrainian" },
  { code: "ur", name: "Urdu" },
  { code: "ug", name: "Uyghur" },
  { code: "uz", name: "Uzbek" },
  { code: "ve", name: "Venda" },
  { code: "vi", name: "Vietnamese" },
  { code: "vo", name: "Volapük" },
  { code: "wa", name: "Walloon" },
  { code: "cy", name: "Welsh" },
  { code: "fy", name: "Western Frisian" },
  { code: "wo", name: "Wolof" },
  { code: "xh", name: "Xhosa" },
  { code: "yi", name: "Yiddish" },
  { code: "yo", name: "Yoruba" },
  { code: "za", name: "Zhuang" },
  { code: "zu", name: "Zulu" },
]

/** Default cap on rendered suggestions — enough to scroll, cheap to render. */
export const LANGUAGE_SUGGESTION_LIMIT = 50

/**
 * Fold case and diacritics so "espanol" matches "Español" and "FRE" matches
 * "French". `NFD` + combining-mark strip is enough for the Latin-script
 * display names in the catalog.
 */
function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
}

/**
 * Rank a catalog entry against a folded query. Lower is better; `null` means
 * "no match". Exact code beats name prefix beats code prefix beats substring,
 * so typing "fr" puts French on top and "fre" still surfaces it.
 */
function rank(entry: LanguageEntry, query: string): number | null {
  const name = fold(entry.name)
  const code = fold(entry.code)
  if (code === query) return 0
  if (name === query) return 1
  if (name.startsWith(query)) return 2
  if (code.startsWith(query)) return 3
  if (name.includes(query)) return 4
  return null
}

/**
 * True when `query` is already exactly the one language left to suggest —
 * i.e. the field is settled and a dropdown would only offer back what the user
 * has already got. Callers hide the list in that state, which also keeps the
 * popup from covering whatever sits below a fully-filled field.
 */
export function isSettledLanguage(
  query: string,
  matches: readonly LanguageEntry[],
): boolean {
  if (matches.length !== 1) return false
  return fold(matches[0].name) === fold(query.trim())
}

/**
 * Filter the catalog by display name or code. An empty query returns the head
 * of the full list (the plain "dropdown" case).
 *
 * `exclude` drops entries already chosen (case-insensitively) so a chips field
 * never suggests a language that is already a chip.
 */
export function filterLanguages(
  query: string,
  options: { limit?: number; exclude?: readonly string[] } = {},
): LanguageEntry[] {
  const { limit = LANGUAGE_SUGGESTION_LIMIT, exclude } = options
  const excluded = exclude?.length
    ? new Set(exclude.map((value) => fold(value.trim())))
    : null
  const allowed = excluded
    ? LANGUAGES.filter((entry) => !excluded.has(fold(entry.name)))
    : LANGUAGES

  const folded = fold(query.trim())
  if (!folded) return allowed.slice(0, limit)

  const scored: Array<{ entry: LanguageEntry; score: number }> = []
  for (const entry of allowed) {
    const score = rank(entry, folded)
    if (score !== null) scored.push({ entry, score })
  }
  // Stable within a rank: the catalog is already name-sorted.
  scored.sort((a, b) => a.score - b.score)
  return scored.slice(0, limit).map((item) => item.entry)
}

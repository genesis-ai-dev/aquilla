/**
 * AQU-988 — bundled ISO 639-1 language catalog backing the select-or-type
 * language fields (see `@/components/LanguageComboboxInput`).
 *
 * AQU-1456 — this bundled set is now only the *head start*: the pickers load
 * the full SIL ISO 639-3 catalog (~7,900 languages, `./full-catalog`) on first
 * focus/keystroke and filter that instead, so low-resource languages are
 * suggested too. The ranking and settled-state helpers below are shared by
 * both catalogs, so pass the loaded one in via `filterLanguages`'s `catalog`
 * option. Keep `LANGUAGES` as-is in shape: `src/lib/audio/inworld-languages.ts`
 * reads its two-letter `code` synchronously to map lanes onto Inworld tags.
 *
 * Suggestions only. Language fields stay freeform: the product contract is
 * a language name or a register description (e.g. 'Grade 7 English'). Picking
 * an entry stores its `name`, i.e. exactly the string a user would have typed
 * by hand, so nothing downstream (agent prompts, export, lane counting,
 * editor badges) changes shape. Codes are searchable so a typed tag still
 * finds the name, and they are never stored and never shown in the list
 * (AQU-1792). The code is derived from the stored name and can be overridden.
 */

export type LanguageEntry = {
  /**
   * Primary code — ISO 639-1 in `LANGUAGES`, ISO 639-3 in the full catalog.
   * Shown next to the name as a hint, searchable, never the stored value.
   */
  code: string
  /** English display name — this is what gets stored when picked. */
  name: string
  /**
   * AQU-1456 — a second searchable code for the same language, so a 639-3
   * entry still answers to its two-letter form ("fr" and "fra" both find
   * French). Not displayed.
   */
  altCode?: string
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

/**
 * AQU-1792 — script and region varieties ISO 639 does not name on its own.
 * The picker suggests the name ("Traditional Han"), never the tag ("zh-Hant").
 * `codeForLanguageLabel` derives the tag from that name; the advanced code
 * field is where a wrong derivation gets corrected.
 */
export const NAMED_VARIETY_LANGUAGES: readonly LanguageEntry[] = [
  { code: "zh-Hans", name: "Simplified Han" },
  { code: "zh-Hant", name: "Traditional Han" },
  { code: "es-419", name: "Latin American Spanish" },
  { code: "fr-CA", name: "Canadian French" },
]

/** Default cap on rendered suggestions — enough to scroll, cheap to render. */
export const LANGUAGE_SUGGESTION_LIMIT = 50

/** Append named varieties the bundled or full catalog does not already carry. */
function catalogWithNamedVarieties(
  catalog: readonly LanguageEntry[],
): readonly LanguageEntry[] {
  const codes = new Set(catalog.map((entry) => fold(entry.code)))
  const extra = NAMED_VARIETY_LANGUAGES.filter((entry) => !codes.has(fold(entry.code)))
  return extra.length === 0 ? catalog : [...catalog, ...extra]
}

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

/** Display name for a known code, so a seeded tag can be shown as a name. */
export function nameForLanguageCode(code: string): string | null {
  const folded = fold(code.trim())
  if (!folded) return null
  return (
    NAMED_VARIETY_LANGUAGES.find((entry) => fold(entry.code) === folded)?.name ??
    LANGUAGES.find((entry) => fold(entry.code) === folded)?.name ??
    null
  )
}

/**
 * Word boundaries, for the ranking below: anything that is not a letter or a
 * digit separates words in a folded display name — spaces, but also the
 * punctuation SIL's reference names carry ("Luba-Katanga", "Hawai'i Creole
 * English", "Old English (ca. 450-1100)", "Biblical Hebrew/Aramaic/Greek").
 * `undefined` (past the end of the name) counts as a boundary.
 */
function isBoundary(char: string | undefined): boolean {
  return char === undefined || !/[a-z0-9]/.test(char)
}

/** Rank tiers, lower is better. See `rank`. */
const RANK_EXACT_CODE = 0
const RANK_EXACT_NAME = 1
const RANK_WHOLE_WORD = 2
const RANK_WORD_START = 3
const RANK_CODE_PREFIX = 4
const RANK_SUBSTRING = 5

/**
 * AQU-1457 — where in a folded name the query lands. A query that fills a
 * whole word ("malay" in "Standard Malay") outranks one that only starts a
 * word ("mala" in "Malayalam"), which in turn outranks a mid-word hit ("ala"
 * in "Malayalam"); `wordIndex` says which word matched, so a name that *leads*
 * with the query beats one that mentions it later.
 *
 * Multi-word queries fall out of the same rule, since the scan only tries
 * word starts: "eastern arr" starts word 0 of "Eastern Arrernte".
 */
function matchName(name: string, query: string): { tier: number; wordIndex: number } | null {
  let best: { tier: number; wordIndex: number } | null = null
  let wordIndex = 0
  for (let i = 0; i < name.length; i++) {
    if (isBoundary(name[i]) || !isBoundary(name[i - 1])) continue
    if (name.startsWith(query, i)) {
      const tier = isBoundary(name[i + query.length]) ? RANK_WHOLE_WORD : RANK_WORD_START
      if (!best || tier < best.tier) best = { tier, wordIndex }
      // Word 0 with a whole-word hit is the best this name can do.
      if (best.tier === RANK_WHOLE_WORD) break
    }
    wordIndex++
  }
  return best
}

/**
 * Rank a catalog entry against a folded query. Lower is better; `null` means
 * "no match". Exact code beats exact name beats a whole-word hit beats a
 * word-start hit beats a code prefix beats a mid-word substring, so typing
 * "fr" puts French on top, "fre" still surfaces it, and "arrernte" puts
 * "Eastern Arrernte" above a name that merely contains those letters.
 *
 * `wordIndex` orders entries inside a tier (see `filterLanguages`).
 */
function rank(
  entry: LanguageEntry,
  query: string,
): { tier: number; wordIndex: number } | null {
  const name = fold(entry.name)
  const code = fold(entry.code)
  const altCode = entry.altCode ? fold(entry.altCode) : null
  if (code === query || altCode === query) return { tier: RANK_EXACT_CODE, wordIndex: 0 }
  if (name === query) return { tier: RANK_EXACT_NAME, wordIndex: 0 }
  const inName = matchName(name, query)
  if (inName) return inName
  if (code.startsWith(query) || altCode?.startsWith(query)) {
    return { tier: RANK_CODE_PREFIX, wordIndex: 0 }
  }
  if (name.includes(query)) return { tier: RANK_SUBSTRING, wordIndex: 0 }
  return null
}

/**
 * AQU-1457 — 0 for SIL's standardized form of the matched language, 1
 * otherwise. SIL names the standard variety of a macrolanguage "Standard
 * <language>" ("Standard Malay" under `msa`, "Standard Arabic" under `ara`),
 * and that variety is what a translator typing the bare language name almost
 * always wants — so it sorts ahead of the geographic and ethnic varieties that
 * qualify the same word ("Pattani Malay", "Kedah Malay"), which no
 * name-derived measure such as length would do.
 */
function standardFormFirst(entry: LanguageEntry, wordIndex: number): number {
  return wordIndex === 1 && fold(entry.name).startsWith("standard ") ? 0 : 1
}

/** 0 for a language with an ISO 639-1 code, 1 otherwise. See `filterLanguages`. */
function majorFirst(entry: LanguageEntry): number {
  return entry.altCode ? 0 : 1
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
 * of the catalog (the plain "dropdown" case).
 *
 * `exclude` drops entries already chosen (case-insensitively) so a chips field
 * never suggests a language that is already a chip.
 */
export function filterLanguages(
  query: string,
  options: {
    limit?: number
    exclude?: readonly string[]
    /**
     * AQU-1456 — catalog to search. Defaults to the bundled ISO 639-1 set;
     * the pickers pass the lazily loaded ISO 639-3 catalog once it resolves.
     */
    catalog?: readonly LanguageEntry[]
  } = {},
): LanguageEntry[] {
  const { limit = LANGUAGE_SUGGESTION_LIMIT, exclude, catalog = LANGUAGES } = options
  const source = catalogWithNamedVarieties(catalog)
  const excluded = exclude?.length
    ? new Set(exclude.map((value) => fold(value.trim())))
    : null
  const allowed = excluded
    ? source.filter((entry) => !excluded.has(fold(entry.name)))
    : source

  const folded = fold(query.trim())
  if (!folded) return allowed.slice(0, limit)

  const scored: Array<{
    entry: LanguageEntry
    tier: number
    wordIndex: number
    standard: number
  }> = []
  for (const entry of allowed) {
    const score = rank(entry, folded)
    if (score === null) continue
    // Folded once here rather than inside the comparator below, which runs
    // O(n log n) times over a 7,900-entry catalog.
    scored.push({ entry, ...score, standard: standardFormFirst(entry, score.wordIndex) })
  }
  // Tiebreaks inside a tier, in order:
  //  * the earlier word of the name matched — a name that leads with the query
  //    is more likely to be the language meant than one that qualifies it;
  //  * AQU-1457 — SIL's "Standard <language>" variety (see `standardFormFirst`);
  //  * AQU-1456 — a language that also carries an ISO 639-1 code comes first.
  //    Without this, widening the catalog from ~184 to ~7,900 buries the majors
  //    behind alphabetically-earlier obscure codes ("ger" surfacing "Geragew"
  //    ahead of "German");
  //  * AQU-1457 — the shorter name, so the plain language beats its dialects
  //    and historic stages ("Malay (macrolanguage)" ahead of "Malayic Dayak").
  // Stable beyond that: the catalog is already name-sorted.
  scored.sort(
    (a, b) =>
      a.tier - b.tier ||
      a.wordIndex - b.wordIndex ||
      a.standard - b.standard ||
      majorFirst(a.entry) - majorFirst(b.entry) ||
      a.entry.name.length - b.entry.name.length,
  )
  return scored.slice(0, limit).map((item) => item.entry)
}

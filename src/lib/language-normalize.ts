/**
 * Minimal language tag normalizer for comparing project source/target language
 * values that may arrive as ISO 639-1 (2-letter), ISO 639-2 (3-letter), or
 * English names (e.g. "French" vs "fra" should NOT trigger a "needs direction"
 * prompt when they refer to the same language).
 *
 * Purposefully limited scope — exact match after normalization; no fuzzy
 * matching. Covers only the common cases seen in Paratext/eBible imports.
 *
 * AQU-249 — used in ImportDialog.handleChildImported and ProjectWorkspace.handleImported.
 */

/** English name (lowercase) → ISO 639-2/T or 639-1 two-letter code. */
const ENGLISH_TO_CODE: Record<string, string> = {
  english: "eng",
  french: "fra",
  spanish: "spa",
  german: "deu",
  portuguese: "por",
  russian: "rus",
  arabic: "ara",
  chinese: "zho",
  japanese: "jpn",
  korean: "kor",
  italian: "ita",
  dutch: "nld",
  polish: "pol",
  turkish: "tur",
  swedish: "swe",
  indonesian: "ind",
  hebrew: "heb",
  ukrainian: "ukr",
  greek: "ell",
  malay: "msa",
  czech: "ces",
  romanian: "ron",
  danish: "dan",
  hungarian: "hun",
  tamil: "tam",
  norwegian: "nor",
  thai: "tha",
  urdu: "urd",
  croatian: "hrv",
  bulgarian: "bul",
  lithuanian: "lit",
  latin: "lat",
  swahili: "swa",
  afrikaans: "afr",
  hindi: "hin",
  vietnamese: "vie",
  finnish: "fin",
}

/** ISO 639-2 → ISO 639-2 canonical form (handles /B aliases). */
const ISO2_ALIAS: Record<string, string> = {
  fre: "fra",
  ger: "deu",
  chi: "zho",
  dut: "nld",
  cze: "ces",
  rum: "ron",
  mac: "mkd",
  alb: "sqi",
  bur: "mya",
  tib: "bod",
  gre: "ell",
  may: "msa",
  ice: "isl",
  arm: "hye",
  baq: "eus",
  geo: "kat",
  wel: "cym",
  slo: "slk",
  per: "fas",
}

/** ISO 639-1 (2-letter) → ISO 639-2/T */
const TWO_TO_THREE: Record<string, string> = {
  en: "eng",
  fr: "fra",
  es: "spa",
  de: "deu",
  pt: "por",
  ru: "rus",
  ar: "ara",
  zh: "zho",
  ja: "jpn",
  ko: "kor",
  it: "ita",
  nl: "nld",
  pl: "pol",
  tr: "tur",
  sv: "swe",
  id: "ind",
  he: "heb",
  uk: "ukr",
  el: "ell",
  ms: "msa",
  cs: "ces",
  ro: "ron",
  da: "dan",
  hu: "hun",
  ta: "tam",
  no: "nor",
  th: "tha",
  ur: "urd",
  hr: "hrv",
  bg: "bul",
  lt: "lit",
  la: "lat",
  sw: "swa",
  af: "afr",
  hi: "hin",
  vi: "vie",
  fi: "fin",
}

/**
 * Normalize a language tag or English name to a canonical lowercase form so
 * that "French", "fra", "fre", and "fr" all compare equal.
 *
 * Returns the input lowercased and trimmed if no mapping is found — this
 * ensures unknown codes still compare by identity and that two identical
 * unknown values are treated as equal.
 */
export function normalizeLanguageTag(tag: string | undefined | null): string {
  if (!tag) return ""
  const s = tag.trim().toLowerCase()
  if (!s) return ""

  // Strip BCP-47 region suffix ("en-US" → "en").
  const head = s.split(/[-_]/)[0]

  // English name?
  const fromName = ENGLISH_TO_CODE[head]
  if (fromName) return fromName

  // ISO 639-2 alias?
  const dealiased = ISO2_ALIAS[head]
  if (dealiased) return dealiased

  // ISO 639-1 two-letter → three-letter?
  if (head.length === 2) {
    const expanded = TWO_TO_THREE[head]
    if (expanded) return expanded
    // Unknown two-letter code — return as-is.
    return head
  }

  // Already canonical (3-letter or longer unknown code).
  return head
}

/**
 * Return true when two language tags refer to the same language after
 * normalization. Two empty strings are considered equal (both unset).
 */
export function languagesEqual(a: string | undefined | null, b: string | undefined | null): boolean {
  return normalizeLanguageTag(a) === normalizeLanguageTag(b)
}

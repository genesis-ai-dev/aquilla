/**
 * AQU-1597: the ONE answer to "are these the same language?". The SPA
 * (`@/lib/language-normalize`), auth-worker and sync-worker all import from
 * here so a project, a lane, an import header and a billing count never
 * disagree about whether "Spanish", "spanish" and "es" are one language.
 *
 * Matching is case-insensitive, which is how the old single target-language
 * field behaved (Luke, 2026-10-01). Values may arrive as ISO 639-1 (2-letter),
 * ISO 639-2 (3-letter), or English names. Purposefully limited scope — exact
 * match after normalization; no fuzzy matching. Covers the common cases seen
 * in Paratext/eBible imports.
 *
 * NOT for "same lane?" — lanes are compared by lane id, and the replay lookup
 * on `legacy_tag` stays byte-exact (it is a frozen event key, not a language).
 * Where a lane is still addressed by its tag, use `matchLanguageTag` and write
 * the tag it returns, never the caller's spelling.
 *
 * AQU-249 — originally `src/lib/language-normalize.ts`.
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

/**
 * Every surface form that `languagesEqual` treats as the same language:
 * the original tag, its canonical code, the English name, the 2-letter code,
 * and ISO 639-2 aliases. SQL `IN` lists use this so a grant of `es` matches a
 * lane named Spanish. Unknown tags come back as themselves, lowercased.
 * An empty tag is only itself — it is the default lane, not a language.
 */
export function languageSurfaceForms(tag: string): string[] {
  const raw = tag.trim()
  if (!raw) return [""]
  const forms = new Set<string>()
  forms.add(raw.toLowerCase())
  const canonical = normalizeLanguageTag(raw)
  if (canonical) forms.add(canonical)
  for (const [name, code] of Object.entries(ENGLISH_TO_CODE)) {
    if (code === canonical) forms.add(name)
  }
  for (const [two, code] of Object.entries(TWO_TO_THREE)) {
    if (code === canonical) forms.add(two)
  }
  for (const [alias, code] of Object.entries(ISO2_ALIAS)) {
    if (code === canonical) forms.add(alias)
  }
  return [...forms]
}

/** Subtags after the language: "fr-CA" → "ca"; a bare name or code has none. */
function subtags(tag: string): string {
  return tag.trim().toLowerCase().split(/[-_]/).slice(1).join("-")
}

/**
 * The canonical key for a LANE TAG: the canonical language plus the region it
 * carries, so "Spanish", "spanish" and "es" share a key while "fr-CA" keeps
 * its own. Two tags name the same lane language exactly when their keys match.
 *
 * `normalizeLanguageTag` alone is not enough here: it strips the region, so
 * "fr-CA" and "French" both normalize to "fra". A regional lane beside the
 * base language is a real second lane and must not collapse into it
 * (AQU-1473). An empty tag keys to "" — the default lane, not a language.
 */
export function languageTagKey(tag: string | null | undefined): string {
  const canonical = normalizeLanguageTag(tag)
  if (!canonical) return ""
  const region = subtags(tag ?? "")
  return region ? `${canonical}-${region}` : canonical
}

/** True when two LANE TAGS name the same language, region included. */
export function sameLanguageTag(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const key = languageTagKey(a)
  return key !== "" && key === languageTagKey(b)
}

/**
 * The entry of `candidates` naming the same language as `tag`, or `undefined`
 * when none does. An exact match always wins, so an already-stored spelling
 * resolves to itself.
 *
 * A caller that goes on to WRITE a lane tag must write the returned candidate
 * rather than its own spelling — writing "fra" where the project registered
 * "French" would silently open a second lane.
 *
 * An empty tag is the default lane, not a language, so it only ever matches
 * an empty candidate.
 */
export function matchLanguageTag(
  tag: string | null | undefined,
  candidates: Iterable<string>,
): string | undefined {
  const raw = (tag ?? "").trim()
  const list = [...candidates]
  const exact = list.find((candidate) => candidate.trim() === raw)
  if (exact !== undefined) return exact
  if (!raw) return undefined
  return list.find((candidate) => candidate.trim().length > 0 && sameLanguageTag(candidate, raw))
}

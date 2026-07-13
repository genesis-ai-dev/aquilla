export type TextDirection = "ltr" | "rtl"
export type DirectionMode = "auto" | TextDirection
export type TextDirectionSummary = TextDirection | "mixed"

const RTL_LANGUAGE_CODES = new Set([
  "ar", "ara", "arb", "arz",
  "arc", "aii", "syr", "syc",
  "dv", "div",
  "fa", "fas", "per", "prs",
  "he", "heb", "iw",
  "khw",
  "ks", "kas",
  "ku", "kur", "ckb",
  "nqo",
  "ps", "pus", "pbt",
  "sd", "snd",
  "ug", "uig",
  "ur", "urd",
  "yi", "yid",
])

const RTL_LANGUAGE_NAMES = new Set([
  "arabic",
  "aramaic",
  "assyrian",
  "dhivehi",
  "divehi",
  "farsi",
  "hebrew",
  "kashmiri",
  "kurdish",
  "nko",
  "n'ko",
  "pashto",
  "persian",
  "sindhi",
  "syriac",
  "urdu",
  "uyghur",
  "uighur",
  "yiddish",
])

/** Strong RTL Unicode ranges: Hebrew, Arabic, Syriac, Thaana, NKo,
 * Samaritan, Arabic Extended, Arabic Presentation Forms. */
const RTL_CHAR_RE =
  /[\u0590-\u05ff\u0600-\u06ff\u0700-\u074f\u0750-\u077f\u0780-\u07bf\u07c0-\u07ff\u0800-\u083f\u0840-\u085f\u0860-\u086f\u0870-\u089f\u08a0-\u08ff\ufb1d-\ufdff\ufe70-\ufeff]/

/** Strong LTR ranges we expect in project text: Latin, IPA, Greek, Cyrillic,
 * Armenian, Georgian, Ethiopic, Cherokee, Canadian syllabics, Hangul, CJK. */
const LTR_CHAR_RE =
  /[A-Za-z\u00c0-\u02af\u0370-\u052f\u0530-\u058f\u10a0-\u10ff\u1200-\u137f\u13a0-\u13ff\u1400-\u167f\u1100-\u11ff\u2e80-\u9fff\uac00-\ud7af]/

function decodeBasicEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/gi, "&")
}

export function normalizeLanguageToken(language: string | undefined | null): string {
  return (language ?? "")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-")
}

export function languageDefaultDirection(language: string | undefined | null): TextDirection {
  const normalized = normalizeLanguageToken(language)
  if (!normalized) return "ltr"
  const code = normalized.split(/[-:\s]/)[0]
  if (RTL_LANGUAGE_CODES.has(code)) return "rtl"
  if (RTL_LANGUAGE_NAMES.has(normalized)) return "rtl"
  if (normalized.split(/\s+/).some((part) => RTL_LANGUAGE_NAMES.has(part))) return "rtl"
  return "ltr"
}

export function stripDirectionMarkup(value: string | undefined | null): string {
  if (!value) return ""
  return decodeBasicEntities(value)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\\f[\s\S]*?\\f\*/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

export function detectStrongTextDirection(value: string | undefined | null): TextDirection | null {
  const text = stripDirectionMarkup(value)
  for (const char of text) {
    if (RTL_CHAR_RE.test(char)) return "rtl"
    if (LTR_CHAR_RE.test(char)) return "ltr"
  }
  return null
}

export function summarizeTextDirections(values: Iterable<string | undefined | null>): TextDirectionSummary | null {
  let hasLtr = false
  let hasRtl = false
  for (const value of values) {
    const direction = detectStrongTextDirection(value)
    if (direction === "ltr") hasLtr = true
    if (direction === "rtl") hasRtl = true
    if (hasLtr && hasRtl) return "mixed"
  }
  if (hasRtl) return "rtl"
  if (hasLtr) return "ltr"
  return null
}

export function resolveTextDirection(
  mode: DirectionMode,
  text: string | undefined | null,
  fallback: TextDirection,
): TextDirection {
  if (mode === "ltr" || mode === "rtl") return mode
  return detectStrongTextDirection(text) ?? fallback
}

export function resolveDefaultDirection(mode: DirectionMode, fallback: TextDirection): TextDirection {
  return mode === "auto" ? fallback : mode
}

// DCS catalog language-seed normalization (DCS-UIQA DEFECT 2).
//
// DCS's catalog matches on short ISO codes ("en", "es-419", "hbo"), NOT English
// display names — searching `?lang=English` returns zero rows. Projects store
// the source language as whatever the user typed, often a display name, so the
// seed must be normalized to a code before it becomes the initial `lang` filter.
//
// `normalizeLanguageTag` folds display names + 2-letter codes to a 639-2/T
// 3-letter code (e.g. "English"/"en" → "eng"); DCS wants the 2-letter GL code,
// so we reverse that back to 2-letter where we can. Codes carrying a region
// subtag (e.g. "es-419") or already-short/unknown codes DCS uses verbatim pass
// through unchanged. A display name we can't map defaults to "" (empty filter)
// rather than leaking a name that would return no results.

import { normalizeLanguageTag } from "@/lib/language-normalize"

/** ISO 639-2/T (3-letter) → the 2-letter Gateway-Language code DCS keys on. */
const THREE_TO_TWO: Record<string, string> = {
  eng: "en", fra: "fr", spa: "es", deu: "de", por: "pt", rus: "ru", ara: "ar",
  zho: "zh", jpn: "ja", kor: "ko", ita: "it", nld: "nl", pol: "pl", tur: "tr",
  swe: "sv", ind: "id", heb: "he", ukr: "uk", ell: "el", msa: "ms", ces: "cs",
  ron: "ro", dan: "da", hun: "hu", tam: "ta", nor: "no", tha: "th", urd: "ur",
  hrv: "hr", bul: "bg", lit: "lt", lat: "la", swa: "sw", afr: "af", hin: "hi",
  vie: "vi", fin: "fi",
}

/** Turn a project's source-language value into a DCS catalog `lang` seed: a
 *  short ISO code, or "" if it's an unmappable display name. Never a name. */
export function toDcsLangSeed(raw: string | undefined | null): string {
  const s = (raw ?? "").trim()
  if (!s) return ""
  // Already a code (short, or has a region subtag DCS keys on) — DCS uses it
  // verbatim; passing a display name is the ONLY thing we must never do.
  const looksLikeName = /^[a-z]{4,}$/i.test(s) // one all-letter word, 4+ chars
  if (!looksLikeName) return s.toLowerCase()
  // A word — normalize it. If it resolves to a known language, map to the
  // 2-letter code DCS expects; otherwise (unknown word) drop it to "".
  const three = normalizeLanguageTag(s)
  return THREE_TO_TWO[three] ?? ""
}

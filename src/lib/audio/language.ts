// Map a project's language tag (ISO 639-1, 639-2, or BCP-47) to the
// 2-letter code Whisper expects, or `undefined` if the language isn't in
// Whisper's supported set so the model falls back to auto-detection rather
// than throwing on an unknown tag.
//
// Codex translation projects often target low-resource languages that
// aren't in Whisper's training set. Returning `undefined` for those keeps
// transcription functional (with degraded quality) instead of crashing.

// Whisper's full supported language set (transformers.js whisper-base).
// Source: tokenizer.add_prefix_tokens — kept inline here so we don't need
// a build-time scrape from the model.
const WHISPER_TWO_LETTER = new Set<string>([
  "en", "zh", "de", "es", "ru", "ko", "fr", "ja", "pt", "tr", "pl", "ca",
  "nl", "ar", "sv", "it", "id", "hi", "fi", "vi", "he", "uk", "el", "ms",
  "cs", "ro", "da", "hu", "ta", "no", "th", "ur", "hr", "bg", "lt", "la",
  "mi", "ml", "cy", "sk", "te", "fa", "lv", "bn", "sr", "az", "sl", "kn",
  "et", "mk", "br", "eu", "is", "hy", "ne", "mn", "bs", "kk", "sq", "sw",
  "gl", "mr", "pa", "si", "km", "sn", "yo", "so", "af", "oc", "ka", "be",
  "tg", "sd", "gu", "am", "yi", "lo", "uz", "fo", "ht", "ps", "tk", "nn",
  "mt", "sa", "lb", "my", "bo", "tl", "mg", "as", "tt", "ln", "ha", "ba",
  "jw", "su",
])

// 3-letter (ISO 639-2/T or 639-2/B) → Whisper 2-letter. Only includes
// languages Whisper actually supports; other 3-letter codes fall through.
const THREE_TO_TWO: Record<string, string> = {
  eng: "en", spa: "es", fra: "fr", fre: "fr", deu: "de", ger: "de",
  por: "pt", jpn: "ja", zho: "zh", chi: "zh", hin: "hi", ara: "ar",
  rus: "ru", kor: "ko", ita: "it", nld: "nl", dut: "nl", pol: "pl",
  tur: "tr", swe: "sv", ind: "id", heb: "he", ukr: "uk", ell: "el",
  gre: "el", msa: "ms", may: "ms", ces: "cs", cze: "cs", ron: "ro",
  rum: "ro", dan: "da", hun: "hu", tam: "ta", nor: "no", tha: "th",
  urd: "ur", hrv: "hr", bul: "bg", lit: "lt", lat: "la", mri: "mi",
  mal: "ml", cym: "cy", wel: "cy", slk: "sk", slo: "sk", tel: "te",
  fas: "fa", per: "fa", lav: "lv", ben: "bn", srp: "sr", aze: "az",
  slv: "sl", kan: "kn", est: "et", mkd: "mk", mac: "mk", bre: "br",
  eus: "eu", baq: "eu", isl: "is", ice: "is", hye: "hy", arm: "hy",
  nep: "ne", mon: "mn", bos: "bs", kaz: "kk", sqi: "sq", alb: "sq",
  swa: "sw", glg: "gl", mar: "mr", pan: "pa", sin: "si", khm: "km",
  sna: "sn", yor: "yo", som: "so", afr: "af", oci: "oc", kat: "ka",
  geo: "ka", bel: "be", tgk: "tg", snd: "sd", guj: "gu", amh: "am",
  yid: "yi", lao: "lo", uzb: "uz", fao: "fo", hat: "ht", pus: "ps",
  pus_x: "ps", tuk: "tk", nno: "nn", mlt: "mt", san: "sa", ltz: "lb",
  mya: "my", bur: "my", bod: "bo", tib: "bo", tgl: "tl", mlg: "mg",
  asm: "as", tat: "tt", lin: "ln", hau: "ha", bak: "ba", jav: "jw",
  sun: "su",
}

/**
 * Normalize a project language tag to the 2-letter code Whisper expects.
 * Returns undefined for languages outside Whisper's supported set so the
 * caller can let the model auto-detect rather than crash.
 */
export function whisperLanguageFromTag(tag: string | undefined | null): string | undefined {
  if (!tag) return undefined
  const norm = tag.trim().toLowerCase()
  if (!norm) return undefined

  // BCP-47 / region-tagged: split on hyphen or underscore. "en-US" → "en".
  const head = norm.split(/[-_]/, 1)[0]

  if (head.length === 2) {
    return WHISPER_TWO_LETTER.has(head) ? head : undefined
  }
  if (head.length === 3) {
    const mapped = THREE_TO_TWO[head]
    return mapped && WHISPER_TWO_LETTER.has(mapped) ? mapped : undefined
  }
  return undefined
}

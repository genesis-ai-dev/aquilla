// Paratext project metadata extraction.
//
// A Paratext project is a folder (or zip of one) containing Settings.xml,
// BookNames.xml, USFM/SFM book files, and a pile of feature data (term
// renderings, notes, progress, …). We don't reimplement Paratext, but we DO
// lift the settings a translation consultant expects to "come with" their
// project so it feels like home in Aquilla:
//
//   - localized book names      (BookNames.xml → nice File names per book)
//   - language + ISO code        (Settings.xml → project source/target lang)
//   - text direction (RTL)       (inferred — Arabic/Hebrew/… render correctly)
//   - versification + naming     (captured for fidelity + export file naming)
//   - project display name        (Settings.xml <FullName>)
//
// Parsing is regex-based: these XML files are flat and we only want a handful
// of fields, so we avoid a DOMParser dependency (keeps this usable in the
// import worker path and unit tests without a DOM env).

export interface ParatextNaming {
  /** <FileNamePrePart> — fixed prefix before the book-name portion. */
  prePart: string
  /** <FileNamePostPart> — fixed suffix (usually "<ProjectCode>.SFM"). */
  postPart: string
  /** <FileNameBookNameForm> — the template, e.g. "41MAT" (2-digit number +
   *  3-letter code), "MAT", or "41". Used when reconstructing export names. */
  bookNameForm: string
}

export interface ParatextSettings {
  /** <Name> — short project code (e.g. "arONAV12"). */
  name: string
  /** <FullName> — human display name (e.g. "Biblica® Open New Arabic Version 2012"). */
  fullName: string
  /** <Language> — human language name (e.g. "Standard Arabic"). */
  language: string
  /** ISO 639-3 code parsed from <LanguageIsoCode> "arb:::" → "arb". */
  languageIsoCode: string
  /** <Versification> code: 1=Original 2=Septuagint 3=Vulgate 4=English 5=RussianOrthodox 6=RussianProtestant. */
  versification: string
  /** <Encoding> codepage (65001 = UTF-8). */
  encoding: string
  /** <Guid> project id, when present. */
  guid?: string
  /** <StyleSheet>, usually usfm.sty. */
  stylesheet?: string
  /** Whether the script is right-to-left. Inferred from the ISO code (Paratext
   *  Settings.xml doesn't reliably carry an explicit flag); callers can also
   *  override by scanning content. */
  rightToLeft: boolean
  naming: ParatextNaming
  /** <BooksPresent> bit string (123 chars), when present. */
  booksPresent?: string
}

export interface ParatextBookName {
  code: string
  abbr: string
  short: string
  long: string
}

/** ISO 639 codes (1 and 3) for right-to-left scripts. Conservative but covers
 *  the scripts a Bible-translation cohort actually hits: Arabic, Hebrew,
 *  Persian/Dari, Urdu, Pashto, Sindhi, Kurdish (Sorani), Syriac, Dhivehi,
 *  N'Ko, Thaana, Samaritan, Yiddish. */
const RTL_ISO = new Set([
  "ar", "arb", "ara",            // Arabic
  "he", "heb",                   // Hebrew
  "fa", "fas", "per", "prs",     // Persian / Dari
  "ur", "urd",                   // Urdu
  "ps", "pus", "pbt",            // Pashto
  "sd", "snd",                   // Sindhi
  "ku", "ckb",                   // Kurdish (Sorani)
  "syr", "syc", "aii",           // Syriac / Assyrian Neo-Aramaic
  "dv", "div",                   // Dhivehi
  "nqo",                         // N'Ko
  "yi", "yid",                   // Yiddish
  "uig", "ug",                   // Uyghur
])

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&") // last — so "&amp;lt;" doesn't double-decode
}

/** Read a single top-level element's text content. Handles both `<Tag>v</Tag>`
 *  and self-closing `<Tag />` (returns ""). */
function readTag(xml: string, tag: string): string {
  const open = new RegExp(`<${tag}\\s*/>`, "i")
  if (open.test(xml)) return ""
  const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i"))
  return m ? decodeXmlEntities(m[1]).trim() : ""
}

/** Strong RTL Unicode ranges: Hebrew, Arabic, Syriac, Thaana, NKo, Samaritan,
 *  Arabic Supplement/Extended, Arabic Presentation Forms. */
const RTL_CHAR_RE =
  /[֐-׿؀-ۿ܀-ݏݐ-ݿހ-޿߀-߿ࠀ-࠿ࢠ-ࣿיִ-﷿ﹰ-﻿]/

/** Heuristic: does this text lean right-to-left? True when >20% of the first
 *  few hundred non-space characters are in strong-RTL blocks. */
export function looksRightToLeft(sample: string): boolean {
  const chars = sample.replace(/\s/g, "").slice(0, 400)
  if (chars.length === 0) return false
  let rtl = 0
  for (const ch of chars) if (RTL_CHAR_RE.test(ch)) rtl++
  return rtl / chars.length > 0.2
}

export function parseParatextSettings(xml: string): ParatextSettings {
  const isoRaw = readTag(xml, "LanguageIsoCode") // "arb:::" → "arb"
  const languageIsoCode = isoRaw.split(":")[0].trim()
  const name = readTag(xml, "Name")
  const language = readTag(xml, "Language")
  const guid = readTag(xml, "Guid")
  const stylesheet = readTag(xml, "StyleSheet")

  return {
    name,
    fullName: readTag(xml, "FullName") || name,
    language,
    languageIsoCode,
    versification: readTag(xml, "Versification"),
    encoding: readTag(xml, "Encoding"),
    guid: guid || undefined,
    stylesheet: stylesheet || undefined,
    rightToLeft: languageIsoCode ? RTL_ISO.has(languageIsoCode.toLowerCase()) : false,
    naming: {
      prePart: readTag(xml, "FileNamePrePart"),
      postPart: readTag(xml, "FileNamePostPart"),
      bookNameForm: readTag(xml, "FileNameBookNameForm"),
    },
    booksPresent: readTag(xml, "BooksPresent") || undefined,
  }
}

export function parseBookNames(xml: string): Map<string, ParatextBookName> {
  const out = new Map<string, ParatextBookName>()
  const RE = /<book\s+([^>]*?)\/?>/gi
  let m: RegExpExecArray | null
  while ((m = RE.exec(xml)) !== null) {
    const attrs = m[1]
    const attr = (k: string) => {
      const a = attrs.match(new RegExp(`${k}\\s*=\\s*"([^"]*)"`, "i"))
      return a ? decodeXmlEntities(a[1]) : ""
    }
    const code = attr("code").toUpperCase()
    if (!code) continue
    out.set(code, {
      code,
      abbr: attr("abbr"),
      short: attr("short"),
      long: attr("long"),
    })
  }
  return out
}

/** The best human name for a book given the project's BookNames + a fallback.
 *  Prefers the localized short name, then long, then abbr, then the fallback
 *  English name from the canonical table (passed in), then the raw code. */
export function bookDisplayName(
  code: string,
  bookNames: Map<string, ParatextBookName> | undefined,
  fallbackEnglish?: string,
): string {
  const bn = bookNames?.get(code.toUpperCase())
  return (
    bn?.short?.trim() ||
    bn?.long?.trim() ||
    bn?.abbr?.trim() ||
    fallbackEnglish ||
    code.toUpperCase()
  )
}

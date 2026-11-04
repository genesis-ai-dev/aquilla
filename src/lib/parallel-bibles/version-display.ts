// How one pinned version is laid out in the Parallel Bibles panel: its credit
// line (licence compliance) and the direction, language and type of its text.
// Pure — reads only the helloao catalogue entry.

import type { HelloaoTranslation } from "@/lib/parsers/helloao"

/**
 * Attribution sites a licence names that the catalogue entry does not carry.
 * The SBL Greek New Testament is CC BY 4.0 and its terms ask for a link to
 * sblgnt.com; helloao lists only the eBible.org page for it.
 */
const ATTRIBUTION_WEBSITE_OVERRIDES: Readonly<Record<string, string>> = {
  grc_sbl: "https://sblgnt.com/",
}

/** Only absolute http(s) links — the catalogue is third-party data. */
function safeHttpUrl(raw: string | null | undefined): string | null {
  if (!raw) return null
  try {
    const url = new URL(raw)
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null
  } catch {
    return null
  }
}

export interface VersionCredit {
  /** What the credit names: the version's English name, else its short name. */
  name: string
  licenseUrl: string | null
  /** Null when absent, or when it is the same page as the licence. */
  websiteUrl: string | null
}

export function versionCredit(
  versionId: string,
  meta: Pick<HelloaoTranslation, "englishName" | "shortName" | "licenseUrl" | "website"> | undefined,
): VersionCredit {
  const licenseUrl = safeHttpUrl(meta?.licenseUrl)
  const website = safeHttpUrl(ATTRIBUTION_WEBSITE_OVERRIDES[versionId] ?? meta?.website)
  return {
    name: meta?.englishName || meta?.shortName || versionId,
    licenseUrl,
    websiteUrl: website && website !== licenseUrl ? website : null,
  }
}

/**
 * Original-language and Greek/Hebrew-script codes that read better in a larger
 * serif face. helloao uses ISO 639-3 (grc, hbo); the two-letter and modern
 * codes are here so a catalogue that uses them is read the same way.
 */
const GREEK_CODES = new Set(["grc", "el", "ell", "gre"])
const HEBREW_CODES = new Set(["hbo", "he", "heb", "arc"])

/** Serif faces that carry polytonic Greek and pointed Hebrew, then the platform serif. */
export const BIBLICAL_SERIF_STACK =
  '"SBL BibLit", "SBL Greek", "SBL Hebrew", "Gentium Plus", "Ezra SIL", ' +
  '"Noto Serif", "Noto Serif Hebrew", "Times New Roman", serif'

export interface VerseTextPresentation {
  dir: "rtl" | "auto"
  lang: string | undefined
  /** null: the panel's ordinary small sans. */
  script: "greek" | "hebrew" | null
}

export function verseTextPresentation(
  meta: Pick<HelloaoTranslation, "language" | "textDirection"> | undefined,
): VerseTextPresentation {
  const lang = meta?.language?.trim().toLowerCase() || undefined
  const script = !lang ? null : GREEK_CODES.has(lang) ? "greek" : HEBREW_CODES.has(lang) ? "hebrew" : null
  const rtl = meta?.textDirection?.toLowerCase() === "rtl" || (!meta?.textDirection && script === "hebrew")
  return { dir: rtl ? "rtl" : "auto", lang, script }
}

/** Type size per view and script: Greek and Hebrew read larger than the panel's sans. */
export const VERSE_TEXT_CLASS: Record<"verse" | "passage", Record<"greek" | "hebrew" | "plain", string>> = {
  verse: {
    greek: "text-sm leading-relaxed",
    hebrew: "text-base leading-relaxed",
    plain: "text-xs leading-relaxed",
  },
  passage: {
    greek: "text-[15px] leading-relaxed",
    hebrew: "text-lg leading-loose",
    plain: "text-sm leading-relaxed",
  },
}

/** Class and inline font for one version's text. */
export function verseTextStyle(
  presentation: VerseTextPresentation,
  view: "verse" | "passage",
): { className: string; style: { fontFamily: string } | undefined } {
  return {
    className: VERSE_TEXT_CLASS[view][presentation.script ?? "plain"],
    style: presentation.script ? { fontFamily: BIBLICAL_SERIF_STACK } : undefined,
  }
}

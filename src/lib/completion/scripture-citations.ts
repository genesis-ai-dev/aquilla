// Scripture citations inside PROSE source text (AQU-1573).
//
// A sermon, devotional, curriculum lesson or book quotes Scripture in running
// prose — "as Isaiah 40:25 asks", "(1 Cor. 13:4-7)", "see Romans 8:28". The
// drafting prompt needs to know WHICH verses a cell quotes so the project's
// reference Bible can supply their established wording instead of the model
// retranslating the English from scratch.
//
// This is a different problem from `parseScriptureReference`
// (src/lib/scripture-reference.ts), which reads a cell's own CANONICAL REF —
// one whole value that either is `MAT 1:4` or is not. Here the reference is one
// phrase buried in a paragraph of another language's prose, there may be several
// per cell, and everything around it must be left alone.
//
// Constraints for anything added here — SAME contract as ./prompt-build.ts,
// because sync-worker's prompt-preview imports this module so the citations the
// preview reports are the ones the real draft call injects:
//   - NO `@/` path aliases, transitively (worker tsconfigs have no path mapping).
//   - NO DOM, no `import.meta.env`, no storage access, no i18n.
//   - Pure functions only.
//
// DELIBERATELY ENGLISH-ONLY BOOK NAMES, and deliberately conservative. The
// source side of every project that has asked for this is English (Chip
// Ingram's sermons, LOTE's curriculum), and a false positive is worse than a
// miss: it injects an unrelated verse into the prompt as something to quote
// verbatim. A citation must carry an explicit `chapter:verse` — a bare book
// name, or a chapter without a verse, yields nothing, because there is no
// single verse to quote.

import { isKnownBookCode } from "../file-labeling/bible-book-names"

/** One Scripture citation found in prose. */
export interface ScriptureCitation {
  /** USFM book code, e.g. "ISA". */
  bookCode: string
  chapter: number
  /** First verse of the citation. */
  verseStart: number
  /** Last verse — equal to `verseStart` for a single-verse citation. */
  verseEnd: number
  /** Canonical ref for the citation's FIRST verse, e.g. "ISA 40:25". */
  canonicalRef: string
  /** The exact substring that matched, e.g. "1 Cor. 13:4-7". */
  matchedText: string
  /** Index of `matchedText` in the scanned string. */
  index: number
}

/**
 * English book names and the abbreviations that actually appear in prose,
 * mapped to USFM codes. Ordinal prefixes are handled separately (see
 * ORDINAL_WORDS), so a numbered book is keyed by its bare stem: "corinthians",
 * "cor", "samuel", "sam".
 */
const BOOK_WORDS: Readonly<Record<string, string>> = {
  // Pentateuch
  genesis: "GEN", gen: "GEN",
  exodus: "EXO", exod: "EXO", exo: "EXO", ex: "EXO",
  leviticus: "LEV", lev: "LEV",
  numbers: "NUM", num: "NUM",
  deuteronomy: "DEU", deut: "DEU", deu: "DEU",
  // History
  joshua: "JOS", josh: "JOS", jos: "JOS",
  judges: "JDG", judg: "JDG", jdg: "JDG",
  ruth: "RUT", rut: "RUT",
  samuel: "1SA", sam: "1SA",
  kings: "1KI", kgs: "1KI", ki: "1KI",
  chronicles: "1CH", chron: "1CH", chr: "1CH",
  ezra: "EZR", ezr: "EZR",
  nehemiah: "NEH", neh: "NEH",
  esther: "EST", esth: "EST", est: "EST",
  // Wisdom
  job: "JOB",
  psalms: "PSA", psalm: "PSA", psa: "PSA", ps: "PSA",
  proverbs: "PRO", prov: "PRO", pro: "PRO",
  ecclesiastes: "ECC", eccles: "ECC", eccl: "ECC", ecc: "ECC",
  "song of songs": "SNG", "song of solomon": "SNG", sng: "SNG",
  // Major prophets
  isaiah: "ISA", isa: "ISA",
  jeremiah: "JER", jer: "JER",
  lamentations: "LAM", lam: "LAM",
  ezekiel: "EZK", ezek: "EZK", ezk: "EZK",
  daniel: "DAN", dan: "DAN",
  // Minor prophets
  hosea: "HOS", hos: "HOS",
  joel: "JOL", jol: "JOL",
  amos: "AMO", amo: "AMO",
  obadiah: "OBA", obad: "OBA", oba: "OBA",
  jonah: "JON", jon: "JON",
  micah: "MIC", mic: "MIC",
  nahum: "NAM", nah: "NAM", nam: "NAM",
  habakkuk: "HAB", hab: "HAB",
  zephaniah: "ZEP", zeph: "ZEP", zep: "ZEP",
  haggai: "HAG", hag: "HAG",
  zechariah: "ZEC", zech: "ZEC", zec: "ZEC",
  malachi: "MAL", mal: "MAL",
  // Gospels + Acts
  matthew: "MAT", matt: "MAT", mat: "MAT", mt: "MAT",
  mark: "MRK", mrk: "MRK", mk: "MRK",
  luke: "LUK", luk: "LUK", lk: "LUK",
  john: "JHN", jhn: "JHN", jn: "JHN",
  acts: "ACT", act: "ACT",
  // Pauline
  romans: "ROM", rom: "ROM",
  corinthians: "1CO", cor: "1CO",
  galatians: "GAL", gal: "GAL",
  ephesians: "EPH", eph: "EPH",
  philippians: "PHP", phil: "PHP", php: "PHP",
  colossians: "COL", col: "COL",
  thessalonians: "1TH", thess: "1TH", thes: "1TH",
  timothy: "1TI", tim: "1TI",
  titus: "TIT", tit: "TIT",
  philemon: "PHM", philem: "PHM", phlm: "PHM", phm: "PHM",
  // General
  hebrews: "HEB", heb: "HEB",
  james: "JAS", jas: "JAS",
  peter: "1PE", pet: "1PE",
  jude: "JUD",
  revelation: "REV", revelations: "REV", rev: "REV",
}

/**
 * Books whose code carries a number. A citation of one is only accepted WITH an
 * ordinal prefix: "Corinthians 13:4" alone names no book, and silently guessing
 * "1 Corinthians" would inject the wrong verse. `JHN`/`JUD` are absent on
 * purpose — "John 3:16" and "Jude 3" are the unnumbered books, and "1 John" is
 * reached through the `john` stem below.
 */
const NUMBERED_STEMS: Readonly<Record<string, readonly [string, string, string?]>> = {
  samuel: ["1SA", "2SA"], sam: ["1SA", "2SA"],
  kings: ["1KI", "2KI"], kgs: ["1KI", "2KI"], ki: ["1KI", "2KI"],
  chronicles: ["1CH", "2CH"], chron: ["1CH", "2CH"], chr: ["1CH", "2CH"],
  corinthians: ["1CO", "2CO"], cor: ["1CO", "2CO"],
  thessalonians: ["1TH", "2TH"], thess: ["1TH", "2TH"], thes: ["1TH", "2TH"],
  timothy: ["1TI", "2TI"], tim: ["1TI", "2TI"],
  peter: ["1PE", "2PE"], pet: ["1PE", "2PE"],
  john: ["1JN", "2JN", "3JN"], jhn: ["1JN", "2JN", "3JN"], jn: ["1JN", "2JN", "3JN"],
}

/** Ordinal prefixes, in every spelling prose uses. */
const ORDINAL_WORDS: Readonly<Record<string, 1 | 2 | 3>> = {
  "1": 1, "2": 2, "3": 3,
  i: 1, ii: 2, iii: 3,
  first: 1, second: 2, third: 3,
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Longest-first alternation so "Song of Songs" wins over "song", and
 *  "Philemon" over "Phil". */
const BOOK_ALTERNATION = Object.keys(BOOK_WORDS)
  .sort((a, b) => b.length - a.length)
  .map(escapeRegExp)
  .join("|")

const ORDINAL_ALTERNATION = Object.keys(ORDINAL_WORDS)
  .sort((a, b) => b.length - a.length)
  .map(escapeRegExp)
  .join("|")

/**
 * `[ordinal] book[.] chapter:verse[-verse]`.
 *
 * The book word must start at a word boundary, and the whole citation must END
 * at one, so "Isaiah 40:25a" and "John 3:16-17" match while a version string
 * like "40:25:3" does not. The separator before the chapter admits a
 * non-breaking space, which copy-pasted prose is full of.
 */
const CITATION_RE = new RegExp(
  String.raw`\b(?:(${ORDINAL_ALTERNATION})[\s.]{0,2})?` +
    String.raw`(${BOOK_ALTERNATION})\.?[\s\u00a0]{1,2}` +
    String.raw`(\d{1,3}):(\d{1,3})(?:\s?[-–]\s?(\d{1,3}))?(?![\d:])`,
  "gi",
)

/** Hard cap on citations reported for one cell — a prompt-budget guard. */
export const MAX_CITATIONS_PER_CELL = 6

export interface FindScriptureCitationsOptions {
  /** Stop after this many citations. Defaults to MAX_CITATIONS_PER_CELL. */
  limit?: number
}

/**
 * Find the Scripture citations in `text`, in the order they appear.
 *
 * Duplicates collapse to their first occurrence: a cell that cites Isaiah 40:25
 * twice needs the verse injected once. A citation whose book cannot be resolved
 * — a numbered book with no ordinal, an unknown word, an out-of-range ordinal —
 * is dropped rather than guessed at.
 */
export function findScriptureCitations(
  text: string | null | undefined,
  options: FindScriptureCitationsOptions = {},
): ScriptureCitation[] {
  const source = text ?? ""
  if (!source.trim()) return []
  const limit = Math.max(0, options.limit ?? MAX_CITATIONS_PER_CELL)
  if (limit === 0) return []

  const found: ScriptureCitation[] = []
  const seen = new Set<string>()
  // A fresh regex per call: CITATION_RE is global, so sharing it across calls
  // would carry `lastIndex` between them.
  const re = new RegExp(CITATION_RE.source, CITATION_RE.flags)

  for (let match = re.exec(source); match; match = re.exec(source)) {
    const [matchedText, ordinalWord, bookWord, chapterText, verseText, verseEndText] = match
    const bookCode = resolveBookCode(bookWord, ordinalWord)
    if (!bookCode) continue

    const chapter = Number(chapterText)
    const verseStart = Number(verseText)
    const verseEnd = verseEndText ? Number(verseEndText) : verseStart
    if (!chapter || !verseStart || verseEnd < verseStart) continue

    const canonicalRef = `${bookCode} ${chapter}:${verseStart}`
    const key = `${canonicalRef}-${verseEnd}`
    if (seen.has(key)) continue
    seen.add(key)

    found.push({
      bookCode,
      chapter,
      verseStart,
      verseEnd,
      canonicalRef,
      matchedText,
      index: match.index,
    })
    if (found.length >= limit) break
  }

  return found
}

/** Resolve one matched book word + optional ordinal to a USFM code. */
function resolveBookCode(bookWord: string, ordinalWord: string | undefined): string | null {
  const stem = bookWord.toLowerCase().replace(/[\s\u00a0]+/g, " ")
  const ordinal = ordinalWord ? ORDINAL_WORDS[ordinalWord.toLowerCase()] : undefined
  const numbered = NUMBERED_STEMS[stem]

  if (numbered) {
    // "John 3:16" is the Gospel; "1 John 4:8" is the epistle.
    if (!ordinal) return stem === "john" || stem === "jhn" || stem === "jn" ? "JHN" : null
    const code = numbered[ordinal - 1]
    return code && isKnownBookCode(code) ? code : null
  }

  // An ordinal on an unnumbered book ("2 Isaiah 40:25") is not a citation of
  // anything we can resolve, so it is dropped rather than read as "Isaiah".
  if (ordinal) return null
  const code = BOOK_WORDS[stem]
  return code && isKnownBookCode(code) ? code : null
}

/** Human label for the prompt block, e.g. "Isaiah 40:25" / "1 Cor. 13:4-7". */
export function citationLabel(citation: ScriptureCitation): string {
  return citation.matchedText.trim().replace(/[\s\u00a0]+/g, " ")
}

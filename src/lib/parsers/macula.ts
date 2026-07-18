// Macula Hebrew + Greek parser (AQU-178)
//
// Parses Clear Bible's Macula TSV word-level morphology data into:
//   1. TranslatableString[] — one entry per verse, value = reconstructed verse text
//   2. MaculaWordMorph[][] — per-cell array of per-word morphology rows
//
// The Macula TSV format has these columns (order may vary; first row is header):
//   xml_id | ref | class | text | transliteration | after | strongnumber |
//   gloss | english | mandarin | stem | morph | pos | type | mood | aspect |
//   voice | person | gender | number | state | case | l1 | l2 | l3 | ...
//
// We only need: ref (book+chapter+verse), text (surface word), lemma (via the
// "lemma" column or derived from root), morph, strongnumber.
//
// Ref format examples:
//   Hebrew:  "GEN 1:1!1"   (book space chapter:verse bang word-position)
//   Greek:   "MAT 1:1!1"   (same shape)
//
// The parser:
// - Strips BOM
// - Detects column order from the header row
// - Groups words by verse ref (book + chapter:verse, dropping the !N word index)
// - Builds one TranslatableString per verse (original = space-joined surface text)
// - Returns per-cell morph arrays in the same order as the verse array
//
// This is upload-based: the user supplies a Macula TSV file they have obtained
// from the Clear Bible GitHub releases. No network fetch in this parser.

import { v7 as uuidv7 } from "uuid"
import type { TranslatableString } from "./types"

export interface MaculaWordMorph {
  /** 1-based position within the cell/verse */
  word_seq: number
  /** Surface form as it appears in the text */
  surface: string
  /** Dictionary lemma, if available */
  lemma?: string
  /** Morphology code string */
  morph_code?: string
  /** Strong's Hebrew number (e.g. "H1234"), for Hebrew words */
  strongs_h?: string
  /** Strong's Greek number (e.g. "G1234"), for Greek words */
  strongs_g?: string
}

export interface MaculaParseResult {
  /** One entry per verse, suitable for importFile / emitParsedFile */
  strings: TranslatableString[]
  /** Parallel to strings — morph arrays for each verse's words */
  morphRows: MaculaWordMorph[][]
  /** USFM book code detected from refs (e.g. "GEN") */
  bookCode: string
  /** Language inferred from corpus: 'hbo' (Hebrew OT) or 'grc' (Greek NT) */
  sourceLanguage: "hbo" | "grc"
}

/** Parse raw TSV text into verse cells + per-cell morph arrays.
 *
 * Robust to:
 * - UTF-8 BOM at the start
 * - Any column order (reads the header row)
 * - Missing optional columns (lemma, morph, strongnumber)
 * - Windows (\r\n) and Unix (\n) line endings
 * - Empty trailing lines
 */
export function parseMaculaTsv(tsvText: string): MaculaParseResult {
  // Strip BOM
  if (tsvText.charCodeAt(0) === 0xfeff) tsvText = tsvText.slice(1)

  const lines = tsvText.split(/\r?\n/)
  if (lines.length < 2) {
    throw new Error("Macula TSV is empty or has no data rows")
  }

  // Parse header to locate columns
  const header = lines[0].split("\t").map((h) => h.trim().toLowerCase())

  function col(names: string[]): number {
    for (const n of names) {
      const i = header.indexOf(n)
      if (i !== -1) return i
    }
    return -1
  }

  const iRef = col(["ref", "xml_id"])
  const iText = col(["text", "word", "surface"])
  const iLemma = col(["lemma", "l1"])
  const iMorph = col(["morph", "morph_code", "morphology"])
  const iStrong = col(["strongnumber", "strong", "strongs", "strong_number"])

  if (iRef === -1) throw new Error("Macula TSV: no 'ref' or 'xml_id' column found in header")
  if (iText === -1) throw new Error("Macula TSV: no 'text' or 'word' column found in header")

  // Group words by verse ref.
  // ref looks like "GEN 1:1!1" — the verse part is everything before "!"
  // e.g. "GEN 1:1" → bookCode "GEN", section "GEN 1", canonical ref "GEN 1:1"
  const verseMap = new Map<string, { words: Array<{ surface: string; lemma?: string; morph?: string; strong?: string }> }>()
  const verseOrder: string[] = []

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) continue

    const cols = line.split("\t")
    const rawRef = (cols[iRef] ?? "").trim()
    if (!rawRef) continue

    // Strip the word-position suffix (!N) from the ref
    const verseRef = rawRef.replace(/![\w.]+$/, "").trim()
    if (!verseRef) continue

    const surface = (iText >= 0 ? cols[iText] ?? "" : "").trim()
    if (!surface) continue

    const lemma = iLemma >= 0 ? (cols[iLemma] ?? "").trim() || undefined : undefined
    const morph = iMorph >= 0 ? (cols[iMorph] ?? "").trim() || undefined : undefined
    const strong = iStrong >= 0 ? (cols[iStrong] ?? "").trim() || undefined : undefined

    if (!verseMap.has(verseRef)) {
      verseMap.set(verseRef, { words: [] })
      verseOrder.push(verseRef)
    }
    verseMap.get(verseRef)!.words.push({ surface, lemma, morph, strong })
  }

  if (verseOrder.length === 0) {
    throw new Error("Macula TSV: no verse data found after parsing")
  }

  // Detect book code from first ref (e.g. "GEN 1:1" → "GEN")
  const firstRef = verseOrder[0]
  const bookCode = firstRef.split(" ")[0] ?? "UNK"

  // Detect language from book code:
  // OT books (Genesis through Malachi) → hbo; NT books → grc
  const sourceLanguage = isOtBookCode(bookCode) ? "hbo" : "grc"

  const strings: TranslatableString[] = []
  const morphRows: MaculaWordMorph[][] = []

  for (const verseRef of verseOrder) {
    const { words } = verseMap.get(verseRef)!

    // Reconstruct verse text by joining surface forms with spaces
    const verseText = words.map((w) => w.surface).join(" ")

    // Derive section (book + chapter) from "GEN 1:1" → "GEN 1"
    const refParts = verseRef.split(":")
    const section = refParts[0] ?? verseRef

    strings.push({
      id: uuidv7(),
      original: verseText,
      translated: "",
      context: verseRef,
      group: verseRef,
      section,
      globalReferences: [verseRef],
      type: "verse",
    })

    const morphArr: MaculaWordMorph[] = words.map((w, idx) => {
      const entry: MaculaWordMorph = {
        word_seq: idx + 1,
        surface: w.surface,
      }
      if (w.lemma) entry.lemma = w.lemma
      if (w.morph) entry.morph_code = w.morph
      // Classify Strong's number: Hebrew refs start H, Greek start G
      if (w.strong) {
        const s = w.strong.trim()
        if (s.startsWith("H") || s.startsWith("h")) {
          entry.strongs_h = s.startsWith("H") ? s : "H" + s.slice(1)
        } else if (s.startsWith("G") || s.startsWith("g")) {
          entry.strongs_g = s.startsWith("G") ? s : "G" + s.slice(1)
        } else if (/^\d/.test(s)) {
          // Bare number — tag by testament
          if (sourceLanguage === "hbo") entry.strongs_h = "H" + s
          else entry.strongs_g = "G" + s
        }
      }
      return entry
    })

    morphRows.push(morphArr)
  }

  return { strings, morphRows, bookCode, sourceLanguage }
}

/** OT book codes in canonical order (Genesis–Malachi). */
const OT_BOOK_CODES = new Set([
  "GEN","EXO","LEV","NUM","DEU","JOS","JDG","RUT","1SA","2SA",
  "1KI","2KI","1CH","2CH","EZR","NEH","EST","JOB","PSA","PRO",
  "ECC","SNG","ISA","JER","LAM","EZK","DAN","HOS","JOL","AMO",
  "OBA","JON","MIC","NAM","HAB","ZEP","HAG","ZEC","MAL",
  // Paratext alternates
  "1KGS","2KGS","1CHR","2CHR","SON","EZE",
])

function isOtBookCode(code: string): boolean {
  return OT_BOOK_CODES.has(code.toUpperCase())
}

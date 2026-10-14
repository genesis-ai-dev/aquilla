// Data for the Bridge 1/2 alignment evaluation (AQU-1694).
//
// Reads, from local files:
//   • Clear-Bible Alignments (CC BY 4.0, https://github.com/Clear-Bible/Alignments):
//     a manual alignment `data/<lang>/alignments/<TEXT>/SBLGNT-<TEXT>-manual.json`
//     (records `{"source":["n43004007009"],"target":["43004007012","43004007013"]}`)
//     and its target tokens `data/<lang>/targets/<TEXT>/nt_<TEXT>.tsv`; for an
//     OT book (AQU-1700) `WLCM-<TEXT>-manual.json`, whose sources are Macula
//     Hebrew morpheme ids ("o080010160052"), and `ot_<TEXT>.tsv`;
//   • the Bible Knowledge Pack v1 `text/` and `people/` layers (bibletranslation.org).
// Nothing here downloads; scripts/bridge-align-eval.ts prints where to get them.

import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { tokenize } from "../../src/lib/completion/tokenize"
import type { BkpWord } from "../../src/lib/bible-data/pack-types"

/** One verse of the pack, keyed "BBCCCVVV" (book number, chapter, verse). */
export interface GreekVerse {
  ref: string
  ids: string[]
  words: BkpWord[]
}

/** One verse of a target text, as a project's source cell would hold it. */
export interface TextVerse {
  /** The verse as running text (Clear's tokens, spaced as `skip_space_after` says). */
  text: string
  /** Clear token id per `tokenize(text)` token. */
  ids: string[]
}

export const NT_BOOKS = [
  "MAT", "MRK", "LUK", "JHN", "ACT", "ROM", "1CO", "2CO", "GAL", "EPH", "PHP", "COL", "1TH", "2TH",
  "1TI", "2TI", "TIT", "PHM", "HEB", "JAS", "1PE", "2PE", "1JN", "2JN", "3JN", "JUD", "REV",
] as const

export const OT_BOOKS = [
  "GEN", "EXO", "LEV", "NUM", "DEU", "JOS", "JDG", "RUT", "1SA", "2SA", "1KI", "2KI", "1CH", "2CH",
  "EZR", "NEH", "EST", "JOB", "PSA", "PRO", "ECC", "SNG", "ISA", "JER", "LAM", "EZK", "DAN", "HOS",
  "JOL", "AMO", "OBA", "JON", "MIC", "NAM", "HAB", "ZEP", "HAG", "ZEC", "MAL",
] as const

export type Testament = "ot" | "nt"

export function testamentOf(book: string): Testament {
  if ((NT_BOOKS as readonly string[]).includes(book)) return "nt"
  if ((OT_BOOKS as readonly string[]).includes(book)) return "ot"
  throw new Error(`not a Bible book: ${book}`)
}

/** "JHN" → "43", "RUT" → "08": the book number of Macula's and Clear's ids. */
export function bookNumber(book: string): string {
  const nt = (NT_BOOKS as readonly string[]).indexOf(book)
  if (nt >= 0) return String(40 + nt)
  const ot = (OT_BOOKS as readonly string[]).indexOf(book)
  if (ot >= 0) return String(ot + 1).padStart(2, "0")
  throw new Error(`not a Bible book: ${book}`)
}

/** The pack's Greek, verse by verse, for the given books (all NT books by default). */
export function loadPackText(packDir: string, books: readonly string[] = NT_BOOKS): Map<string, GreekVerse> {
  const out = new Map<string, GreekVerse>()
  for (const book of books) {
    const file = path.join(packDir, "text", `${book}.json`)
    const layer = JSON.parse(readFileSync(file, "utf8")) as {
      verses: Record<string, string[]>
      words: Record<string, BkpWord>
    }
    for (const [ref, ids] of Object.entries(layer.verses)) {
      if (ids.length === 0) continue
      out.set(ids[0].slice(1, 9), { ref, ids, words: ids.map((id) => layer.words[id]) })
    }
  }
  return out
}

/** Who's Who mentions of a book: word id → mention kind ("explicit" | "pronoun" | "subject"). */
export function loadMentionKinds(packDir: string, book: string): Map<string, string> {
  const layer = JSON.parse(readFileSync(path.join(packDir, "people", `${book}.json`), "utf8")) as {
    mentions: Record<string, { kind: string }>
  }
  return new Map(Object.entries(layer.mentions).map(([id, mention]) => [id, mention.kind]))
}

/**
 * A Clear target TSV, verse by verse. Columns differ by text (BSB has
 * `exclude`/`skip_space_after`, LSG `isPunc`/`skip_space_after`, YLT only
 * `isPunc`); punctuation never becomes a token, so only the spacing differs.
 */
export function loadTargetText(tsvFile: string): Map<string, TextVerse> {
  const lines = readFileSync(tsvFile, "utf8").split("\n")
  const header = lines[0].split("\t")
  const column = (name: string) => header.indexOf(name)
  const [iId, iText, iSkip] = [column("id"), column("text"), column("skip_space_after")]
  const out = new Map<string, TextVerse>()
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue
    const cells = line.split("\t")
    const id = cells[iId].slice(0, 11)
    const key = id.slice(0, 8)
    let verse = out.get(key)
    if (!verse) out.set(key, (verse = { text: "", ids: [] }))
    const token = cells[iText]
    // A token glued to the previous one (no space) only when the TSV says so.
    verse.text += token
    for (let k = 0; k < tokenize(token).length; k++) verse.ids.push(id)
    const skip = iSkip >= 0 && (cells[iSkip] === "y" || cells[iSkip] === "True")
    if (!skip) verse.text += " "
  }
  for (const [key, verse] of out) {
    verse.text = verse.text.trim()
    // Two word tokens glued together would make one `tokenize` token out of two ids.
    if (tokenize(verse.text).length !== verse.ids.length) {
      throw new Error(`target verse ${key} does not tokenize token by token`)
    }
  }
  return out
}

/** Gold links of one book: Greek word id (or Hebrew morpheme id) → the target token ids it is aligned to. */
export function loadGold(alignmentFile: string, book: string): Map<string, Set<string>> {
  const ot = testamentOf(book) === "ot"
  const prefix = `${ot ? "o" : "n"}${bookNumber(book)}`
  const data = JSON.parse(readFileSync(alignmentFile, "utf8")) as { records: { source: string[]; target: string[] }[] }
  const out = new Map<string, Set<string>>()
  for (const record of data.records) {
    for (const source of record.source) {
      if (!source.startsWith(prefix)) continue
      // An OT id has a morpheme digit after the word's.
      const id = source.slice(0, ot ? 13 : 12)
      let targets = out.get(id)
      if (!targets) out.set(id, (targets = new Set()))
      for (const target of record.target) targets.add(target.slice(0, 11))
    }
  }
  return out
}

/** The files of one Clear text in a local checkout (or a folder holding the same file names). */
export function clearFiles(dataDir: string, text: string, testament: Testament = "nt"): { alignment: string; tsv: string } {
  const lang = { BSB: "eng", YLT: "eng", LSG: "fra", RV09: "spa" }[text]
  const alignmentName = `${testament === "ot" ? "WLCM" : "SBLGNT"}-${text}-manual.json`
  const tsvName = `${testament}_${text}.tsv`
  const candidates = [
    { alignment: path.join(dataDir, alignmentName), tsv: path.join(dataDir, tsvName) },
    lang
      ? {
          alignment: path.join(dataDir, "data", lang, "alignments", text, alignmentName),
          tsv: path.join(dataDir, "data", lang, "targets", text, tsvName),
        }
      : null,
  ]
  for (const candidate of candidates) {
    if (!candidate) continue
    if (existsSync(candidate.alignment) && existsSync(candidate.tsv)) return candidate
  }
  throw new Error(`no ${alignmentName} / ${tsvName} under ${dataDir}`)
}

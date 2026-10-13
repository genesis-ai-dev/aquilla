// Data for the Bridge 1/2 alignment evaluation (AQU-1694).
//
// Reads, from local files:
//   • Clear-Bible Alignments (CC BY 4.0, https://github.com/Clear-Bible/Alignments):
//     a manual alignment `data/<lang>/alignments/<TEXT>/SBLGNT-<TEXT>-manual.json`
//     (records `{"source":["n43004007009"],"target":["43004007012","43004007013"]}`)
//     and its target tokens `data/<lang>/targets/<TEXT>/nt_<TEXT>.tsv`;
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

/** "JHN" → "43". */
export function bookNumber(book: string): string {
  const index = (NT_BOOKS as readonly string[]).indexOf(book)
  if (index < 0) throw new Error(`not a New Testament book: ${book}`)
  return String(40 + index)
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

/** Gold links of one book: Greek word id → the target token ids it is aligned to. */
export function loadGold(alignmentFile: string, book: string): Map<string, Set<string>> {
  const prefix = `n${bookNumber(book)}`
  const data = JSON.parse(readFileSync(alignmentFile, "utf8")) as { records: { source: string[]; target: string[] }[] }
  const out = new Map<string, Set<string>>()
  for (const record of data.records) {
    for (const source of record.source) {
      if (!source.startsWith(prefix)) continue
      const id = source.slice(0, 12)
      let targets = out.get(id)
      if (!targets) out.set(id, (targets = new Set()))
      for (const target of record.target) targets.add(target.slice(0, 11))
    }
  }
  return out
}

/** The files of one Clear text in a local checkout (or a folder holding the same file names). */
export function clearFiles(dataDir: string, text: string): { alignment: string; tsv: string } {
  const lang = { BSB: "eng", YLT: "eng", LSG: "fra", RV09: "spa" }[text]
  const candidates = [
    { alignment: path.join(dataDir, `SBLGNT-${text}-manual.json`), tsv: path.join(dataDir, `nt_${text}.tsv`) },
    lang
      ? {
          alignment: path.join(dataDir, "data", lang, "alignments", text, `SBLGNT-${text}-manual.json`),
          tsv: path.join(dataDir, "data", lang, "targets", text, `nt_${text}.tsv`),
        }
      : null,
  ]
  for (const candidate of candidates) {
    if (!candidate) continue
    if (existsSync(candidate.alignment) && existsSync(candidate.tsv)) return candidate
  }
  throw new Error(`no SBLGNT-${text}-manual.json / nt_${text}.tsv under ${dataDir}`)
}

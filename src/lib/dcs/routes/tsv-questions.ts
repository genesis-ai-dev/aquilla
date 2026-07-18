// TSV Translation/Study Questions resource route (spec §4). One TSV row → one
// cell; the translatable text is the **`Question`** column, with the **`Response`**
// appended when present (labelled so the two stay distinguishable in the editor).
// Cell id is seeded `${repo}|${book}|${rowID}` using the TSV `ID` column — the
// same stable-row identity as tsv-notes.
//
// Untranslated columns (`SupportReference`, `Quote`, `Occurrence`, `Tags`) ride
// in `cell.metadata`; `canonicalRef` is built from `Reference`.

import type { DcsFile, DcsCell, ResourceRoute, DcsCatalogEntry, DcsManifest } from "../types"
import { dcsCellId, dcsFileId } from "../cell-id"
import { contentHash } from "../content-hash"
import {
  parseResourceTsv,
  bookCodeFromTsv,
  canonicalRefFromTsv,
  unescapeTsvProse,
  tsvMarkdownToHtml,
} from "./tsv-common"

const QUESTIONS_SUBJECTS = [
  "tsv translation questions",
  "translation questions",
  "tsv study questions",
  "study questions",
  "tsv obs translation questions",
]

/** Routed by subject (never repo name) with a manifest identifier fallback
 *  (`tq`/`sq`) for TSV `help`-type resources. */
function isQuestions(entry: DcsCatalogEntry, manifest: DcsManifest): boolean {
  const subject = entry.subject.toLowerCase()
  if (QUESTIONS_SUBJECTS.some((s) => subject === s || subject.includes(s))) return true
  const fmt = manifest.format.toLowerCase()
  if (!fmt.includes("tsv")) return false
  const ident = manifest.identifier.toLowerCase()
  return ident === "tq" || ident === "sq" || ident === "obs-tq"
}

/** Combine the question and (optional) response into one translatable value.
 *  Labelled prefixes keep the two halves distinguishable to a translator. */
function combineQuestion(question: string, response: string): string {
  if (!response) return question
  if (!question) return response
  return `Question: ${question}\nResponse: ${response}`
}

/** HTML twin of combineQuestion: question and response render as separate
 *  labelled paragraphs (a blank markdown line between them) so the user sees
 *  both halves distinctly in the editor. */
function combinedQuestionHtml(question: string, response: string): string {
  if (question && response) {
    return tsvMarkdownToHtml(`Question: ${question}\n\nResponse: ${response}`)
  }
  return tsvMarkdownToHtml(question || response)
}

export const tsvQuestionsRoute: ResourceRoute = {
  id: "tsv-questions",
  matches: (entry, manifest) => isQuestions(entry, manifest),
  parse: ({ entry, files }) => {
    const repo = entry.fullName
    const out: DcsFile[] = []

    const paths = [...files.keys()].filter((p) => p.toLowerCase().endsWith(".tsv")).sort()

    for (const path of paths) {
      const text = files.get(path)!
      const { rows } = parseResourceTsv(text)
      if (rows.length === 0) continue

      const book = bookCodeFromTsv(path, rows[0].reference)
      const cells: DcsCell[] = []

      for (const row of rows) {
        // Unescape TSV `\n`/`\t`/`\\` per column, then combine — the value is
        // real markdown text, and valueHtml renders it (question + response as
        // separate paragraphs). Unescaping changes value → contentHash, so a
        // re-import over old escaped cells correctly emits content commits.
        const question = unescapeTsvProse(row.prose["question"] ?? "")
        const response = unescapeTsvProse(row.prose["response"] ?? "")
        const value = combineQuestion(question, response)
        const cell: DcsCell = {
          cellId: dcsCellId(`${repo}|${book}|${row.rowId}`),
          value,
          type: "text",
          canonicalRef: canonicalRefFromTsv(book, row.reference),
          contentHash: contentHash(value),
        }
        if (value) cell.valueHtml = combinedQuestionHtml(question, response)
        if (Object.keys(row.metadata).length > 0) cell.metadata = row.metadata
        cells.push(cell)
      }

      out.push({
        fileId: dcsFileId(repo, path),
        name: path.split("/").pop() ?? path,
        bookCode: book,
        cells,
      })
    }

    return out
  },
}

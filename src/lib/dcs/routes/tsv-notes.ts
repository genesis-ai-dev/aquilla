// TSV Translation/Study Notes resource route (spec §4). One TSV row → one cell;
// the translatable unit is the **`Note`** prose column. Cell id is seeded
// `${repo}|${book}|${rowID}` using the TSV `ID` column (stable per row by
// unfoldingWord design), so a re-import where the note text changed is a commit
// on the same cell, not id churn.
//
// The untranslated columns (`SupportReference`, `Quote`, `Occurrence`, `Tags`)
// ride in `cell.metadata`. `canonicalRef` is built from the `Reference` column.

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

const NOTES_SUBJECTS = [
  "tsv translation notes",
  "translation notes",
  "tsv study notes",
  "study notes",
  "tsv obs translation notes",
]

/** Routed by subject (never repo name) with a manifest identifier fallback
 *  (`tn`/`sn`) for TSV `help`-type resources. */
function isNotes(entry: DcsCatalogEntry, manifest: DcsManifest): boolean {
  const subject = entry.subject.toLowerCase()
  if (NOTES_SUBJECTS.some((s) => subject === s || subject.includes(s))) return true
  const fmt = manifest.format.toLowerCase()
  if (!fmt.includes("tsv")) return false
  const ident = manifest.identifier.toLowerCase()
  return ident === "tn" || ident === "sn" || ident === "obs-tn"
}

export const tsvNotesRoute: ResourceRoute = {
  id: "tsv-notes",
  matches: (entry, manifest) => isNotes(entry, manifest),
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
        // The translatable unit is strictly the `Note` column (spec §4).
        // Unescape TSV `\n`/`\t`/`\\` so the value is real markdown text, and
        // render that markdown to valueHtml so the editor shows prose, not
        // `#`/`**` syntax. Unescaping changes value → contentHash, so a
        // re-import over old escaped cells correctly emits content commits.
        const note = unescapeTsvProse(row.prose["note"] ?? "")
        const cell: DcsCell = {
          cellId: dcsCellId(`${repo}|${book}|${row.rowId}`),
          value: note,
          type: "text",
          canonicalRef: canonicalRefFromTsv(book, row.reference),
          contentHash: contentHash(note),
        }
        if (note) cell.valueHtml = tsvMarkdownToHtml(note)
        if (Object.keys(row.metadata).length > 0) cell.metadata = row.metadata
        cells.push(cell)
      }

      out.push({
        fileId: dcsFileId(repo, path),
        name: path.split("/").pop() ?? path,
        sourcePath: path,
        bookCode: book,
        cells,
      })
    }

    return out
  },
}

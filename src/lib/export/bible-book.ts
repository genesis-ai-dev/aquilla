// Which files are Bible books. Kept apart from the HTML exporter so the
// workspace can ask without loading the exporter (AQU-2559).
import type { CellData } from "@/hooks/useCells"
import { parseScriptureReference } from "@/lib/scripture-reference"

/**
 * Does this file read as a Bible book — does any line carry a Bible verse
 * reference (a known book code with a chapter and verse, `RUT 1:1`)?
 *
 * AQU-2210: a `codex` file is not always Scripture. Migrated projects hold
 * dubbing episodes (`TheChosen-101-en-5-2 1:cue-…`), Pilgrim's Progress
 * (`PilgrimsProgress 1:13`) and commentaries under the same type, and the file
 * row cannot tell them apart (no book code; Codex's corpus marker is not
 * migrated). The lines can, by the same reference test that numbers a verse
 * on the page — so a file offered the page gets numbered verses.
 */
export function hasBibleVerses(cells: readonly Pick<CellData, "group">[]): boolean {
  return cells.some((cell) => parseScriptureReference(cell.group)?.verse != null)
}

/**
 * Is this file a Bible book: one the Web page export and the Bible document
 * layout (AQU-2559) both serve? A USFM or eBible file is one by definition
 * (AQU-2211: a migrated book lands as either). Any other file is one when its
 * lines carry Bible verse references, because only the lines can tell a book
 * from a dubbing episode or a commentary of the same type (AQU-2210). The
 * export dialog and the workspace ask this one question, so a book that can
 * be previewed can also be exported as the page it previews.
 */
export function isBibleBookFile(fileType: string | null | undefined, cells: readonly Pick<CellData, "group">[]): boolean {
  return fileType === "usfm" || fileType === "ebible" || hasBibleVerses(cells)
}

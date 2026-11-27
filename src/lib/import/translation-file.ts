/**
 * AQU-2544: how the translation review reads a file.
 *
 * `translationFileType` picks the reader by what the file holds, the way the
 * source import does: the type its extension names, unless its text says it
 * is something else (the source import's own content sniffing), so a USFM
 * file saved as .txt goes to the USFM reader and a .txt holding JSON is
 * refused like a .json. The text only overrules an extension the review has
 * no reader of its own for (.txt, .md, .html…). One step the source import leaves to AI-assisted
 * reading is taken here without it: a .txt of records — tab-separated, or
 * comma-separated under a header row naming its columns — is a spreadsheet,
 * and goes to the column mapping.
 *
 * `readTranslationFile` is the one path for every file the review has no
 * reader of its own for (a .txt, a Word document, Markdown, HTML, PO,
 * XLIFF…). It reads the file exactly as the source import reads it when it is
 * imported as a new source file: the same dispatch (`prepareImportFile`), the
 * same parser, and the project's own import cell unit, so the translation is
 * cut into lines the way its source was. Its lines keep their paragraph
 * starts, and the review pairs them with the open file's lines paragraph by
 * paragraph (`matchTargetRowsByOrder`). Nothing here names a format.
 *
 * No AI-assisted reading (the source import's fallback): it needs the network
 * and a sign-in, so such a file is read by its plain parser.
 *
 * Text formats parse in the import parse worker, as they do for a source
 * import; the others parse where the source import parses them.
 */

import { prepareImportFile } from "@/lib/import"
import { consistentDelimitedRecords, decodeImportText, sniffKnownTextFile } from "@/lib/import/ai-recipe"
import { t } from "@/lib/i18n/standalone"
import { parsedLinesToTargetRows, type TargetRow } from "@/lib/import-file-target"
import { isHeaderRow, parseCsvRows } from "@/lib/parsers/csv-bilingual"
import type { CellUnit, FileType } from "@/lib/parsers/types"
import { isTranslationType, translationTypeByName } from "@/lib/import/translation-destination"
import type { SourceArtifactFormat } from "../../../shared/import-contract"

/** The formats the review reads with a reader of its own: USFM by verse,
 *  subtitles by timing, spreadsheets through the column mapping. */
const OWN_READER_TYPES: ReadonlySet<FileType> = new Set<FileType>(["usfm", "vtt", "srt", "sbv", "csv", "tsv", "xlsx"])

export interface TranslationFileType {
  /** What the file is read as; null for a file of no type the import knows. */
  type: FileType | null
  /** The file's text, when it is text and the review will read it. */
  text?: string
}

/** What the review reads a file as — see the module comment. */
export async function translationFileType(file: File): Promise<TranslationFileType> {
  const byName = translationTypeByName(file.name)
  if (!isTranslationType(byName)) return { type: byName }
  let text: string
  try {
    text = decodeImportText(await file.arrayBuffer(), file.name)
  } catch {
    // A package (Word, PowerPoint, a workbook…): its extension says what it is.
    return { type: byName }
  }
  // An extension the review has a reader of its own for is that format, as
  // it always was: a .vtt without its WEBVTT line is still WebVTT.
  if (OWN_READER_TYPES.has(byName)) return { type: byName, text }
  const sniffed = sniffKnownTextFile(text)
  if (sniffed) return { type: sniffed, text }
  if (byName === "txt") {
    // A sentence can hold commas; it rarely holds tabs.
    if (consistentDelimitedRecords(text, "\t")) return { type: "tsv", text }
    if (consistentDelimitedRecords(text, ",") && isHeaderRow(parseCsvRows(text)[0] ?? [])) return { type: "csv", text }
  }
  return { type: byName, text }
}

export interface TranslationFileRead {
  /** One row per line the file holds, in file order. */
  rows: TargetRow[]
  /** The format tag the source import gives this file's original, for the
   *  copy kept beside the translation. */
  format: SourceArtifactFormat
}

export async function readTranslationFile(
  file: File,
  ctx: {
    projectId: string
    /** The project's import cell unit (`project.importCellUnit`); absent is
     *  the source import's default, Sentence. */
    cellUnit?: CellUnit
  },
): Promise<TranslationFileRead> {
  const prepared = await prepareImportFile(file, { projectId: ctx.projectId, cellUnit: ctx.cellUnit })
  const rows = parsedLinesToTargetRows(prepared.results.flatMap((result) => result.strings))
  if (!rows.some((row) => row.text.trim())) {
    throw new Error(t("importExport.errors.noImportableContent", { fileName: file.name, fileType: prepared.fileType }))
  }
  return { rows, format: prepared.results[0]?.rawSourceFormat ?? "custom-original" }
}

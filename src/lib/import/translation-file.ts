/**
 * AQU-2544: the one path into the translation review for a file it has no
 * reader of its own for (a .txt, a Word document, Markdown, HTML, PO, XLIFF…).
 *
 * The file is read exactly as the source import reads it when it is imported
 * as a new source file: the same dispatch (`prepareImportFile`: extension,
 * then content sniffing, so an XLIFF saved as .txt reads as XLIFF), the same
 * parser and the same rules for what is a line and what is skipped. So a
 * source file and its translation, in the same format, come out with the same
 * lines, and the review pairs them in order (by source text, for a bilingual
 * file). Nothing here names a format.
 *
 * Two differences from the source import, both because this reads a
 * translation:
 *  - No AI-assisted reading (the source import's fallback, and its reading of
 *    delimited records in a .txt): it needs the network and a sign-in. Such a
 *    file is read by its plain parser, line by line.
 *  - A paragraph is never cut into sentences, whatever the project's import
 *    cell unit. The sentence splitter cuts a paragraph by its length, and a
 *    translation's length is not its source's: cut the same way, a
 *    translation would come out in a different number of pieces than the
 *    lines it translates, or in the same number cut in other places.
 *
 * A file whose CONTENT the source import reads as a format the review has a
 * reader of its own for (USFM, or a subtitle file, saved as .txt) is not read
 * here: those readers match by verse or timing and, for USFM, resolve its
 * markers, which this path would leave in the translation. The person is
 * told to rename it, and the review then reads it with that reader.
 *
 * Text formats parse in the import parse worker, as they do for a source
 * import; the others parse where the source import parses them.
 */

import { prepareImportFile } from "@/lib/import"
import { t } from "@/lib/i18n/standalone"
import { parsedLinesToTargetRows, type TargetRow } from "@/lib/import-file-target"
import { hasOwnTranslationReader } from "@/lib/import/translation-destination"
import type { SourceArtifactFormat } from "../../../shared/import-contract"

export interface TranslationFileRead {
  /** One row per line the file holds, in file order. */
  rows: TargetRow[]
  /** The format tag the source import gives this file's original, for the
   *  copy kept beside the translation. */
  format: SourceArtifactFormat
}

export async function readTranslationFile(file: File, ctx: { projectId: string }): Promise<TranslationFileRead> {
  const prepared = await prepareImportFile(file, { projectId: ctx.projectId, cellUnit: "paragraph" })
  if (hasOwnTranslationReader(prepared.fileType)) {
    // The own readers' types are named for their extension (usfm, vtt, srt…).
    throw new Error(t("importExport.fileTarget.renameToReadAs", {
      format: prepared.fileType.toUpperCase(),
      extension: prepared.fileType,
    }))
  }
  const rows = parsedLinesToTargetRows(prepared.results.flatMap((result) => result.strings))
  if (!rows.some((row) => row.text.trim())) {
    throw new Error(t("importExport.errors.noImportableContent", { fileName: file.name, fileType: prepared.fileType }))
  }
  return { rows, format: prepared.results[0]?.rawSourceFormat ?? "custom-original" }
}

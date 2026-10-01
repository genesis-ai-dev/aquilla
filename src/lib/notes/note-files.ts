// Which project files hold translation notes (AQU-527).
//
// The two TN importers label their files differently, and the editor's notes
// sidebar has to recognise both:
//
// - The direct TSV import (`importTranslationNotes`) sends
//   `fileType: "tsv"` AND `kind: "translation-notes"`. The server stores `kind`
//   and the files read route resolves `fileType` as `kind ?? role`, so the file
//   comes back as `fileType: "translation-notes"` — never "tsv".
// - The DCS resource route sends `fileType: "tsv"` and no `kind`, so its files
//   come back as `fileType: "tsv"`.
//
// The sidebar used to match "tsv" alone, so a notes file imported from the
// Translation Notes card was never read: the import landed, the panel followed
// the focused verse, and it said "No translation notes for GEN 1:1." That is
// the state the phrase work was unreachable behind.

import type { FileSummary } from "@/lib/sync/cells-read-types"

/** `kind` the direct TN TSV import stamps on its file. Shared by the importer
 *  and the sidebar so a rename cannot leave one side behind. */
export const TRANSLATION_NOTES_FILE_KIND = "translation-notes"

/** `fileType` of a notes file the DCS resource route imported (no `kind`). */
const DCS_NOTES_FILE_TYPE = "tsv"

/** True for a file the notes sidebar should read note rows from. */
export function isTranslationNotesFile(file: Pick<FileSummary, "fileType">): boolean {
  return (
    file.fileType === TRANSLATION_NOTES_FILE_KIND || file.fileType === DCS_NOTES_FILE_TYPE
  )
}

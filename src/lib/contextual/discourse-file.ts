// Which files get the contextual drafting pill.
//
// Contextual drafting construes scenes across a discourse — it is meaningless
// for key/value string catalogs (json/po/properties: the eval set's explicit
// route-around) and for spreadsheet rows unless they carry canonical Scripture
// content (fileHasSections). Everything else — usfm, obs, subtitles, md/docx,
// txt, html — reads as discourse.

import { fileHasSections, type FileReference } from "@/lib/parsers/types"

const NON_DISCOURSE_TYPES = new Set<FileReference["type"]>(["json", "po", "properties"])
const TABULAR_TYPES = new Set<FileReference["type"]>(["csv", "tsv", "xlsx"])

export function isDiscourseFile(
  file: Pick<FileReference, "type" | "hasScriptureContent">,
): boolean {
  if (NON_DISCOURSE_TYPES.has(file.type)) return false
  if (TABULAR_TYPES.has(file.type)) return fileHasSections(file)
  return true
}

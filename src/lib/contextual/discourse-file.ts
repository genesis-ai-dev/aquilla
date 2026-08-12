// Which files get the contextual drafting pill.
//
// Contextual drafting construes scenes across a discourse — it is meaningless
// for key/value string catalogs (json/po/properties: the eval set's explicit
// route-around), or for IDML until contextual drafts carry the protected HTML
// anchor contract required for a safe commit. Spreadsheet rows qualify only
// when they carry canonical Scripture content (fileHasSections).

import { fileHasSections, type FileReference } from "@/lib/parsers/types"

const NON_DISCOURSE_TYPES = new Set<FileReference["type"]>(["json", "po", "properties", "idml"])
const TABULAR_TYPES = new Set<FileReference["type"]>(["csv", "tsv", "xlsx"])

export function isDiscourseFile(
  file: Pick<FileReference, "type" | "hasScriptureContent">,
): boolean {
  if (NON_DISCOURSE_TYPES.has(file.type)) return false
  if (TABULAR_TYPES.has(file.type)) return fileHasSections(file)
  return true
}

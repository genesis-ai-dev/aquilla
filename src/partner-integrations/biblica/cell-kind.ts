/**
 * What kind of Biblica content a cell holds, read back off its metadata.
 *
 * A study-Bible volume imports two kinds of cell into the same file: the study
 * apparatus the publisher wrote (`notes`) and, since AQU-1285, the Bible text
 * itself as verse-keyed cells (`scripture`). A translator has to be able to tell
 * them apart at a glance — editing a verse and editing a note about it are
 * different jobs — so the editor reads the kind from here rather than sniffing
 * the metadata bucket in place.
 */

const BIBLICA_SCRIPTURE_CONTENT_TYPE = "scripture"

/** True for a cell that holds one verse of the Bible text of a Biblica volume. */
export function isBiblicaScriptureCell(metadata: unknown): boolean {
  if (!isRecord(metadata)) return false
  const biblica = metadata.biblica
  return isRecord(biblica) && biblica.contentType === BIBLICA_SCRIPTURE_CONTENT_TYPE
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

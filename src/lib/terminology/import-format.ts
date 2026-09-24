/**
 * One entry point for "the user picked a term-base file" — AQU-684.
 *
 * The glossary import button used to branch on a single `.tbx` extension test,
 * so a FLEx/LIFT export fell through to the CSV reader and imported as garbage
 * rows (or, more often, as nothing at all) with no indication why. Format is
 * now decided by CONTENT first and the file name only as a tiebreaker: partners
 * re-save exports out of mail clients and the extension is what gets lost.
 */

import type { Concept } from "./types"
import { importConceptsCsv } from "./csv"
import { importConceptsTbx } from "./tbx"
import { importConceptsLift, looksLikeLift } from "./lift"

export type TermbaseImportFormat = "lift" | "tbx" | "csv"

/** TBX-Basic / TBX-Min roots, plus the bare `<termEntry>` fragments partners send. */
function looksLikeTbx(text: string): boolean {
  return /<(martif|tbx|termEntry|conceptEntry)[\s>]/i.test(text.slice(0, 4096))
}

/** Any markup document — an XML declaration, a doctype or a bare root element. */
function looksLikeXml(text: string): boolean {
  return /^\s*</.test(text.slice(0, 256))
}

/** Which reader owns this file. Content wins; the extension breaks ties. */
export function detectTermbaseFormat(fileName: string, text: string): TermbaseImportFormat {
  if (looksLikeLift(text)) return "lift"
  if (looksLikeTbx(text)) return "tbx"
  const name = fileName.toLowerCase()
  if (name.endsWith(".lift")) return "lift"
  if (name.endsWith(".tbx")) return "tbx"
  if (name.endsWith(".csv") || name.endsWith(".tsv")) return "csv"
  // Unrecognized XML goes to the lenient TBX reader rather than the CSV one,
  // which would otherwise read angle brackets as data.
  return looksLikeXml(text) ? "tbx" : "csv"
}

/** Parse a picked term-base file into Concept[]. Throws on malformed XML. */
export function importTermbaseFile(fileName: string, text: string): Concept[] {
  switch (detectTermbaseFormat(fileName, text)) {
    case "lift":
      return importConceptsLift(text)
    case "tbx":
      return importConceptsTbx(text)
    case "csv":
      return importConceptsCsv(text)
  }
}

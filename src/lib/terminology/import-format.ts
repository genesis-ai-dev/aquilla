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

function sameSourceTerm(a: Concept, b: Concept): boolean {
  const x = a.sourceTerm.trim()
  const y = b.sourceTerm.trim()
  return a.caseSensitive || b.caseSensitive ? x === y : x.toLowerCase() === y.toLowerCase()
}

/** True when `existing` already says everything `imported` says. */
function alreadySays(existing: Concept, imported: Concept): boolean {
  if (!sameSourceTerm(existing, imported)) return false
  const note = imported.notes?.trim()
  if (note && !(existing.notes ?? "").includes(note)) return false
  if (imported.externalIds && JSON.stringify(imported.externalIds) !== JSON.stringify(existing.externalIds)) return false
  return imported.renderings.every((wanted) =>
    existing.renderings.some(
      (have) =>
        (have.laneId ?? "") === (wanted.laneId ?? "") &&
        have.status === wanted.status &&
        have.rendering.trim().toLowerCase() === wanted.rendering.trim().toLowerCase(),
    ),
  )
}

/**
 * AQU-2487 (import sweep, Nov 2): the imported terms the list doesn't have yet.
 * Import used to append every term in the file, so importing a word list a
 * second time doubled all of it. A term is left out only when one already in
 * the list has the same source term and already carries every rendering (same
 * language, same status), note and Bible link the file gives it. A term the
 * file CHANGES still comes in as its own entry, as before.
 */
export function termsNotAlreadyListed(existing: readonly Concept[], imported: readonly Concept[]): Concept[] {
  return imported.filter((term) => !existing.some((have) => alreadySays(have, term)))
}

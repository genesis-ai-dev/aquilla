/**
 * Splice edited footnote text back into the cell's translated string.
 *
 * The translated string contains raw USFM \f...\f* spans. When the user edits
 * footnote[i], this function replaces the \ft (or body) field within that span
 * with the new text, returning the updated full string.
 *
 * The splice is surgical — only the identified translatable field(s) change.
 * All other markers (\fr, \fq, caller, structural markers) are preserved.
 * Round-trip safety: the serializer sees the same \f...\f* structure.
 *
 * FRO-317
 */

import { extractUsfmFootnotes } from "./extract"

/**
 * Replace the translatable text content of footnote[footnoteIndex] in
 * `cellText` with `newText`.
 *
 * Strategy:
 *  - Re-extract footnotes from cellText to get the current raw span + index.
 *  - Within that span, replace the content of the first \ft field (or append
 *    one if none exists). \fq/\fqa are left untouched — only the primary \ft
 *    is the translator's target in the simple edit UI.
 *  - Splice the updated span back into cellText at the original offset.
 *
 * Returns the original cellText unchanged if the footnote cannot be found.
 */
export function spliceFootnoteText(
  cellText: string,
  footnoteIndex: number,
  newText: string,
): string {
  const footnotes = extractUsfmFootnotes(cellText)
  const fn = footnotes[footnoteIndex]
  if (!fn) return cellText

  // Build updated raw span
  const updatedRaw = updateFootnoteRaw(fn.raw, fn.caller, newText)

  // Splice into cellText
  return cellText.slice(0, fn.index) + updatedRaw + cellText.slice(fn.index + fn.raw.length)
}

/**
 * Given a raw \f...\f* span and a new text value, return an updated span
 * where the \ft field carries newText.
 *
 * If the span already has a \ft field, its content is replaced.
 * If not, a \ft field is appended before \f*.
 */
function updateFootnoteRaw(raw: string, _caller: string, newText: string): string {
  const hasField = /\\ft\s/.test(raw)
  if (hasField) {
    // Replace the \ft field content (up to the next \ or \f*)
    return raw.replace(/\\ft\s+[^\\\n]*/, `\\ft ${newText}`)
  }
  // No \ft yet: append one before the closing \f*
  return raw.replace(/\\f\*$/, `\\ft ${newText}\\f*`)
}

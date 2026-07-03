/**
 * Splice edited footnote text back into the cell's translated string.
 *
 * The translated string contains raw USFM \f...\f* spans. When the user edits
 * footnote[i], this function replaces the translatable field region within
 * that span with the new text, returning the updated full string.
 *
 * The splice mirrors extract.ts exactly: the edit UI's draft is the
 * CONCATENATION of every translatable field (\ft \fq \fqa \fk \fl, including
 * nested character markers like \bd...\bd*), so the splice must replace that
 * ENTIRE region with a single \ft. Replacing only the first \ft run (the old
 * behavior) left the remaining fields in place while their text was also in
 * the draft — duplicating the note content, compounding on every save.
 * Leading scaffolding (caller, \fr reference) is preserved verbatim.
 *
 * FRO-317, FRO-472
 */

import { extractUsfmFootnotes } from "./extract"

/**
 * Replace the translatable text content of footnote[footnoteIndex] in
 * `cellText` with `newText`.
 *
 * Strategy:
 *  - Re-extract footnotes from cellText to get the current raw span + index.
 *  - Within that span, replace everything from the first translatable field
 *    marker to the closing \f* with a single `\ft newText` (or append one if
 *    no translatable field exists yet).
 *  - Splice the updated span back into cellText at the original offset.
 *
 * Returns null when the footnote cannot be found (e.g. the cell text changed
 * underneath the editor) so callers can surface the failure instead of
 * silently dropping the edit (FRO-472).
 */
export function spliceFootnoteText(
  cellText: string,
  footnoteIndex: number,
  newText: string,
): string | null {
  const footnotes = extractUsfmFootnotes(cellText)
  const fn = footnotes[footnoteIndex]
  if (!fn) return null

  // Build updated raw span
  const updatedRaw = updateFootnoteRaw(fn.raw, fn.caller, newText)

  // Splice into cellText
  return cellText.slice(0, fn.index) + updatedRaw + cellText.slice(fn.index + fn.raw.length)
}

/**
 * Remove footnote[footnoteIndex] from `cellText`, including its full raw
 * \f...\f* marker span.
 */
export function deleteFootnote(
  cellText: string,
  footnoteIndex: number,
): string {
  const footnotes = extractUsfmFootnotes(cellText)
  const fn = footnotes[footnoteIndex]
  if (!fn) return cellText

  const before = cellText.slice(0, fn.index)
  const after = cellText.slice(fn.index + fn.raw.length)
  const needsGap = before.length > 0 && after.length > 0 && !/\s$/.test(before) && !/^\s/.test(after)
  const joined = `${before}${needsGap ? " " : ""}${after}`
  return joined.replace(/[ \t]{2,}/g, " ")
}

/**
 * First translatable field marker within a footnote span. Must stay in sync
 * with the field set extract.ts treats as translatable (\ft \fq \fqa \fk \fl).
 * Longer alternatives first so \fqa is not half-matched as \fq.
 */
const FIRST_TEXT_FIELD_RE = /\\(?:fqa|fq|ft|fk|fl)\s/

/**
 * Given a raw \f...\f* span and a new text value, return an updated span
 * where a single \ft field carries newText.
 *
 * Everything before the first translatable field marker (caller, \fr
 * reference, structural scaffolding) is preserved verbatim; everything from
 * that marker to the closing \f* is replaced. This is exactly the region
 * extract.ts concatenates into the editable draft, so the round-trip is
 * idempotent — saving an unedited draft reproduces the same text (FRO-472).
 * Multi-field notes (\fq quotations etc.) are collapsed into one \ft on save;
 * that matches the edit UI, which presents the note as a single text blob.
 */
function updateFootnoteRaw(raw: string, _caller: string, newText: string): string {
  const firstField = FIRST_TEXT_FIELD_RE.exec(raw)
  if (firstField) {
    return `${raw.slice(0, firstField.index)}\\ft ${newText}\\f*`
  }
  // No translatable field yet: append one before the closing \f*
  return raw.replace(/\\f\*$/, `\\ft ${newText}\\f*`)
}

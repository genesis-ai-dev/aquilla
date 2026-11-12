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
 * AQU-317, FRO-472
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
  const updatedRaw = updateFootnoteRaw(fn.raw, newText)

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
export function updateFootnoteRaw(raw: string, newText: string): string {
  const firstField = FIRST_TEXT_FIELD_RE.exec(raw)
  if (firstField) {
    return `${raw.slice(0, firstField.index)}\\ft ${newText}\\f*`
  }
  // No translatable field yet: append one before the closing \f*
  return raw.replace(/\\f\*$/, `\\ft ${newText}\\f*`)
}

/**
 * The slice of the Add Footnote dialog's anchor this module needs: the text the
 * dialog previewed BEFORE the marker. `FootnoteInsertionAnchor` (TranslatedEditor)
 * satisfies it structurally, so the component does not have to reshape its anchor
 * and this module does not have to import from the editor.
 */
export interface FootnoteMarkerAnchor {
  previewBefore?: string
}

/**
 * Insert a freshly built `\f...\f*` marker into `cellText` where the Add
 * Footnote dialog previewed it.
 *
 * AQU-2206: the dialog's autofocused text field pulls focus out of the cell, the
 * editor's blur deactivates the cell, and the row swaps the live editor for the
 * read-only target surface. By the time Add runs there is no editor to insert
 * into, so the row commits the stored text itself — and it used to do that by
 * APPENDING the marker, which put every footnote at the end of the cell no
 * matter what the preview promised (AQU-2173 fixed the anchor capture; the
 * anchor was then thrown away here).
 *
 * The anchor's `previewBefore` is exactly the text the dialog rendered to the
 * left of the marker, so splicing at its length makes the result agree with the
 * preview by construction.
 */
export function insertFootnoteMarkerAtAnchor(
  cellText: string,
  marker: string,
  anchor: FootnoteMarkerAnchor | null | undefined,
): string {
  const offset = footnoteMarkerOffset(cellText, anchor)
  return cellText.slice(0, offset) + marker + cellText.slice(offset)
}

function footnoteMarkerOffset(
  cellText: string,
  anchor: FootnoteMarkerAnchor | null | undefined,
): number {
  const before = anchor?.previewBefore
  // No anchor at all, or one the editor could not preview: the dialog showed the
  // marker at the end of the cell, so that is where it belongs. This is also the
  // never-focused row (anchor `source: "end"`), whose previewBefore is the whole
  // cell and lands here anyway.
  if (before === undefined) return cellText.length
  // Only splice while the stored text still carries that prefix. If it does not,
  // the cell changed underneath the open dialog (a remote edit landing between
  // open and Add) and the previewed position no longer describes this text —
  // appending is wrong, but it cannot overwrite the other edit.
  if (!cellText.startsWith(before)) return cellText.length
  return offsetOutsideExistingFootnote(cellText, before.length)
}

/**
 * Never let an insertion point land in the middle of an existing `\f...\f*`
 * span: splicing there would break both markers. The containing note's end is
 * the nearest position that keeps the cell's USFM parseable.
 */
function offsetOutsideExistingFootnote(cellText: string, offset: number): number {
  for (const footnote of extractUsfmFootnotes(cellText)) {
    const end = footnote.index + footnote.raw.length
    if (offset > footnote.index && offset < end) return end
  }
  return offset
}

/**
 * AQU-662: footnote-aware translation prediction.
 *
 * Source cells may carry inline USFM footnote markers (`\f + \ft note\f*`) —
 * natively for USFM, and (since AQU-662) for DOCX too, where footnotes are
 * inlined as the same marker on import. Feeding those raw markers to the
 * completion model verbatim is wrong on two counts:
 *   1. The model echoes the raw `\f...\f*` syntax straight into the target, so
 *      unprocessed markup leaks into the predicted translation.
 *   2. The footnote's own prose is never actually presented as something to
 *      translate — it rides along inside the base text as opaque markup.
 *
 * `prepareFootnotesForPrompt` decomposes a source cell into clean base text
 * (footnote spans replaced by simple `[n]` callers) plus a labelled,
 * separately-translatable footnote block. The model then translates the base
 * text and each footnote, and may return the translated footnotes in the same
 * `[n]` form. Cells with no footnotes are returned unchanged (identity), so the
 * overwhelmingly common no-footnote path is unaffected.
 */

import { extractUsfmFootnotes } from "./extract"

export interface PreparedFootnoteSource {
  /** The source text to hand to the model: base text with `[n]` callers plus a
   *  translatable footnote block. Equals the input verbatim when no footnotes. */
  promptSource: string
  /** How many footnotes were decomposed out of the source (0 = untouched). */
  footnoteCount: number
}

/**
 * Rewrite a source cell so its footnotes are presented to the completion model
 * as translatable content rather than raw inline markup.
 */
export function prepareFootnotesForPrompt(sourceText: string): PreparedFootnoteSource {
  const notes = extractUsfmFootnotes(sourceText)
  if (!notes.length) return { promptSource: sourceText, footnoteCount: 0 }

  // Rebuild the base text, replacing each footnote span (in document order,
  // non-overlapping) with a simple `[n]` caller at its anchor position.
  let base = ""
  let cursor = 0
  const entries: string[] = []
  notes.forEach((note, i) => {
    const n = i + 1
    base += sourceText.slice(cursor, note.index)
    base += `[${n}]`
    cursor = note.index + note.raw.length
    const refPart = note.ref ? ` (${note.ref})` : ""
    entries.push(`[${n}]${refPart} ${note.text}`.trim())
  })
  base += sourceText.slice(cursor)
  base = base.trim()

  const block =
    "\n\nThe base text above contains footnote markers [1], [2], … . Translate " +
    "the base text and keep each [n] marker where it belongs. Then translate " +
    "each footnote below, returning it in the same [n] form:\n" +
    entries.join("\n")

  return { promptSource: base + block, footnoteCount: notes.length }
}

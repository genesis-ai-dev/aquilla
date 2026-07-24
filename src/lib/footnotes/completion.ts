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
 * (footnote spans replaced by simple `[n]` callers), a labelled context block
 * listing each footnote's text, and the extracted notes themselves. The prompt
 * instruction asking the model to translate the footnotes lives in
 * `buildFootnoteInstruction` and is appended to the SYSTEM prompt — it must
 * never ride inside the `Source:` payload, where it contradicts the system
 * prompt's "output ONLY the translation of the final source line" rule and
 * makes the model emit nothing at all.
 *
 * The model's `[n]`-form reply is converted back into real `\f...\f*` markers
 * by `reintegrateFootnotes` (./reintegrate.ts) before commit.
 *
 * Cells with no footnotes are returned unchanged (identity), so the
 * overwhelmingly common no-footnote path is unaffected.
 */

import { extractUsfmFootnotes, type ExtractedFootnote } from "./extract"

export interface PreparedFootnoteSource {
  /** The source text to hand to the model: base text with `[n]` callers only.
   *  Equals the input verbatim when no footnotes. */
  promptSource: string
  /** How many footnotes were decomposed out of the source (0 = untouched). */
  footnoteCount: number
  /** Extracted notes in document order; notes[i] corresponds to caller [i+1].
   *  Needed by reintegrateFootnotes to rebuild the raw markers. */
  notes: ExtractedFootnote[]
  /** Labelled context block listing each footnote ("" when no footnotes).
   *  Rendered in the user message BEFORE the final `Source:` line. */
  footnoteBlock: string
}

/**
 * Rewrite a source cell so its footnotes are presented to the completion model
 * as translatable content rather than raw inline markup.
 */
export function prepareFootnotesForPrompt(sourceText: string): PreparedFootnoteSource {
  const notes = extractUsfmFootnotes(sourceText)
  if (!notes.length) {
    return { promptSource: sourceText, footnoteCount: 0, notes, footnoteBlock: "" }
  }

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

  const footnoteBlock =
    "Source footnotes for the [n] markers in the source line below:\n" +
    entries.join("\n")

  return { promptSource: base, footnoteCount: notes.length, notes, footnoteBlock }
}

/**
 * System-prompt addendum describing the footnote output contract. Appended
 * after the base system prompt (and rules block) only when the source actually
 * carries footnotes. Deliberately placeholder-free so it composes with a
 * custom user-configured system prompt too, and explicit that it refines the
 * base prompt's "final source line only" output rule — that contradiction is
 * what previously made models return an empty completion for footnoted cells.
 */
export function buildFootnoteInstruction(footnoteCount: number): string {
  const markers = footnoteCount === 1 ? "[1]" : `[1] through [${footnoteCount}]`
  return (
    "Footnote output (this refines the output rules above for this request): " +
    `the final source line contains the numbered footnote marker(s) ${markers}, ` +
    'and the "Source footnotes" block lists each footnote\'s source text. ' +
    "First output the translation of the final source line, keeping every [n] " +
    "marker exactly where it belongs in the translated text. Then output one " +
    "line per footnote, each being [n] followed by that footnote's translation. " +
    "These footnote lines are part of the required output — nothing else."
  )
}

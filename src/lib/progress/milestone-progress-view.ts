// AQU-2110: which progress figures a file's chapter picker shows.
//
// Pure, and apart from the picker component so React Fast Refresh keeps that
// file components-only; the picker imports it and the tests pin it directly.

/**
 * A division's progress figures. `translated` / `validated` are the text
 * pair every picker row has always shown. The three AQU-2110 adds are
 * OPTIONAL, and absent means "not counted here" — a caller that predates
 * audio progress gets the text column it always had, never a fabricated
 * "0% recorded".
 */
export interface MilestoneProgress {
  translated: number
  validated: number
  total: number
  /** Target text alone, without the take that also counts as `translated`. */
  textTranslated?: number
  /** Lines carrying a take of their own. */
  audioRecorded?: number
  /** Lines whose every chosen take meets the audio validation requirement. */
  audioValidated?: number
}

/**
 * Which figures a file's picker shows, decided ONCE PER FILE so one file's
 * rows are never a patchwork of chapters in different units.
 *
 *   - "text":  no recordings anywhere — the two text lines, byte-identical
 *              to before.
 *   - "audio": recordings and no target text in the language being viewed —
 *              the audio pair alone, since the text pair can never move on
 *              a language with no written form.
 *   - "both":  text and takes — the text figures as before, with the audio
 *              column beside them.
 */
export type MilestoneProgressView = "text" | "audio" | "both"

export function progressViewFor(items: readonly MilestoneProgress[]): MilestoneProgressView {
  let recorded = 0
  let text = 0
  for (const item of items) {
    recorded += item.audioRecorded ?? 0
    // A caller that does not count text alone reports the pair it has: the
    // old `translated` over-counts a take as text, which only ever keeps a
    // file in the text view it would have shown anyway.
    text += item.textTranslated ?? item.translated
  }
  if (recorded === 0) return "text"
  return text === 0 ? "audio" : "both"
}

/**
 * Content-only projection of raw USFM cell text (AQU-1283).
 *
 * The lossless parser (usfm-lossless.ts) keeps intra-verse markers verbatim in
 * cell text and the SPA strips them at render time (usfm-display.ts). The
 * Agent API's `agent:usfm` import profile declares `fidelity: 'content-only'`
 * instead: what lands in cell `value` must already be readable text, because
 * agents draft straight from `value` and never run the display transform.
 *
 * This module is that projection. Built on the SAME segmenter the SPA renders
 * with, so agent imports and the editor agree on which markers are text,
 * which are notes, and which are breaks:
 *   - text runs      → concatenated
 *   - break segments → one newline (\p, \q1-4, \b, \li …); trailing/dangling
 *                      breaks vanish
 *   - note segments  → dropped from the text and returned in `notes` (footnotes
 *                      \f…\f*, endnotes \fe…\fe*, crossrefs \x…\x*) so the
 *                      importer can keep them in a side field
 *   - character markers (\add, \nd, \+bk, \w|attrs …) are unwrapped by the
 *     segmenter
 *   - the USFM no-break space `~` becomes a regular space
 *
 * Whitespace left behind by removed markup is collapsed. Marker-free text is
 * returned as-is (apart from `~`) so non-USFM cells are never rewritten.
 */

import { segmentUsfmForDisplay, type UsfmNoteSegment } from "./usfm-display"

export interface UsfmContentOnlyResult {
  /** Marker-free text; breaks rendered as "\n". */
  text: string
  /** Notes removed from the text, in document order. */
  notes: UsfmNoteSegment[]
}

const USFM_NO_BREAK_SPACE_RE = /~/g

export function usfmContentOnly(raw: string): UsfmContentOnlyResult {
  const segments = segmentUsfmForDisplay(raw)
  if (segments === null) {
    return { text: raw.replace(USFM_NO_BREAK_SPACE_RE, " "), notes: [] }
  }

  let text = ""
  const notes: UsfmNoteSegment[] = []
  for (const seg of segments) {
    if (seg.kind === "text") {
      // The segmenter consumes the single space after an opening marker; any
      // newline that preceded a structural marker is folded into the break.
      text += text.endsWith("\n") ? seg.text.replace(/^\s+/, "") : seg.text
    } else if (seg.kind === "break") {
      text = text.replace(/\s+$/, "") + "\n"
    } else {
      notes.push({ ...seg, text: seg.text.replace(USFM_NO_BREAK_SPACE_RE, " ") })
    }
  }

  text = text
    .replace(USFM_NO_BREAK_SPACE_RE, " ")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()

  return { text, notes }
}

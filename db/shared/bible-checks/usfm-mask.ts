// Notes and markers inside a cell's stored text (AQU-1697).
//
// A cell keeps its footnotes as raw USFM in its text, \f + \fr 4:7 \ft Or
// "sir"\f* (src/lib/footnotes/insert.ts), and a Paratext import keeps
// character markers such as \wj … \wj*. The pack-A checks read the
// translation itself, so `maskUsfm` blanks notes and markers out with spaces:
// the same length, so offsets still point into the stored text.
//
// Relative imports only, no DOM: shared with the workers.

/** A footnote, endnote or cross-reference, from its marker to its closing marker. */
const NOTE = /\\(f|fe|x)\s[\s\S]*?\\\1\*/gu
const FOOTNOTE = /\\(f|fe)\s[\s\S]*?\\\1\*/u
/** Any other marker: \wj, \wj*, \+add, \q1. */
const MARKER = /\\\+?[a-z]+\d*\*?/giu

const blank = (match: string) => ' '.repeat(match.length)

export function maskUsfm(text: string): string {
  if (!text.includes('\\')) return text
  return text.replace(NOTE, blank).replace(MARKER, blank)
}

/** The text has a footnote or an endnote (\f … \f*, \fe … \fe*). */
export function hasFootnote(text: string): boolean {
  return FOOTNOTE.test(text)
}

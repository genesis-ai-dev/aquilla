// AQU-2561: one chapter of a USFM file, as USFM.
//
// The Export dialog's chapter scope (AQU-465) left USFM whole-file with the
// zip packages, on the grounds that all of them reinject translations into the
// original document. That holds for DOCX/PPTX/IDML, where a one-chapter file
// would mean rebuilding the package. It does not hold here: the original is
// plain text and a chapter is a contiguous run of it.
//
// A one-chapter file is two pieces of the original, in order:
//
//   - the FRONT MATTER, everything before the first `\c`. The `\id` line is
//     what makes the file a recognisable book on re-import, and taking the
//     whole block avoids deciding which of ~40 title and introduction markers
//     count as "the header";
//   - the CHAPTER, from its `\c N` up to the next `\c` (or the end of file).
//
// Each piece is produced by `serializeUsfmLossless` itself, not by cutting the
// finished text: translated text can contain anything, so a `\c` found in the
// output is not proof of a chapter boundary. And it is the unmodified
// serializer rather than a range-aware copy of its loop, because that file is
// mirrored by hand in `src/lib/parsers/usfm-lossless.ts` and every rule added
// there (lead/trail whitespace, removals, additions) would have to be kept in
// step a third time. See `serializePiece` for how the same loop is made to
// stop early.

import {
  countLossyVerses,
  serializeUsfmLossless,
  type UsfmDocument,
  type UsfmEdits,
} from "./usfm-lossless"

/** Offsets into the original text. `end` values are exclusive. */
export interface UsfmChapterRange {
  /** Where the first `\c` starts: everything before it is front matter. */
  frontMatterEnd: number
  /** Where this chapter's own `\c` starts. */
  start: number
  /** Where the next `\c` starts, or the length of the text. */
  end: number
}

/**
 * A `\c` line with a number on it, matched the way `parseUsfmLossless` reads
 * one: at the start of the file (after an optional byte-order mark) or of a
 * line, the marker name exactly `c` (not `\cl`, `\cp`, `\ca`), and a first
 * token `parseInt` accepts. A `\c` the parser ignores must not be a boundary
 * here, or a verse would be filed under one chapter and cut into another.
 */
function chapterMarkers(raw: string): { chapter: number; start: number }[] {
  const RE = /(^\uFEFF?|\n)\\c(?![a-z0-9])[ \t]*([^\n]*)/g
  const out: { chapter: number; start: number }[] = []
  let m: RegExpExecArray | null
  while ((m = RE.exec(raw)) !== null) {
    const token = m[2].trim().split(/\s+/)[0] ?? ""
    const chapter = parseInt(token, 10)
    if (Number.isNaN(chapter)) continue
    out.push({ chapter, start: m.index + m[1].length })
  }
  return out
}

/**
 * Where `chapter` sits in `raw`, or null when the file has no such chapter.
 *
 * The first `\c N` wins. A file that concatenates several books repeats its
 * chapter numbers; the caller is expected not to ask in that case (the Export
 * dialog only offers the picker when each number names one chapter).
 */
export function findUsfmChapter(raw: string, chapter: number): UsfmChapterRange | null {
  const markers = chapterMarkers(raw)
  const idx = markers.findIndex((m) => m.chapter === chapter)
  if (idx < 0) return null
  return {
    frontMatterEnd: markers[0].start,
    start: markers[idx].start,
    end: idx + 1 < markers.length ? markers[idx + 1].start : raw.length,
  }
}

interface Located {
  markerStart: number
  textStart: number
  textEnd: number
}

const inside = (from: number, to: number) => (s: Located): boolean =>
  s.markerStart >= from && s.textEnd <= to

/**
 * Serialize `[from, to)` of the document exactly as the whole-file serializer
 * would have written those characters.
 *
 * The trick is to hand the serializer a document that starts at `from` and
 * still runs to the END of the file, but lists only the spans inside the
 * range. With no span to visit past `to`, its last step copies the rest of the
 * text through verbatim, so that tail is a known length and comes straight
 * back off. Stopping the text at `to` instead would be simpler and wrong: the
 * serializer looks at the character after a span to decide whether a
 * translation needs a newline before the next marker, and the last verse of a
 * chapter is followed by exactly such a marker.
 *
 * Nothing straddles a boundary. A verse's text ends at the next `\c`, and a
 * heading is one line.
 */
function serializePiece(
  doc: UsfmDocument,
  from: number,
  to: number,
  overrides: Map<string, string>,
  edits: UsfmEdits,
): string {
  if (to <= from) return ""
  const shift = <T extends Located>(s: T): T => ({
    ...s,
    markerStart: s.markerStart - from,
    textStart: s.textStart - from,
    textEnd: s.textEnd - from,
  })
  const piece: UsfmDocument = {
    bookId: doc.bookId,
    raw: doc.raw.slice(from),
    verses: doc.verses.filter(inside(from, to)).map(shift),
    headings: doc.headings.filter(inside(from, to)).map(shift),
  }
  const out = serializeUsfmLossless(piece, overrides, edits)
  return out.slice(0, out.length - (doc.raw.length - to))
}

export interface UsfmChapterExport {
  /** Front matter followed by the one chapter. */
  text: string
  /** AQU-276's count, over the verses that are actually in `text`. */
  lossyVerseCount: number
}

/** The front matter and one chapter, with translations and edits applied. */
export function serializeUsfmChapter(
  doc: UsfmDocument,
  range: UsfmChapterRange,
  overrides: Map<string, string>,
  edits: UsfmEdits,
): UsfmChapterExport {
  const text =
    serializePiece(doc, 0, range.frontMatterEnd, overrides, edits) +
    serializePiece(doc, range.start, range.end, overrides, edits)
  // A whole-file count would warn about footnotes in chapters this file does
  // not contain. Refs are kept as parsed, so the same counter still applies.
  const exported = doc.verses.filter(
    (v) => inside(0, range.frontMatterEnd)(v) || inside(range.start, range.end)(v),
  )
  return { text, lossyVerseCount: countLossyVerses({ ...doc, verses: exported }, overrides) }
}

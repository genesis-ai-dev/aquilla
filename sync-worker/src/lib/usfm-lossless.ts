// Lossless USFM parser/serializer — duplicate of the SPA's
// `src/lib/parsers/usfm-lossless.ts`. Kept in sync by convention; this repo
// has no workspace setup, so a cross-tree import would not typecheck inside
// the worker's tsconfig (include = "src/**/*.ts"). Any change here MUST be
// mirrored in src/lib/parsers/usfm-lossless.ts (and vice versa).
//
// See that file for the design rationale.

const BOM = "﻿"

const TERMINATE_VERSE_MARKERS = new Set<string>([
  "v",
  "c", "cl", "cd", "cp", "cat",
  "s", "s1", "s2", "s3", "s4", "s5",
  "ms", "ms1", "ms2", "ms3", "ms4",
  "sr", "mr", "r",
  "sd", "sd1", "sd2", "sd3", "sd4",
  "sp",
  "d",
  "id", "ide", "rem",
  "h", "h1", "h2", "h3",
  "toc1", "toc2", "toc3", "toca1", "toca2", "toca3",
  "mt", "mt1", "mt2", "mt3", "mt4",
  "mte", "mte1", "mte2",
  "imt", "imt1", "imt2", "imt3",
  "imte", "imte1", "imte2",
  "is", "is1", "is2", "is3", "is4",
  "ip", "ipi", "ipr", "ipq",
  "im", "imi", "imq",
  "iq", "iq1", "iq2", "iq3",
  "ib", "ie",
  "ili", "ili1", "ili2",
  "io", "io1", "io2", "io3", "io4",
  "iot", "iex",
])

const PARATEXT_KINDS: Record<string, "heading" | "paratext"> = {
  "s": "heading", "s1": "heading", "s2": "heading", "s3": "heading", "s4": "heading", "s5": "heading",
  "ms": "heading", "ms1": "heading", "ms2": "heading", "ms3": "heading", "ms4": "heading",
  "sr": "heading", "mr": "heading", "r": "heading",
  "d": "heading",
  "h": "paratext", "h1": "paratext", "h2": "paratext", "h3": "paratext",
  "toc1": "paratext", "toc2": "paratext", "toc3": "paratext",
  "mt": "paratext", "mt1": "paratext", "mt2": "paratext", "mt3": "paratext",
  "mte": "paratext", "mte1": "paratext",
  "imt": "paratext", "imt1": "paratext", "imt2": "paratext",
  "is": "heading", "is1": "heading", "is2": "heading",
  "ip": "paratext", "ipi": "paratext", "ipq": "paratext",
  "io1": "paratext", "io2": "paratext", "io3": "paratext",
  "iot": "heading",
}

/**
 * AQU-1068: where this span's own MARKER starts — the offset of the backslash
 * in `\v 5` or `\s1`, as opposed to `textStart`, which is the first character
 * AFTER it.
 *
 * Needed to REMOVE a span. Skipping one by its text offsets alone strips the
 * words and leaves a bare, dangling `\v 5` behind, which is not valid USFM.
 * The value is computed while parsing and used to be discarded; it cannot be
 * recovered afterwards, because the previous verse's `textEnd` is the start of
 * whatever terminated it, and a heading between two verses makes that the
 * heading's marker rather than the `\v`.
 */
interface MarkedSpan {
  markerStart: number
}

export interface UsfmVerse extends MarkedSpan {
  number: string
  chapter: number
  book: string
  ref: string
  text: string
  textStart: number
  textEnd: number
}

export interface UsfmHeading extends MarkedSpan {
  marker: string
  kind: "heading" | "paratext"
  book: string
  chapter: number
  index: number
  ref: string
  text: string
  textStart: number
  textEnd: number
}

export interface UsfmDocument {
  bookId: string
  raw: string
  verses: UsfmVerse[]
  headings: UsfmHeading[]
}

interface LineMarker {
  start: number
  nameEnd: number
  restStart: number
  name: string
  rest: string
}

function findLineMarkers(raw: string): LineMarker[] {
  // eslint-disable-next-line no-irregular-whitespace -- intentional BOM (U+FEFF) to optionally match USFM files that start with a byte-order mark
  const RE = /(?:^(﻿)?|\n)\\([a-z]+\d*)([ \t]+)?([^\n]*)/g
  const out: LineMarker[] = []
  let m: RegExpExecArray | null
  while ((m = RE.exec(raw)) !== null) {
    if (m[0].length === 0) {
      RE.lastIndex++
      continue
    }
    const prefixLen =
      m.index === 0 ? (m[1]?.length ?? 0) : 1
    const start = m.index + prefixLen
    const name = m[2]
    const ws = m[3] ?? ""
    const rest = m[4] ?? ""
    const nameEnd = start + 1 + name.length
    const restStart = nameEnd + ws.length
    out.push({ start, nameEnd, restStart, name, rest })
  }
  return out
}

export function parseUsfmLossless(raw: string): UsfmDocument {
  const markers = findLineMarkers(raw)

  let bookId = ""
  for (const m of markers) {
    if (m.name === "id") {
      const tok = m.rest.trim().split(/\s+/)[0]
      if (tok) bookId = tok.toUpperCase()
      break
    }
  }

  const verses: UsfmVerse[] = []
  const headings: UsfmHeading[] = []
  const headingCounter = new Map<string, number>()
  let chapter = 0

  for (let i = 0; i < markers.length; i++) {
    const m = markers[i]

    if (m.name === "c") {
      const tok = m.rest.trim().split(/\s+/)[0] ?? ""
      const n = parseInt(tok, 10)
      if (!Number.isNaN(n)) chapter = n
      continue
    }

    if (m.name === "v") {
      const numMatch = m.rest.match(/^(\S+)([ \t]+)?/)
      if (!numMatch) continue
      const number = numMatch[1]
      const consumed = numMatch[0].length
      const textStart = m.restStart + consumed
      let textEnd = raw.length
      for (let j = i + 1; j < markers.length; j++) {
        if (TERMINATE_VERSE_MARKERS.has(markers[j].name)) {
          textEnd = markers[j].start
          break
        }
      }
      verses.push({
        number,
        chapter,
        book: bookId,
        ref: `${bookId} ${chapter}:${number}`.trim(),
        text: raw.slice(textStart, textEnd),
        textStart,
        textEnd,
        markerStart: m.start,
      })
      continue
    }

    if (m.name in PARATEXT_KINDS && m.rest.length > 0) {
      const textStart = m.restStart
      const textEnd = m.restStart + m.rest.length
      const counter = (headingCounter.get(m.name) ?? 0) + 1
      headingCounter.set(m.name, counter)
      const refScope = chapter > 0 ? `${bookId} ${chapter}` : bookId
      const ref = `${refScope}:${m.name}:${counter}`
      headings.push({
        marker: m.name,
        kind: PARATEXT_KINDS[m.name],
        book: bookId,
        chapter,
        index: counter,
        ref,
        text: m.rest,
        textStart,
        textEnd,
        markerStart: m.start,
      })
      continue
    }
  }

  return { bookId, raw, verses, headings }
}

/**
 * AQU-1068: what the editor did to this file beyond translating it.
 *
 * Both halves are keyed by the ref of an EXISTING span, because that is the
 * only address this format has. A cell added in the app carries no verse
 * number of its own — Ryder's rule is that nothing renumbers — so its text
 * rides the verse it follows.
 */
export interface UsfmEdits {
  /**
   * Extra text to emit immediately after a span's own content, in the same
   * paragraph and with no marker of its own. Several additions on one anchor
   * keep their given order.
   *
   * Deliberately NOT folded into `overrides`: an empty or absent override is
   * this serializer's "fall back to the original text" signal, so appending
   * through that map would erase the client's own words wherever the anchor
   * verse is untranslated. Emitting here, after the text is written, is
   * correct whichever branch produced it.
   */
  appendAfter?: Map<string, readonly string[]>
  /**
   * Refs whose span leaves the file entirely, marker included. A removal is
   * otherwise indistinguishable from an untranslated verse, so without this
   * every removal is silently undone at export.
   */
  remove?: ReadonlySet<string>
}

export function serializeUsfmLossless(
  doc: UsfmDocument,
  overrides?: Map<string, string> | Record<string, string>,
  edits?: UsfmEdits,
): string {
  const get = (ref: string): string | undefined => {
    if (!overrides) return undefined
    if (overrides instanceof Map) return overrides.get(ref)
    return Object.prototype.hasOwnProperty.call(overrides, ref) ? overrides[ref] : undefined
  }

  type Span = { ref: string; text: string; textStart: number; textEnd: number; markerStart: number }
  const spans: Span[] = [
    ...doc.verses.map((v) => ({ ref: v.ref, text: v.text, textStart: v.textStart, textEnd: v.textEnd, markerStart: v.markerStart })),
    ...doc.headings.map((h) => ({ ref: h.ref, text: h.text, textStart: h.textStart, textEnd: h.textEnd, markerStart: h.markerStart })),
  ].sort((a, b) => a.textStart - b.textStart)

  if (spans.length === 0) return doc.raw

  const raw = doc.raw
  const parts: string[] = []
  let cursor = 0
  for (const s of spans) {
    // A removed span takes its own marker with it. The gap before it is
    // emitted only as far as that marker, and the cursor resumes past the
    // span's text — so `\v 5 …` disappears whole and the verses around it are
    // untouched. Nothing renumbers, because USFM numbers are written out.
    if (edits?.remove?.has(s.ref)) {
      // Guard against a heading whose marker sits before the previous span's
      // end (never true today, but a negative slice would silently duplicate
      // text rather than fail).
      if (s.markerStart >= cursor) parts.push(raw.slice(cursor, s.markerStart))
      cursor = s.textEnd
      continue
    }
    parts.push(raw.slice(cursor, s.textStart))
    const override = get(s.ref)
    // Build this span's own output as one string, so an addition below can be
    // spliced into it rather than pushed after it — see why in the block after.
    let body: string
    if (override === undefined || override === "") {
      body = s.text
    } else {
      const priorChar = s.textStart > 0 ? raw[s.textStart - 1] : ""
      const lead =
        priorChar !== " " && priorChar !== "\t" && priorChar !== "\n" && priorChar !== "\r" ? " " : ""
      const nextChar = s.textEnd < raw.length ? raw[s.textEnd] : ""
      const trail = nextChar === "\\" && !/[\s]$/.test(override) ? "\n" : ""
      body = lead + override + trail
    }
    // Content the editor added under this verse. It belongs to the verse, so it
    // goes INSIDE the span's text, not after it.
    //
    // A verse's span runs right up to the next marker's backslash, so `body`
    // almost always ends with the newline that separates it from `\v 5`.
    // Appending past that would put the addition on the next line, where a
    // re-parse reads it as part of the FOLLOWING verse — the file would still
    // look right and the content would be attributed to the wrong verse. So
    // split the trailing whitespace off, insert, and put it back.
    const additions = edits?.appendAfter?.get(s.ref)
    if (additions && additions.length > 0) {
      const texts = additions.map((a) => a.trim()).filter((a) => a !== "")
      if (texts.length > 0) {
        const trailing = /\s*$/.exec(body)?.[0] ?? ""
        const content = body.slice(0, body.length - trailing.length)
        const separator = content === "" ? "" : " "
        body = content + separator + texts.join(" ") + trailing
      }
    }
    parts.push(body)
    cursor = s.textEnd
  }
  parts.push(raw.slice(cursor))
  return parts.join("")
}

/** Return true when the verse text span contains intra-verse USFM markers
 *  that plain-text cell replacement will silently drop.
 *
 *  Mirrors src/lib/parsers/usfm-lossless.ts — keep in sync.
 *
 *  Detects:
 *  1. Line-start markers inside the span (\q, \q1-4, \p, \m, \b, \pi, \li, etc.)
 *  2. Inline / mid-line markers (\f…\f*, \x…\x*, \wj, \nd, \add, \w, \rb, etc.)
 *
 *  Both tests fire on the raw verse text string (the `text` field of UsfmVerse),
 *  which the parser captures as everything between the verse number and the next
 *  verse-terminating marker. */
export function hasIntraVerseMarkers(verseText: string): boolean {
  // Line-start markers inside the verse span
  if (/(?:^|\n)\\[a-z]+\d*/.test(verseText)) return true
  // Inline / mid-line markers
  if (/\\./.test(verseText)) return true
  return false
}

/** Count the number of translated verses in `overrides` whose original span
 *  (from `doc.verses`) contains intra-verse markers that the plain-text
 *  substitution will drop.  Returns 0 when no overrides are given. */
export function countLossyVerses(
  doc: UsfmDocument,
  overrides: Map<string, string> | undefined,
): number {
  if (!overrides || overrides.size === 0) return 0
  let count = 0
  for (const verse of doc.verses) {
    const override = overrides.get(verse.ref)
    if (override !== undefined && override !== "" && hasIntraVerseMarkers(verse.text)) {
      count++
    }
  }
  return count
}

export function stripBom(s: string): string {
  return s.startsWith(BOM) ? s.slice(1) : s
}

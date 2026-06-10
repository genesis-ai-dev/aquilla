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

export interface UsfmVerse {
  number: string
  chapter: number
  book: string
  ref: string
  text: string
  textStart: number
  textEnd: number
}

export interface UsfmHeading {
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
      })
      continue
    }
  }

  return { bookId, raw, verses, headings }
}

export function serializeUsfmLossless(
  doc: UsfmDocument,
  overrides?: Map<string, string> | Record<string, string>,
): string {
  const get = (ref: string): string | undefined => {
    if (!overrides) return undefined
    if (overrides instanceof Map) return overrides.get(ref)
    return Object.prototype.hasOwnProperty.call(overrides, ref) ? overrides[ref] : undefined
  }

  type Span = { ref: string; text: string; textStart: number; textEnd: number }
  const spans: Span[] = [
    ...doc.verses.map((v) => ({ ref: v.ref, text: v.text, textStart: v.textStart, textEnd: v.textEnd })),
    ...doc.headings.map((h) => ({ ref: h.ref, text: h.text, textStart: h.textStart, textEnd: h.textEnd })),
  ].sort((a, b) => a.textStart - b.textStart)

  if (spans.length === 0) return doc.raw

  const raw = doc.raw
  const parts: string[] = []
  let cursor = 0
  for (const s of spans) {
    parts.push(raw.slice(cursor, s.textStart))
    const override = get(s.ref)
    if (override === undefined || override === "") {
      parts.push(s.text)
    } else {
      const priorChar = s.textStart > 0 ? raw[s.textStart - 1] : ""
      if (priorChar !== " " && priorChar !== "\t" && priorChar !== "\n" && priorChar !== "\r") {
        parts.push(" ")
      }
      parts.push(override)
      const nextChar = s.textEnd < raw.length ? raw[s.textEnd] : ""
      if (nextChar === "\\" && !/[\s]$/.test(override)) {
        parts.push("\n")
      }
    }
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

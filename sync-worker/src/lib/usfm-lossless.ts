// Lossless USFM parser/serializer — duplicate of the SPA's
// `src/lib/parsers/usfm-lossless.ts`. Kept in sync by convention; this repo
// has no workspace setup, so a cross-tree import would not typecheck inside
// the worker's tsconfig (include = "src/**/*.ts"). Any change here MUST be
// mirrored in src/lib/parsers/usfm-lossless.ts (and vice versa).
//
// See that file for the design rationale.

const BOM = "﻿"

import { usfmSpanBlocks, extractTargetBlocks, htmlSpanToUsfm } from "./usfm-html"

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

/** A target cell's content for export: plain text plus optional rich HTML. */
export interface UsfmTarget {
  value: string
  valueHtml?: string
}

/** Inline USFM for each non-empty block of a target cell, in document order.
 *  HTML → per-block inline USFM via the mapper; plain text becomes one block. */
function targetBlocks(t: UsfmTarget): string[] {
  if (t.valueHtml) {
    return extractTargetBlocks(t.valueHtml)
      .map((seg) => htmlSpanToUsfm(seg).trim())
      .filter((s) => s !== "")
  }
  const v = (t.value ?? "").trim()
  return v ? [v] : []
}

/**
 * Serialize with translations re-inserted into the ORIGINAL file's blocks.
 *
 * BLOCK scaffolding is owned by the original: for each verse we split the span
 * at block markers (`usfmSpanBlocks`) and keep those markers + their whitespace
 * byte-for-byte. The INLINE content of each block (text, character styles,
 * footnotes/cross-refs) is driven by the TARGET — so anything the translation
 * dropped (a style, a note) is absent on export (and flagged by the
 * usfm-marker-integrity rule), while markers and indentation are never
 * disturbed. When the source's block count doesn't match the translation's (the
 * translator merged/split lines), we fall back to whole-span reconstruction via
 * `htmlSpanToUsfm`. Headings are single-block, so they take that path directly.
 * Replacements are applied back-to-front so character offsets stay valid.
 *
 * With no targets the output is byte-identical to `doc.raw`. With plain-text
 * targets (no valueHtml) it matches `serializeUsfmLossless` for single-block
 * verses and preserves block structure when the translation's block count lines
 * up — a strict superset of the legacy whole-span substitution.
 */
export function serializeUsfmPerRun(
  doc: UsfmDocument,
  targets?: Map<string, UsfmTarget> | Record<string, UsfmTarget>,
): string {
  const get = (ref: string): UsfmTarget | undefined => {
    if (!targets) return undefined
    if (targets instanceof Map) return targets.get(ref)
    return Object.prototype.hasOwnProperty.call(targets, ref) ? targets[ref] : undefined
  }

  const raw = doc.raw
  type Op = { start: number; end: number; text: string; inject: boolean }
  const ops: Op[] = []

  for (const v of doc.verses) {
    const t = get(v.ref)
    if (!t) continue
    if (!t.valueHtml && (t.value ?? "") === "") continue // empty → keep source
    const span = raw.slice(v.textStart, v.textEnd)
    const regions = usfmSpanBlocks(span)
    const blocks = targetBlocks(t)
    if (regions.length > 0 && regions.length === blocks.length) {
      // Aligned: rebuild the span keeping block markers/whitespace from the
      // source (the gaps between regions) and the inline content from the target.
      let rebuilt = span.slice(0, regions[0].start)
      for (let i = 0; i < regions.length; i++) {
        rebuilt += blocks[i]
        rebuilt +=
          i < regions.length - 1
            ? span.slice(regions[i].end, regions[i + 1].start)
            : span.slice(regions[i].end)
      }
      ops.push({ start: v.textStart, end: v.textEnd, text: rebuilt, inject: false })
    } else {
      // Fallback: reconstruct the whole verse span from the HTML (or plain text).
      const repl = t.valueHtml ? htmlSpanToUsfm(t.valueHtml) : t.value ?? ""
      if (repl === "") continue
      ops.push({ start: v.textStart, end: v.textEnd, text: repl, inject: true })
    }
  }

  for (const h of doc.headings) {
    const t = get(h.ref)
    if (!t) continue
    const repl = t.valueHtml ? htmlSpanToUsfm(t.valueHtml) : t.value ?? ""
    if (repl === "") continue
    ops.push({ start: h.textStart, end: h.textEnd, text: repl, inject: true })
  }

  // Apply back-to-front so earlier offsets stay valid. Injection context is read
  // from the ORIGINAL raw (the surrounding markers/whitespace never move).
  ops.sort((a, b) => b.start - a.start)
  let out = raw
  for (const op of ops) {
    let text = op.text
    if (op.inject) {
      const prior = op.start > 0 ? raw[op.start - 1] : ""
      if (prior !== "" && prior !== " " && prior !== "\t" && prior !== "\n" && prior !== "\r") {
        text = " " + text
      }
      const next = op.end < raw.length ? raw[op.end] : ""
      if (next === "\\" && !/\s$/.test(text)) text = text + "\n"
    }
    out = out.slice(0, op.start) + text + out.slice(op.end)
  }
  return out
}

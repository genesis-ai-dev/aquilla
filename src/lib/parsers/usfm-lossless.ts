// Lossless USFM parser/serializer.
//
// USFM 3.0 has ~150 markers; faithfully modelling every one is a tar pit
// (and we'd still lag Paratext on the long tail). Instead we treat the
// original .SFM bytes as the canonical structure. The parser only needs to
// locate each verse's text span. The serializer walks the raw bytes and
// swaps in replacement verse text where provided — everything else (chapters,
// paragraphs, poetry, footnotes, character markers, intros, headers,
// comments, whitespace, line endings) passes through byte-for-byte.
//
// This guarantees round-trip byte identity by construction, and matches
// Paratext's mental model — what SIL/UBS consultants expect.
//
// Multi-book files (concatenated with \id boundaries) are out of scope here;
// callers that need per-book splitting should split on \id before parsing.
// Most real Paratext exports are one book per file.
//
// Inline character markers (\f...\f*, \wj...\wj*, \nd, \add, \w...) stay
// inside the verse text. Translators see them in the cell. Round-trip is
// preserved either way.

const BOM = "﻿"

import { usfmSpanBlocks, extractTargetBlocks, htmlSpanToUsfm } from "./usfm-html"

/** Markers that terminate a verse text span. Everything NOT in this set —
 *  paragraph markers (\p, \m, \nb, \b), poetry (\q1-4), lists (\li1-4),
 *  inline character markers (\wj, \nd, \add), footnotes (\f...\f*), etc. —
 *  stays inside the verse. This matches USFM semantics: poetry continuations
 *  and paragraph breaks BELONG to the surrounding verse; the cell that holds
 *  the verse text should include them so translators can see and edit the
 *  structure.
 *
 *  Conservative set: the next verse/chapter, any section heading (verses
 *  don't cross sections), and any introduction/header marker (verses don't
 *  appear in the intro/header section anyway). */
const TERMINATE_VERSE_MARKERS = new Set<string>([
  // Next verse / chapter
  "v",
  "c", "cl", "cd", "cp", "cat",
  // Section headings (verses live within a section, never across one)
  "s", "s1", "s2", "s3", "s4", "s5",
  "ms", "ms1", "ms2", "ms3", "ms4",
  "sr", "mr", "r",
  "sd", "sd1", "sd2", "sd3", "sd4",
  "sp",
  // Descriptive title (Psalms — appears before verses in a chapter)
  "d",
  // Book / file headers + intros (only at file start / boundary, but
  // terminating defensively keeps verse extraction sane on malformed files)
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

/** Markers whose content is translatable paratext (headings, titles, intros).
 *  These produce additional "cells" alongside verses so consultants can
 *  translate them. The serializer substitutes their spans the same way it
 *  substitutes verse spans. */
const PARATEXT_KINDS: Record<string, "heading" | "paratext"> = {
  // Section headings
  "s": "heading", "s1": "heading", "s2": "heading", "s3": "heading", "s4": "heading", "s5": "heading",
  "ms": "heading", "ms1": "heading", "ms2": "heading", "ms3": "heading", "ms4": "heading",
  "sr": "heading", "mr": "heading", "r": "heading",
  // Psalms descriptive title
  "d": "heading",
  // Book / file headers
  "h": "paratext", "h1": "paratext", "h2": "paratext", "h3": "paratext",
  "toc1": "paratext", "toc2": "paratext", "toc3": "paratext",
  "mt": "paratext", "mt1": "paratext", "mt2": "paratext", "mt3": "paratext",
  "mte": "paratext", "mte1": "paratext",
  // Introductions
  "imt": "paratext", "imt1": "paratext", "imt2": "paratext",
  "is": "heading", "is1": "heading", "is2": "heading",
  "ip": "paratext", "ipi": "paratext", "ipq": "paratext",
  "io1": "paratext", "io2": "paratext", "io3": "paratext",
  "iot": "heading",
}

export interface UsfmVerse {
  /** Verse number string as it appears in source: "1", "1-3", "1a". */
  number: string
  /** Chapter number this verse belongs to. */
  chapter: number
  /** Book id from \id (uppercase 3-letter code). Empty string if file lacks \id. */
  book: string
  /** Canonical ref, e.g. "MAT 1:1" or "GEN 1:1-3". */
  ref: string
  /** The verse text — substring of the raw between end of `\v N ` and the
   *  next verse-terminating line-start marker (or EOF). Includes paragraph
   *  breaks (\p, \q1-4, \m, \b, \pi, \li…), inline character markers, and
   *  inline footnotes verbatim. */
  text: string
  /** Byte offset (UTF-16 code units, JS string indices) into raw where the
   *  verse text begins. */
  textStart: number
  /** Byte offset where the verse text ends (exclusive). */
  textEnd: number
}

export interface UsfmHeading {
  /** Marker name without backslash: "s", "s1", "mt", "h", "toc1", "ip", … */
  marker: string
  /** "heading" for section heads, "paratext" for titles/intros. */
  kind: "heading" | "paratext"
  /** Book id from \id, uppercased. */
  book: string
  /** Chapter number this heading lives in (0 for headings before \c 1). */
  chapter: number
  /** 1-based occurrence index across the whole file — disambiguates multiple
   *  headings with the same marker. */
  index: number
  /** Synthetic canonical ref, e.g. "MAT 1:s:3" or "MAT:mt1". Stable across
   *  re-parses of the same file. */
  ref: string
  /** Heading text (substring of raw between end of `\X ` and end of line /
   *  next terminating marker). */
  text: string
  textStart: number
  textEnd: number
}

export interface UsfmDocument {
  /** Book id from the first \id marker, or "" if absent. */
  bookId: string
  /** Original raw text — the source of truth. */
  raw: string
  /** Verses in document order. */
  verses: UsfmVerse[]
  /** Translatable paratext (section headings, titles, intros) in document
   *  order. Spans never overlap verse spans. */
  headings: UsfmHeading[]
}

interface LineMarker {
  /** Position of the backslash in raw. */
  start: number
  /** Position right after the marker name (the start of the optional whitespace). */
  nameEnd: number
  /** Position right after the marker + whitespace (start of "rest"). */
  restStart: number
  /** Marker name without backslash: "v", "c", "q1". The trailing `*` (if any)
   *  on a marker like `\f*` is NOT included — it ends up at the start of rest. */
  name: string
  /** Content from restStart to end-of-line (excluding the newline). */
  rest: string
}

function findLineMarkers(raw: string): LineMarker[] {
  // Match a backslash marker at start-of-file (possibly after a BOM) or right
  // after a \n. Marker name = [a-z]+\d*. Optional [ \t]+ whitespace, then
  // "rest" up to (but not including) \n.
  //
  // Group 1: optional BOM at position 0 (so we can compute the marker start)
  // Group 2: marker name
  // Group 3: optional whitespace between marker and rest
  // Group 4: rest of line
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
      m.index === 0
        ? (m[1]?.length ?? 0)         // BOM, if present, otherwise zero
        : 1                            // the \n
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
  // Per-marker occurrence counters → stable synthetic refs across re-parses.
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
      // rest = "N [text...]"
      const numMatch = m.rest.match(/^(\S+)([ \t]+)?/)
      if (!numMatch) continue
      const number = numMatch[1]
      const consumed = numMatch[0].length
      const textStart = m.restStart + consumed
      // Verse text extends until the next verse-terminating marker. Paragraph
      // breaks (\p, \q1-4, \m, \b, \pi, \li…), inline character markers, and
      // footnotes ALL stay inside.
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
      // Heading text = the rest of the line (single-line paratext is the
      // common case). For round-trip we only need the byte span, so any
      // wrapping like multi-line intros is fine as long as the next
      // line-start marker terminates the span.
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

/** Serialize a USFM document with optional per-verse text overrides. Verses
 *  whose ref isn't in `overrides` keep their original text. With no overrides
 *  (or an empty map) the output is byte-identical to `doc.raw`. */
export function serializeUsfmLossless(
  doc: UsfmDocument,
  overrides?: Map<string, string> | Record<string, string>,
): string {
  const get = (ref: string): string | undefined => {
    if (!overrides) return undefined
    if (overrides instanceof Map) return overrides.get(ref)
    return Object.prototype.hasOwnProperty.call(overrides, ref) ? overrides[ref] : undefined
  }

  // Merge verses + headings into a single span list sorted by textStart so
  // the cursor walk is monotonic. Spans never overlap by construction (the
  // parser terminates verse text at heading markers, and heading spans are
  // bounded by their line content).
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
    // Empty override → keep original; lets unfilled cells fall back to source
    // instead of emitting a hollow `\v N \n`.
    if (override === undefined || override === "") {
      parts.push(s.text)
    } else {
      // Inject a separator when the original had none (e.g. `\v 6\n` —
      // textStart lands right after the number, so concatenating produces
      // `\v 6OVERRIDE` which mangles the verse number on re-parse).
      const priorChar = s.textStart > 0 ? raw[s.textStart - 1] : ""
      if (priorChar !== " " && priorChar !== "\t" && priorChar !== "\n" && priorChar !== "\r") {
        parts.push(" ")
      }
      parts.push(override)
      // Inject a newline if the override would run into the next line-start
      // marker (raw[textEnd] === '\\').
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
 *  We detect three classes of markers that translators cannot round-trip back
 *  once the cell's value is substituted as plain text:
 *
 *  1. Footnotes / cross-references: \f...\f*, \fe...\fe*, \x...\x*
 *  2. Poetry / paragraph breaks inside the span: \q, \q1-4, \qc, \qm, \qm1-3,
 *     \p, \m, \pi, \pc, \pr, \mi, \nb, \b, \li, \li1-4, \lim, \lim1-4
 *  3. Character-level markers: \wj, \nd, \add, \bk, \dc, \k, \tl, \sig,
 *     \pn, \png, \addpn, \qt, \qs, \fqa, \fq, \ft (inline note content),
 *     \w, \rb (ruby), \jmp, \fig, \pro
 *
 *  The test is intentionally broad: if the verse text has ANY line-start marker
 *  that is not pure whitespace, OR any inline \marker tag (backslash not
 *  at a line-start but mid-text), the verse has structure. */
export function hasIntraVerseMarkers(verseText: string): boolean {
  // Line-start USFM markers inside the verse span (e.g. \q1, \p, \m, \b, \li).
  // These appear at the start of a line within the verse text.
  if (/(?:^|\n)\\[a-z]+\d*/.test(verseText)) return true
  // Inline character markers and note wrappers (\f, \x, \wj, \nd, etc.):
  // a backslash NOT at line start (i.e. mid-line). The verse text as captured
  // by the parser begins right after the verse number so the first character
  // is content, not a line marker — any \ anywhere is intra-verse markup.
  if (/\\./.test(verseText)) return true
  return false
}

/** Strip the leading BOM, if any. Useful for hashing comparisons that should
 *  ignore BOM differences. */
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

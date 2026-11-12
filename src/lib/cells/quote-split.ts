// AQU-1759: split one passage at its quotation marks, so each speaker gets a
// row — and therefore a voice — of their own.
//
// A voice is chosen per row, and rows follow verses, so a verse holding
// narration AND speech ("Jesus said to Philip, “Where are we to buy bread?”")
// could only ever be read in one voice. Sam's ruling (2026-10-15) was to split
// the row at its quotes: narration / quote / narration, each its own row.
//
// This module only answers "where are the seams". It is pure on purpose: the
// row action, the per-file sweep and its preview count all ask it the same
// question, and a parser that decides what a client's scripture says has to be
// readable and testable without a browser.
//
// WHAT COUNTS AS A QUOTE. Scripture is published in every quoting convention,
// so the scanner knows them all and pairs each opener with ITS closers:
//
//   “English” ‘British’   „German“ ‚nested‘   „Polish”   «French» ‹single›
//   »Danish«  »Swedish»   ”Finnish”           「CJK」 『nested』    "straight"
//
// Only TOP-LEVEL quotes make a seam. A quote inside a quote is part of the same
// speech ("He said, ‘I am he’" is still one speaker reporting another), so the
// scanner keeps a stack and splits only when it empties.
//
// THE PLACES THIS COULD GO WRONG, and what it does about each:
//
//  - An APOSTROPHE is the same character as a closing single quote (’). It is
//    only read as a closer when a ‘ is open on top of the stack and the next
//    character is not a letter, so "don’t" and "Peter’s" never end anything.
//    A ’ with no ‘ open is always an apostrophe.
//  - A STRAIGHT quote (") opens and closes. It is read by what touches it: a
//    space before and a letter after opens; a letter or punctuation before and
//    a space, punctuation or the end after closes.
//  - SPEECH CROSSES VERSES. A verse can open a quote that the next verse closes
//    (John 6:26 → 6:27), and so the next verse starts mid-speech. An unclosed
//    opener runs to the end of the row; a closer met before anything opened
//    ends a quote that began in the row above, so the text up to it is one
//    speaker. Either way the row still splits at the speaker change it holds.
//  - USFM MARKUP stays in an imported verse's text (`\wj …\wj*` around the
//    words of Jesus, `\f …\f*` footnotes, `\w word|strong="…"\w*`). Markers
//    are invisible to the scanner — a footnote quoting an alternative reading
//    is not speech, and an attribute's straight quotes are not quotes — and a
//    seam takes the markers hugging a quote along with it, so `\wj “…”\wj*`
//    moves as one piece. When markup would still be cut in half, the row is
//    refused rather than split into unbalanced USFM.
//
// A FRAGMENT WITH NO WORDS IN IT is not a speaker. `“Go”.` would otherwise be a
// quote and a full stop; a lone punctuation, whitespace or markup piece is
// folded into the piece before it (or after it, at the start), so the stop
// rides with the speech it ends.

import { classifyMarker } from "@/lib/parsers/usfm-markers"

export type QuoteSplitPieceKind = "narration" | "quote"

export interface QuoteSplitPiece {
  kind: QuoteSplitPieceKind
  /** The piece's text, trimmed, markup included. Never empty. */
  text: string
}

export interface QuoteSplit {
  /** The pieces in reading order. Fewer than two means "leave the row alone":
   *  no quotation at all, or one speaker throughout. */
  pieces: QuoteSplitPiece[]
  /** Set when the row HAS seams but cutting there would split USFM markup in
   *  half. The pieces are still listed, so a caller can say what it found. */
  refusal: "markup" | null
}

interface OpenQuote {
  /** Characters that may close this quote. */
  closers: string
}

// Characters that open a quote unconditionally, with the closers they accept.
// „ takes both “ (German) and ” (Polish, Hungarian, Romanian); ‚ likewise.
const UNAMBIGUOUS_OPENERS: Record<string, string> = {
  "“": "”", // “ → ”
  "„": "“”", // „ → “ ”
  "‘": "’", // ‘ → ’
  "‚": "‘’", // ‚ → ‘ ’
  "«": "»", // « → »
  "‹": "›", // ‹ → ›
  "「": "」", // 「 → 」
  "『": "』", // 『 → 』
}

// Characters that close a quote no matter what surrounds them, once the quote
// they belong to is open. (Context is only consulted for the ambiguous ones.)
const UNAMBIGUOUS_CLOSERS = "”»›」』"

const STRAIGHT = '"'
const APOSTROPHE = "’" // ’ — closes ‘ and ‚, and is also an apostrophe.
const DOUBLE_RIGHT = "”" // ” — a closer, and an opener in Swedish/Finnish.
const LEFT_DOUBLE = "“" // “ — an opener, and the closer of „.
const LEFT_SINGLE = "‘" // ‘ — an opener, and the closer of ‚.
const RIGHT_GUILLEMET = "»" // » — a closer, and an opener in Danish/Swedish.
const RIGHT_SINGLE_GUILLEMET = "›" // ›
const LEFT_GUILLEMET = "«" // « — an opener, and the closer of Danish »…«.
const LEFT_SINGLE_GUILLEMET = "‹" // ‹

const WORD = /[\p{L}\p{N}]/u
const SPACE = /\s/u
// A USFM marker token: `\wj`, `\+nd`, `\wj*`, `\q1`, `\f`. Sticky, so it is
// only ever matched AT a backslash.
const MARKER = /\\\+?[A-Za-z][A-Za-z0-9-]*\*?/y

function isSpace(ch: string | undefined): boolean {
  return ch === undefined || SPACE.test(ch)
}

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && WORD.test(ch)
}

/** Something sits right after it and whitespace (or the start) right before:
 *  the shape of an opening mark. */
function opensHere(prev: string | undefined, next: string | undefined): boolean {
  return (prev === undefined || isSpace(prev) || /[([{—–-]/u.test(prev)) && !isSpace(next)
}

/** Text right before it and a space, punctuation or the end right after: the
 *  shape of a closing mark. */
function closesHere(prev: string | undefined, next: string | undefined): boolean {
  return !isSpace(prev) && !isWordChar(next)
}

interface Span {
  start: number
  /** Exclusive. */
  end: number
}

/** One character the reader can see, and where it sits in the raw text. */
interface Visible {
  ch: string
  at: number
}

/** A USFM marker in the raw text. Notes are a single opaque token, body included. */
interface MarkupToken extends Span {
  kind: "open" | "close" | "note"
  /** Base name for `open`/`close` (`wj`, `nd`, `q`); empty for a note. */
  name: string
}

function markerBase(raw: string): string {
  return raw.replace(/^\\\+?/, "").replace(/\*$/, "")
}

/** Split raw text into what the reader sees and the markup around it. */
function tokenize(text: string): { visible: Visible[]; markup: MarkupToken[] } {
  const visible: Visible[] = []
  const markup: MarkupToken[] = []
  let i = 0
  while (i < text.length) {
    if (text[i] === "\\") {
      MARKER.lastIndex = i
      const m = MARKER.exec(text)
      if (m) {
        const raw = m[0]
        const closing = raw.endsWith("*")
        const base = markerBase(raw)
        let end = i + raw.length
        const category = classifyMarker(raw)?.category
        if (!closing && (category === "note" || category === "crossref")) {
          // A footnote or cross-reference is opaque: what it quotes is not
          // speech, and it travels whole with the piece it sits in.
          const closer = `\\${base}*`
          const at = text.indexOf(closer, end)
          const blockEnd = at >= 0 ? at + closer.length : text.length
          markup.push({ kind: "note", name: "", start: i, end: blockEnd })
          i = blockEnd
          continue
        }
        // An opener's one separating space belongs to the marker.
        if (!closing && text[end] === " ") end++
        markup.push({ kind: closing ? "close" : "open", name: base, start: i, end })
        i = end
        continue
      }
    }
    // `\w word|lemma="x" strong="H1"\w*`: the attribute list runs to the
    // closing marker and is not text — its straight quotes are not speech.
    if (text[i] === "|") {
      const next = text.indexOf("\\", i)
      if (next >= 0) {
        MARKER.lastIndex = next
        const m = MARKER.exec(text)
        if (m && m[0].endsWith("*")) {
          i = next
          continue
        }
      }
    }
    const ch = String.fromCodePoint(text.codePointAt(i)!)
    visible.push({ ch, at: i })
    i += ch.length
  }
  return { visible, markup }
}

/** The top-level quoted spans of `text`, in raw offsets, in order. */
function topLevelQuoteSpans(text: string, visible: readonly Visible[]): Span[] {
  const spans: Span[] = []
  const stack: OpenQuote[] = []
  let spanStart = -1
  const endOf = (k: number) => visible[k].at + visible[k].ch.length

  const closeTo = (depthIndex: number, k: number) => {
    stack.length = depthIndex
    if (stack.length === 0 && spanStart >= 0) {
      spans.push({ start: spanStart, end: endOf(k) })
      spanStart = -1
    }
  }
  const open = (closers: string, k: number) => {
    if (stack.length === 0) spanStart = visible[k].at
    stack.push({ closers })
  }
  /** The open quote `ch` may close, deepest first, or -1. Only the top is
   *  eligible for an AMBIGUOUS closer — an apostrophe must never reach past an
   *  inner quote to end an outer one. */
  const closable = (ch: string, onlyTop: boolean): number => {
    for (let d = stack.length - 1; d >= 0; d--) {
      if (stack[d].closers.includes(ch)) return d
      if (onlyTop) break
    }
    return -1
  }
  /** Nothing quoted in this row yet, so a closer here can only be ending
   *  speech that began in the row above. */
  const nothingOpenedYet = () => stack.length === 0 && spans.length === 0 && spanStart < 0

  for (let k = 0; k < visible.length; k++) {
    const ch = visible[k].ch
    const prev = visible[k - 1]?.ch
    const next = visible[k + 1]?.ch

    if (ch === STRAIGHT) {
      const d = closable(ch, true)
      if (d >= 0 && !opensHere(prev, next)) closeTo(d, k)
      else if (opensHere(prev, next)) open(STRAIGHT, k)
      else if (d >= 0) closeTo(d, k)
      else if (nothingOpenedYet() && closesHere(prev, next)) spans.push({ start: 0, end: endOf(k) })
      continue
    }

    if (ch === APOSTROPHE) {
      // Only ever a closer, and only of a single quote open on TOP, and never
      // in the middle of a word ("don’t", "Peter’s").
      const d = closable(ch, true)
      if (d >= 0 && !isWordChar(next)) closeTo(d, k)
      continue
    }

    // “ and ‘ close „ and ‚ (German) before they open anything.
    if (ch === LEFT_DOUBLE || ch === LEFT_SINGLE) {
      const d = closable(ch, true)
      if (d >= 0) closeTo(d, k)
      else open(UNAMBIGUOUS_OPENERS[ch], k)
      continue
    }

    // « and ‹ close Danish »…« before they open anything.
    if (ch === LEFT_GUILLEMET || ch === LEFT_SINGLE_GUILLEMET) {
      const d = closable(ch, false)
      if (d >= 0) closeTo(d, k)
      else open(UNAMBIGUOUS_OPENERS[ch], k)
      continue
    }

    if (UNAMBIGUOUS_OPENERS[ch] !== undefined) {
      open(UNAMBIGUOUS_OPENERS[ch], k)
      continue
    }

    if (UNAMBIGUOUS_CLOSERS.includes(ch)) {
      const d = closable(ch, false)
      if (d >= 0) {
        closeTo(d, k)
        continue
      }
      // Nothing open that it belongs to. ” » › OPEN in Swedish, Finnish and
      // Danish, so read the shape first...
      if (ch === DOUBLE_RIGHT && opensHere(prev, next)) {
        open(DOUBLE_RIGHT, k)
        continue
      }
      if (ch === RIGHT_GUILLEMET && opensHere(prev, next)) {
        open(`${LEFT_GUILLEMET}${RIGHT_GUILLEMET}`, k)
        continue
      }
      if (ch === RIGHT_SINGLE_GUILLEMET && opensHere(prev, next)) {
        open(`${LEFT_SINGLE_GUILLEMET}${RIGHT_SINGLE_GUILLEMET}`, k)
        continue
      }
      // ...otherwise it ends speech that began in the row above.
      if (nothingOpenedYet()) spans.push({ start: 0, end: endOf(k) })
    }
  }

  // An opener the row never closes runs to its end: the speech continues in
  // the row below.
  if (spanStart >= 0) spans.push({ start: spanStart, end: text.length })
  return spans
}

/**
 * Widen each quote over the markup hugging it, so `\wj “…”\wj*` (the words of
 * Jesus, in a red-letter Bible) moves as one piece instead of leaving an
 * opening `\wj` behind on the narration.
 */
function hugMarkup(text: string, spans: Span[], markup: readonly MarkupToken[]): Span[] {
  return spans.map((span) => {
    let { start, end } = span
    for (;;) {
      const before = markup.find(
        (m) => m.kind === "open" && m.end <= start && text.slice(m.end, start).trim() === "",
      )
      if (!before || before.start === start) break
      start = before.start
    }
    for (;;) {
      const after = markup.find((m) => m.kind === "close" && m.start === end)
      if (!after) break
      end = after.end
    }
    return { start, end }
  })
}

/** Does every paired marker opened inside [start, end) close inside it too? */
function markupBalanced(
  text: string,
  start: number,
  end: number,
  markup: readonly MarkupToken[],
): boolean {
  const stack: string[] = []
  for (const m of markup) {
    if (m.start < start || m.start >= end || m.kind === "note") continue
    // A marker with no closer anywhere in the row is a paragraph or poetry
    // marker (`\q1`, `\p`) — it stands alone and cannot be cut in half.
    if (m.kind === "open") {
      const paired = classifyMarker(`\\${m.name}`)?.paired ?? text.includes(`\\${m.name}*`)
      const structural = classifyMarker(`\\${m.name}`)?.structural ?? false
      if (paired && !structural) stack.push(m.name)
      continue
    }
    if (stack.pop() !== m.name) return false
  }
  return stack.length === 0
}

/**
 * Where `text` splits at its top-level quotes, in reading order.
 *
 * Fewer than two pieces means there is nothing to split — no quotation at all,
 * or a row that is one speaker throughout (all narration, or all speech) — and
 * the row is to be left alone.
 */
export function splitAtQuotes(text: string): QuoteSplit {
  const { visible, markup } = tokenize(text)
  const spans = hugMarkup(text, topLevelQuoteSpans(text, visible), markup)

  const raw: Array<{ kind: QuoteSplitPieceKind; start: number; end: number }> = []
  let cursor = 0
  for (const span of spans) {
    if (span.start > cursor) raw.push({ kind: "narration", start: cursor, end: span.start })
    raw.push({ kind: "quote", start: span.start, end: span.end })
    cursor = span.end
  }
  if (cursor < text.length) raw.push({ kind: "narration", start: cursor, end: text.length })

  const hasWords = (start: number, end: number) =>
    visible.some((v) => v.at >= start && v.at < end && WORD.test(v.ch))

  // Fold every piece with no words in it into a neighbour: a stop after a
  // closing quote, a dash between two quotes, a footnote on its own.
  const merged: Array<{ kind: QuoteSplitPieceKind; start: number; end: number }> = []
  let carryStart: number | null = null
  for (const piece of raw) {
    if (!hasWords(piece.start, piece.end)) {
      if (merged.length > 0) merged[merged.length - 1].end = piece.end
      else carryStart ??= piece.start
      continue
    }
    merged.push({ kind: piece.kind, start: carryStart ?? piece.start, end: piece.end })
    carryStart = null
  }

  const pieces = merged
    .map((piece) => ({ kind: piece.kind, text: text.slice(piece.start, piece.end).trim() }))
    .filter((piece) => piece.text.length > 0)
  const refusal =
    pieces.length > 1 && merged.some((piece) => !markupBalanced(text, piece.start, piece.end, markup))
      ? ("markup" as const)
      : null
  return { pieces, refusal }
}

/** Does this row hold more than one speaker, at seams it can be cut at? */
export function canSplitAtQuotes(text: string): boolean {
  const split = splitAtQuotes(text)
  return split.pieces.length > 1 && split.refusal === null
}

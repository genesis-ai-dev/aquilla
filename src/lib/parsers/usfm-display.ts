/**
 * Display-time segmentation of raw USFM cell text.
 *
 * The lossless parser (usfm-lossless.ts) intentionally keeps intra-verse
 * markers — footnotes \f…\f*, word-level \w…\w*, poetry \q1, mid-verse \p —
 * verbatim inside cell text so export can round-trip byte-for-byte. That is
 * correct for STORAGE but wrong for DISPLAY: a translator should never read
 * raw `\f + \fr 2:1 \ft …\f*` in the middle of a verse.
 *
 * This module is the read-only display transform. It segments a raw cell
 * string into:
 *   - text runs   — verbatim slices of the raw string (markers removed)
 *   - notes       — \f…\f* footnotes, \fe…\fe* endnotes, \x…\x* crossrefs,
 *                   parsed for chip + popover rendering
 *   - breaks      — structural line markers (\p, \q1-4, \b, \li …) rendered
 *                   as line breaks with optional indent
 *
 * Character markers (\w…\w*, \wj…\wj*, \nd…\nd*, \+nested…) are unwrapped:
 * the marker tokens and any USFM 3 `|attribute` payload are dropped, the
 * enclosed content stays. Unknown markers degrade safely: the token is
 * hidden, its content remains visible.
 *
 * ROUND-TRIP GUARANTEE: this module never rewrites stored text. Every text
 * segment carries its [rawStart, rawEnd) span in the ORIGINAL string, so
 * offset-based annotations (violation ranges) can be clipped per segment via
 * clipRangesToSegment(). Edits flow through the normal commit paths
 * (TranslatedEditor / footnote splice), untouched by this transform.
 */

import { classifyMarker } from "./usfm-markers"

export interface UsfmTextSegment {
  kind: "text"
  /** Verbatim slice raw.slice(rawStart, rawEnd) — never rewritten. */
  text: string
  rawStart: number
  rawEnd: number
}

export interface UsfmNoteSegment {
  kind: "note"
  noteKind: "footnote" | "endnote" | "xref"
  /** Caller character ("+" auto, "-" none, or a literal). */
  caller: string
  /** Origin reference from \fr / \xo, e.g. "2:1". */
  ref: string
  /** Marker-stripped note body for popover/panel display. */
  text: string
  /** Full raw span "\f + \fr 2:1 \ft …\f*" (for debugging/tests). */
  raw: string
  rawStart: number
  rawEnd: number
}

export interface UsfmBreakSegment {
  kind: "break"
  /** Indent level for poetry/list continuations (\q2 → 2); 0 for plain \p. */
  indent: number
  /** True for \b (blank line) — render extra vertical space. */
  blank: boolean
  rawStart: number
  rawEnd: number
}

export type UsfmDisplaySegment = UsfmTextSegment | UsfmNoteSegment | UsfmBreakSegment

/** Matches any USFM marker token, including mixed-case (\xtSee), hyphenated
 *  z-namespace (\zpa-xb), nested (\+nd), end (\nd*) and the bare milestone
 *  terminator (\*). Mirrors usfm-tokenize.ts MARKER_RE. */
const MARKER_TOKEN_RE = /\\(?:\+?[a-zA-Z]+(?:-[a-zA-Z]+)*\d*\*?|\*)/g

/** Note-family openers that produce chip segments instead of inline text. */
const NOTE_KINDS: Record<string, UsfmNoteSegment["noteKind"]> = {
  f: "footnote",
  fe: "endnote",
  ef: "footnote", // USFM 3 extended study note
  x: "xref",
  ex: "xref", // USFM 3 extended crossref
}

/** Markers that indent their line when rendered as a break. */
const INDENTED_BREAK_BASES = new Set(["q", "qm", "pi", "li", "lim", "io", "iq", "ph", "phi"])

/** Cheap pre-check: does this cell text need display segmentation at all? */
export function hasUsfmMarkers(text: string): boolean {
  return text.includes("\\")
}

/** Strip the leading backslash, nesting "+", and trailing "*" from a token. */
function tokenBase(token: string): string {
  return token.slice(1).replace(/^\+/, "").replace(/\*$/, "").replace(/\d+$/, "")
}

/** Parse the inside of a note span: "+ \fr 2:1 \ft body…" → caller/ref/text. */
function parseNoteBody(inner: string): { caller: string; ref: string; text: string } {
  const callerMatch = inner.match(/^\s*(\S+)\s*/)
  const caller = callerMatch ? callerMatch[1] : ""
  let body = callerMatch ? inner.slice(callerMatch[0].length) : inner
  // Origin reference (\fr footnote / \xo crossref) is scaffolding, not body.
  const refMatch = body.match(/\\(?:fr|xo)\s+([^\\]+)/)
  const ref = refMatch ? refMatch[1].trim() : ""
  if (refMatch) body = body.replace(refMatch[0], " ")
  const text = body
    .replace(new RegExp(MARKER_TOKEN_RE.source, "g"), " ")
    .replace(/\|[^\\]*/g, " ") // drop USFM 3 attribute payloads inside notes
    .replace(/\s+/g, " ")
    .trim()
  return { caller, ref, text }
}

/**
 * Segment raw USFM cell text for display. Returns null when the text contains
 * no backslash at all, so callers can keep their zero-cost plain-text path.
 */
export function segmentUsfmForDisplay(raw: string): UsfmDisplaySegment[] | null {
  if (!hasUsfmMarkers(raw)) return null

  const segments: UsfmDisplaySegment[] = []
  const re = new RegExp(MARKER_TOKEN_RE.source, "g")
  let cursor = 0
  // Depth of open paired character markers (\w…, \+nd…). While inside one,
  // a "|" starts the USFM 3 attribute payload — clipped from display.
  let charDepth = 0

  const pushText = (from: number, to: number) => {
    if (to <= from) return
    let end = to
    if (charDepth > 0) {
      const pipe = raw.slice(from, to).indexOf("|")
      if (pipe !== -1) end = from + pipe
    }
    if (end > from) {
      segments.push({ kind: "text", text: raw.slice(from, end), rawStart: from, rawEnd: end })
    }
  }

  let m: RegExpExecArray | null
  while ((m = re.exec(raw)) !== null) {
    const token = m[0]
    const start = m.index

    // Bare "\*" — milestone terminator. Drop the token, keep surroundings.
    if (token === "\\*") {
      pushText(cursor, start)
      cursor = start + token.length
      continue
    }

    const isEnd = token.endsWith("*")
    const base = tokenBase(token)

    // Note-family opener: capture through its matching end marker as a chip.
    const noteKind = NOTE_KINDS[base]
    if (noteKind && !isEnd) {
      const closeToken = "\\" + token.slice(1) + "*"
      const close = raw.indexOf(closeToken, start + token.length)
      if (close !== -1) {
        pushText(cursor, start)
        const rawEnd = close + closeToken.length
        const inner = raw.slice(start + token.length, close)
        const { caller, ref, text } = parseNoteBody(inner)
        segments.push({
          kind: "note", noteKind, caller, ref, text,
          raw: raw.slice(start, rawEnd), rawStart: start, rawEnd,
        })
        cursor = rawEnd
        re.lastIndex = rawEnd
        continue
      }
      // Unterminated note: fall through and drop just the opener token.
    }

    const spec = classifyMarker(base)
    pushText(cursor, start)

    // The single space/newline after an opening marker separates markup from
    // content — it belongs to the markup, not the text.
    let after = start + token.length
    if (!isEnd && (raw[after] === " " || raw[after] === "\n")) after += 1
    // Milestone/standalone attribute payload directly after the marker
    // (\qt-s |who="Pilate"\*): skip to the next marker token.
    if (raw[after] === "|") {
      const nextSlash = raw.indexOf("\\", after)
      after = nextSlash === -1 ? raw.length : nextSlash
    }

    if (isEnd) {
      if (charDepth > 0) charDepth -= 1
    } else if (spec && spec.structural) {
      // Structural line marker inside a verse (\p, \q2, \b, \li …) → break.
      const levelMatch = token.match(/(\d+)\*?$/)
      const level = levelMatch ? parseInt(levelMatch[1], 10) : 1
      segments.push({
        kind: "break",
        indent: INDENTED_BREAK_BASES.has(base) ? level : 0,
        blank: base === "b",
        rawStart: start,
        rawEnd: after,
      })
    } else if (spec?.paired) {
      charDepth += 1
    }
    // Non-structural unpaired markers (\fr, \ft outside a note — shouldn't
    // happen, plus unknown markers): token dropped, content kept.
    cursor = after
  }
  pushText(cursor, raw.length)
  return segments
}

/**
 * Plain display text (markers removed, breaks as newlines, notes omitted).
 * For non-React consumers: exports preview, copy, search snippets.
 */
export function usfmDisplayText(raw: string): string {
  const segments = segmentUsfmForDisplay(raw)
  if (segments === null) return raw
  let out = ""
  for (const seg of segments) {
    if (seg.kind === "text") out += seg.text
    else if (seg.kind === "break") out += "\n"
  }
  return out.trim()
}

/**
 * Clip offset-based ranges (computed against the RAW string) to one text
 * segment, shifting them into segment-local coordinates for HighlightedText.
 */
export function clipRangesToSegment<T extends { start: number; end: number }>(
  ranges: readonly T[],
  segment: UsfmTextSegment,
): T[] {
  const out: T[] = []
  for (const r of ranges) {
    const start = Math.max(r.start, segment.rawStart)
    const end = Math.min(r.end, segment.rawEnd)
    if (start < end) {
      out.push({ ...r, start: start - segment.rawStart, end: end - segment.rawStart })
    }
  }
  return out
}

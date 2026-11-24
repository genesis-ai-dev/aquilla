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
 * FORMATTING (AQU-578): unwrapping the token must not throw away the styling
 * it carried. Each text segment reports the visual `marks` in force over it
 * (bold/italic/small-caps/superscript), derived from the stack of open paired
 * character markers, so the source column can render `\bd word\bd*` as bold
 * instead of as plain text. Marks are additive metadata only — `text`,
 * `rawStart`/`rawEnd` and therefore the round-trip guarantee are unchanged.
 *
 * ROUND-TRIP GUARANTEE: this module never rewrites stored text. Every text
 * segment carries its [rawStart, rawEnd) span in the ORIGINAL string, so
 * offset-based annotations (violation ranges) can be clipped per segment via
 * clipRangesToSegment(). Edits flow through the normal commit paths
 * (TranslatedEditor / footnote splice), untouched by this transform.
 */

import { classifyMarker } from "./usfm-markers"

/** Visual inline styling a USFM character marker asks for at display time. */
export type UsfmInlineMark = "bold" | "italic" | "small-caps" | "superscript"

export interface UsfmTextSegment {
  kind: "text"
  /** Verbatim slice raw.slice(rawStart, rawEnd) — never rewritten. */
  text: string
  rawStart: number
  rawEnd: number
  /** Inline marks in force over this run, deduped and in MARK_ORDER. Empty
   *  (the shared NO_MARKS constant) for unstyled runs — the common case. */
  marks: readonly UsfmInlineMark[]
  /** AQU-2184: the raw roles of the paired character markers open over this
   *  run (`usfm-markers.ts` `MarkerSpec.role`), outermost first, after the
   *  innermost `\no` reset — the same window `marks` is derived from. Marks
   *  are the VISUAL reduction and lose roles that carry no styling of their
   *  own; a consumer that must style one of those (`\wj`, words of Jesus, on
   *  the HTML export's page) reads it here. Empty for unmarked runs. */
  roles: readonly string[]
  /** The USFM 3 attribute payload that closed this run, without its `|`:
   *  `lemma="grace" strong="G5485"` for `\w grace|lemma="grace" strong="G5485"\w*`,
   *  or the bare default value (`grace` for `\w gracious|grace\w*`). Never
   *  displayed as text; a reader's view shows it on hover. */
  attributes?: string
}

/** A table cell marker (`\th1`, `\tc2`, `\tcr1`, `\thc1-2` …) has no end
 *  marker: it holds until the next cell or the end of the row. The text after
 *  it carries the role `table:<marker>:<n>`, `n` counting cells in the row, so
 *  a consumer can tell two neighbouring cells apart. */
export const TABLE_ROLE_PREFIX = "table:"
const TABLE_CELL_RE = /^(?:th|thr|thc|tc|tcr|tcc)\d*(?:-\d+)?$/

/** Character-marker role (usfm-markers.ts) → the marks it renders as. Roles
 *  absent here (wordlist-entry, keyword, proper-name, words-of-jesus …) are
 *  semantic, not visual, and carry no styling. `\add` is italic by the usual
 *  English-Bible convention for supplied words. */
const ROLE_MARKS: Record<string, readonly UsfmInlineMark[]> = {
  bold: ["bold"],
  italic: ["italic"],
  emphasis: ["italic"],
  "bold-italic": ["bold", "italic"],
  "translator-addition": ["italic"],
  "small-caps": ["small-caps"],
  "divine-name": ["small-caps"],
  superscript: ["superscript"],
}

/** Stable output order so segments compare equal regardless of nesting order. */
const MARK_ORDER: readonly UsfmInlineMark[] = ["bold", "italic", "small-caps", "superscript"]

const NO_MARKS: readonly UsfmInlineMark[] = Object.freeze([])

const NO_ROLES: readonly string[] = Object.freeze([])

export interface UsfmNoteSegment {
  kind: "note"
  noteKind: "footnote" | "endnote" | "xref"
  /** Caller character ("+" auto, "-" none, or a literal). */
  caller: string
  /** Origin reference from \fr / \xo, e.g. "2:1". */
  ref: string
  /** Marker-stripped note body for popover/panel display. */
  text: string
  /** The same body, split where its own markers change (`\ft`, `\fq`, `\fk`,
   *  `\xt` …), each piece with the marker in force over it, so a reader's view
   *  can set a quotation or a keyword apart. The origin reference is left out,
   *  as in `text`. */
  parts: readonly UsfmNotePart[]
  /** Full raw span "\f + \fr 2:1 \ft …\f*" (for debugging/tests). */
  raw: string
  rawStart: number
  rawEnd: number
}

export interface UsfmNotePart {
  /** Base marker name without level or nesting: "ft", "fq", "xt" … "" before the first one. */
  marker: string
  text: string
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
 *  terminator (\*). Like usfm-tokenize.ts MARKER_RE, plus a level before the
 *  hyphen (\qt1-s, a levelled milestone) and a column span (\tc1-2), so
 *  neither leaves "-s" or "-2" behind as text. */
const MARKER_TOKEN_RE = /\\(?:\+?[a-zA-Z]+\d*(?:-[a-zA-Z0-9]+)*\*?|\*)/g

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
function parseNoteBody(inner: string): { caller: string; ref: string; text: string; parts: UsfmNotePart[] } {
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
  return { caller, ref, text, parts: noteParts(body) }
}

/** Markers inside a note that end at the next one instead of at an end marker. */
const NOTE_SPAN_MARKERS = new Set(["ft", "fq", "fqa", "fk", "fl", "fw", "fp", "xt", "xk", "xq", "xta", "xop"])

function noteParts(body: string): UsfmNotePart[] {
  const parts: UsfmNotePart[] = []
  const re = new RegExp(MARKER_TOKEN_RE.source, "g")
  let span = ""
  const paired: string[] = []
  let cursor = 0
  const push = (to: number) => {
    const text = body.slice(cursor, to).replace(/\|[^\\]*/g, " ").replace(/\s+/g, " ")
    if (text.trim() === "") return
    const marker = paired[paired.length - 1] ?? span
    const last = parts[parts.length - 1]
    if (last && last.marker === marker) last.text += text
    else parts.push({ marker, text })
  }
  let m: RegExpExecArray | null
  while ((m = re.exec(body)) !== null) {
    push(m.index)
    cursor = m.index + m[0].length
    if (m[0] === "\\*") continue
    // The one space after an opening marker is markup, as in the verse itself.
    if (!m[0].endsWith("*") && /\s/.test(body[cursor] ?? "")) cursor += 1
    const base = tokenBase(m[0])
    if (m[0].endsWith("*")) paired.pop()
    else if (NOTE_SPAN_MARKERS.has(base)) { span = base; paired.length = 0 }
    else paired.push(base)
  }
  push(body.length)
  if (parts.length > 0) {
    parts[0].text = parts[0].text.replace(/^\s+/, "")
    parts[parts.length - 1].text = parts[parts.length - 1].text.replace(/\s+$/, "")
  }
  return parts
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
  // Roles of the currently open paired character markers (\w…, \+nd…),
  // innermost last. While any is open, a "|" starts the USFM 3 attribute
  // payload — clipped from display.
  const charStack: string[] = []
  // The table cell open on this row, if any, and how many the row has had.
  let tableRole: string | null = null
  let tableCells = 0

  /** The open roles that still apply. `\no` (role "normal") cancels
   *  everything outside it, so only the roles after the innermost \no count. */
  const activeRoles = (): readonly string[] => {
    if (charStack.length === 0) return tableRole ? [tableRole] : NO_ROLES
    const reset = charStack.lastIndexOf("normal")
    const open = reset === -1 ? charStack : charStack.slice(reset + 1)
    return tableRole ? [tableRole, ...open] : [...open]
  }

  /** Marks in force right now — the visual reduction of `activeRoles()`. */
  const activeMarks = (roles: readonly string[]): readonly UsfmInlineMark[] => {
    if (roles.length === 0) return NO_MARKS
    const found = new Set<UsfmInlineMark>()
    for (const role of roles) {
      for (const mark of ROLE_MARKS[role] ?? NO_MARKS) found.add(mark)
    }
    if (found.size === 0) return NO_MARKS
    return MARK_ORDER.filter((mark) => found.has(mark))
  }

  const pushText = (from: number, to: number) => {
    if (to <= from) return
    let end = to
    let attributes: string | undefined
    if (charStack.length > 0) {
      const pipe = raw.slice(from, to).indexOf("|")
      if (pipe !== -1) {
        end = from + pipe
        attributes = raw.slice(end + 1, to).trim() || undefined
      }
    }
    if (end > from) {
      const roles = activeRoles()
      segments.push({
        kind: "text",
        text: raw.slice(from, end),
        rawStart: from,
        rawEnd: end,
        marks: activeMarks(roles),
        roles,
        ...(attributes ? { attributes } : {}),
      })
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
        const { caller, ref, text, parts } = parseNoteBody(inner)
        segments.push({
          kind: "note", noteKind, caller, ref, text, parts,
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
    const name = token.slice(1)
    if (!isEnd && TABLE_CELL_RE.test(name)) tableRole = `${TABLE_ROLE_PREFIX}${name}:${++tableCells}`

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
      if (charStack.length > 0) charStack.pop()
    } else if (spec && spec.structural) {
      // Structural line marker inside a verse (\p, \q2, \b, \li …) → break.
      const levelMatch = token.match(/(\d+)\*?$/)
      const level = levelMatch ? parseInt(levelMatch[1], 10) : 1
      tableRole = null
      tableCells = 0
      segments.push({
        kind: "break",
        indent: INDENTED_BREAK_BASES.has(base) ? level : 0,
        blank: base === "b",
        rawStart: start,
        rawEnd: after,
      })
    } else if (spec?.paired) {
      charStack.push(spec.role)
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

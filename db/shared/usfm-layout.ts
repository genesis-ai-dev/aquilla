// USFM export with layout (AQU-2559). Runs in the browser and in sync-worker,
// so the live export preview and the downloaded file are one computation.
//
// The lossless serializer treats a verse's raw span as one string and swaps
// the whole of it for the translation. That span runs up to the next `\v`, so
// it also holds the bare `\p` / `\q1` lines that open the NEXT verse's
// paragraph, and a translated verse took them out of the file.
//
// Here a verse span has two parts: its BODY (the words) and its TAIL (trailing
// bare paragraph-marker lines). A translation replaces the body only. The tail
// survives unless the translation says otherwise, in one of two ways:
//
//   - a LEAD on the following verse: leading lines of that verse's translation
//     that are section headings (`\s1 Title`) or bare paragraph markers
//     (`\p`, `\q1`). The lead replaces whatever bare marker lines precede that
//     verse's `\v`. A lead of exactly `\nb` means "no break here".
//   - a tail typed into the translation itself (the older convention: a value
//     copied from the source carries its trailing `\p`).
//
// With no overrides the output is byte-identical to `doc.raw`.
// Decision record: docs/decisions/0010-usfm-target-layout.md

export interface UsfmLayoutSpan {
  ref: string
  text: string
  textStart: number
  textEnd: number
  markerStart: number
}

export interface UsfmLayoutDoc {
  raw: string
  verses: readonly UsfmLayoutSpan[]
  headings: readonly UsfmLayoutSpan[]
}

export interface UsfmLayoutEdits {
  /** Extra text written inside a span, after its own words (app-added lines). */
  appendAfter?: ReadonlyMap<string, readonly string[]>
  /** Refs whose span leaves the file, marker included. */
  remove?: ReadonlySet<string>
}

/** Markers that open a paragraph when they stand alone on a line. `nb` is the
 *  USFM "no break" paragraph; `b` is a blank line. */
export const USFM_PARAGRAPH_MARKERS: ReadonlySet<string> = new Set([
  "p", "m", "nb", "b",
  "q", "q1", "q2", "q3", "q4",
  "qm", "qm1", "qm2", "qc", "qr",
  "pi", "pi1", "pi2", "pi3", "mi",
  "li", "li1", "li2", "li3", "li4",
  "lim", "lim1", "lim2",
  "pc", "pr",
])

/** Heading markers a translation's lead may carry. */
export const USFM_LEAD_HEADING_MARKERS: ReadonlySet<string> = new Set([
  "s", "s1", "s2", "s3", "s4", "ms", "ms1", "ms2", "mr", "sr", "r", "d",
])

export interface UsfmLeadBlock {
  marker: string
  /** Heading text; "" for a bare paragraph marker. */
  text: string
}

export interface UsfmLead {
  blocks: UsfmLeadBlock[]
  /** The value with the lead removed. */
  body: string
}

const LEAD_LINE = /^[ \t]*\\([a-z]+\d*)(?:[ \t]+([^\r\n]*?))?[ \t]*(?:(?:\r?\n)+|$)/

/** Split the leading heading and bare paragraph-marker lines off a translation. */
export function splitUsfmLead(value: string): UsfmLead {
  const blocks: UsfmLeadBlock[] = []
  let rest = value
  while (rest !== "") {
    const m = LEAD_LINE.exec(rest)
    if (!m || m[0].length === 0) break
    const marker = m[1]
    const text = (m[2] ?? "").trim()
    if (text === "" && USFM_PARAGRAPH_MARKERS.has(marker)) blocks.push({ marker, text: "" })
    else if (text !== "" && USFM_LEAD_HEADING_MARKERS.has(marker)) blocks.push({ marker, text })
    else break
    rest = rest.slice(m[0].length)
  }
  return { blocks, body: rest }
}

/** The inverse of `splitUsfmLead`: lead lines, then the body. */
export function composeUsfmLead(blocks: readonly UsfmLeadBlock[], body: string): string {
  const lines = blocks.map((b) => (b.text === "" ? `\\${b.marker}` : `\\${b.marker} ${b.text}`))
  if (lines.length === 0) return body
  return body === "" ? lines.join("\n") : `${lines.join("\n")}\n${body}`
}

/** A lead that only says "this verse does not start a paragraph". */
export function isNoBreakLead(blocks: readonly UsfmLeadBlock[]): boolean {
  return blocks.length === 1 && blocks[0].marker === "nb"
}

const TAIL_LINE = /(^|\n)[ \t]*\\([a-z]+\d*)[ \t]*(\r?\n)?$/

/** Split trailing bare paragraph-marker lines off a verse's text. */
export function splitUsfmTail(text: string): { body: string; tail: string } {
  let body = text
  for (;;) {
    const m = TAIL_LINE.exec(body)
    if (!m || !USFM_PARAGRAPH_MARKERS.has(m[2])) break
    body = body.slice(0, m.index + m[1].length)
    if (body === "") break
  }
  return { body, tail: text.slice(body.length) }
}

const BARE_LINE = /^[ \t]*\\([a-z]+\d*)[ \t]*$/

/** Start of the run of bare paragraph-marker lines that ends at `pos`, not
 *  going back past `min`. Returns `pos` when there is none. */
function bareLinesStart(raw: string, pos: number, min: number): number {
  let start = pos
  while (start > min && raw[start - 1] === "\n") {
    let lineEnd = start - 1
    if (lineEnd > 0 && raw[lineEnd - 1] === "\r") lineEnd--
    const lineStart = raw.lastIndexOf("\n", lineEnd - 1) + 1
    if (lineStart < min) break
    const m = BARE_LINE.exec(raw.slice(lineStart, lineEnd))
    if (!m || !USFM_PARAGRAPH_MARKERS.has(m[1])) break
    start = lineStart
  }
  return start
}

function tailLines(tail: string, eol: string): string {
  const markers = tail.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "")
  return markers.map((l) => l + eol).join("")
}

export type UsfmOutputState = "source" | "translated"

/** Where one span's own text landed in the output. */
export interface UsfmOutputSpan {
  ref: string
  start: number
  end: number
  state: UsfmOutputState
}

export interface UsfmLayoutResult {
  text: string
  spans: UsfmOutputSpan[]
}

/** Serialize with per-span overrides, keeping and applying paragraph layout. */
export function renderUsfmWithLayout(
  doc: UsfmLayoutDoc,
  overrides?: ReadonlyMap<string, string>,
  edits?: UsfmLayoutEdits,
): UsfmLayoutResult {
  const raw = doc.raw
  const eol = raw.includes("\r\n") ? "\r\n" : "\n"
  const verseRefs = new Set(doc.verses.map((v) => v.ref))
  const ordered = [...doc.verses, ...doc.headings].sort((a, b) => a.textStart - b.textStart)

  const parts: string[] = []
  const spans: UsfmOutputSpan[] = []
  let length = 0
  const push = (s: string) => {
    if (s === "") return
    parts.push(s)
    length += s.length
  }

  let cursor = 0
  /** The previous verse's tail, held back until the next span says whether its
   *  lead replaces it. */
  let pendingTail = ""
  /** Raw offset where the previous span's text ended (its tail included). */
  let pendingTailEnd = -1

  for (const s of ordered) {
    const isVerse = verseRefs.has(s.ref)
    if (edits?.remove?.has(s.ref)) {
      push(pendingTail)
      if (s.markerStart >= cursor) push(raw.slice(cursor, s.markerStart))
      cursor = s.textEnd
      pendingTail = isVerse ? splitUsfmTail(s.text).tail : ""
      pendingTailEnd = s.textEnd
      continue
    }

    const override = overrides?.get(s.ref) ?? ""
    const lead = isVerse && override !== "" ? splitUsfmLead(override) : { blocks: [], body: override }
    const rawParts = isVerse ? splitUsfmTail(s.text) : { body: s.text, tail: "" }
    const ownParts = isVerse ? splitUsfmTail(lead.body) : { body: lead.body, tail: "" }

    // The gap before this span: its own marker, and any chapter or bare
    // paragraph lines. A lead replaces the bare lines right before the marker,
    // wherever they are: in this gap, or in the previous verse's tail.
    if (lead.blocks.length > 0) {
      if (pendingTailEnd !== s.markerStart) push(pendingTail)
      const preStart = bareLinesStart(raw, s.markerStart, cursor)
      push(raw.slice(cursor, preStart))
      if (!isNoBreakLead(lead.blocks)) {
        push(lead.blocks.map((b) => (b.text === "" ? `\\${b.marker}` : `\\${b.marker} ${b.text}`) + eol).join(""))
      }
      push(raw.slice(s.markerStart, s.textStart))
    } else {
      push(pendingTail)
      push(raw.slice(cursor, s.textStart))
    }

    const rawTrailing = /\s*$/.exec(rawParts.body)?.[0] ?? ""
    const rawContent = rawParts.body.slice(0, rawParts.body.length - rawTrailing.length)
    const ownContent = ownParts.body.trim()
    const translated = ownContent !== ""
    let content: string
    let trailing = rawTrailing
    if (translated) {
      // `\v 6` directly followed by a newline has no separator of its own.
      const prior = s.textStart > 0 ? raw[s.textStart - 1] : ""
      const sep = prior !== " " && prior !== "\t" && prior !== "\n" && prior !== "\r" ? " " : ""
      content = sep + ownContent
      const nextChar = s.textStart + rawParts.body.length < raw.length ? raw[s.textStart + rawParts.body.length] : ""
      if (trailing === "" && nextChar === "\\") trailing = eol
    } else {
      content = rawContent
    }
    const additions = (edits?.appendAfter?.get(s.ref) ?? []).map((a) => a.trim()).filter((a) => a !== "")
    if (additions.length > 0) content = (content === "" ? "" : content + " ") + additions.join(" ")

    const start = length
    push(content)
    spans.push({ ref: s.ref, start, end: length, state: translated ? "translated" : "source" })
    push(trailing)

    pendingTail = translated && ownParts.tail.trim() !== "" ? tailLines(ownParts.tail, eol) : rawParts.tail
    pendingTailEnd = s.textEnd
    cursor = s.textEnd
  }
  push(pendingTail)
  push(raw.slice(cursor))
  return { text: parts.join(""), spans }
}

export function serializeUsfmWithLayout(
  doc: UsfmLayoutDoc,
  overrides?: ReadonlyMap<string, string>,
  edits?: UsfmLayoutEdits,
): string {
  if (doc.verses.length === 0 && doc.headings.length === 0) return doc.raw
  return renderUsfmWithLayout(doc, overrides, edits).text
}

/** Translated verses whose source words carried markers (footnotes, character
 *  styles, poetry lines inside the verse) that the translation replaces. The
 *  paragraph lines after a verse are not counted: they are kept. */
export function countLossyVersesWithLayout(
  doc: UsfmLayoutDoc,
  overrides: ReadonlyMap<string, string> | undefined,
): number {
  if (!overrides || overrides.size === 0) return 0
  let count = 0
  for (const verse of doc.verses) {
    const override = overrides.get(verse.ref)
    if (!override) continue
    if (splitUsfmTail(splitUsfmLead(override).body).body.trim() === "") continue
    if (/\\./.test(splitUsfmTail(verse.text).body)) count++
  }
  return count
}

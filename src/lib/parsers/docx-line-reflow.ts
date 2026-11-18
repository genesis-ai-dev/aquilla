// InDesign's DOCX export writes each typeset line as its own paragraph, absolutely
// positioned with w:framePr. A sentence then occupies several "paragraphs", and a
// word broken at the line edge ("theol-" / "ogy") becomes two of them. Those lines
// sit one line-step apart in the same column; a real paragraph leaves a larger gap.
// Reflow stacks the lines back into a paragraph, then splits on sentences.

/** A positioned line, or an ordinary paragraph (frame is null). */
export interface TypesetLine {
  plain: string
  html: string
  frame: { x: number; y: number } | null
  /** Page index from `w:br w:type="page"`. y is page-relative, so order is per page. */
  page: number
  style: string | null
  type: "text" | "heading"
  /**
   * Whole-line emphasis. A subheading in these exports is a bold line with no
   * paragraph style, sitting one line-step above the body. Mixed is a body
   * line with an emphasized word, which still wraps into the next line.
   */
  emphasis: "bold" | "plain" | "mixed"
  /** Largest `w:sz` on the line, in half-points. Null when the line has none. */
  fontHalfPoints: number | null
}

/** Same column, in twips. A first-line indent is wider than this. */
const LINE_DX_TWIPS = 100
/**
 * A wrapped line sometimes shifts by about this much (a margin change, not a
 * new column). Only a line that does not already end a sentence may use it,
 * so two stacked citations stay apart.
 */
const LINE_DX_LOOSE_TWIPS = 240
/** One line of body leading. Paragraph gaps in these exports start above the max. */
const LINE_DY_MIN_TWIPS = 150
const LINE_DY_MAX_TWIPS = 450
/**
 * Half-points. Body is 20 and a section title is 36; a footnote is 13.
 * One half-point (a "Week 1" label under a contents line) is the same style.
 */
const FONT_SIZE_BREAK_HALF_POINTS = 6

/**
 * Stems whose trailing hyphen is part of the word (self-salvation, only-begotten),
 * not a line-break hyphen. Syllable breaks such as "ex-" / "istence" are absent
 * on purpose: those hyphens are removed.
 */
const HARD_HYPHEN_STEMS = new Set([
  "self", "only", "high", "pastor", "non", "anti", "semi", "multi", "mid", "half",
  "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
])

const TRAILING_CLOSERS = /((?:<\/[^>]+>)*)$/

/**
 * Reading order for a typeset page. InDesign writes each story in its own
 * order, so a byline that sits under a quote in the layout is stored after
 * every quote. y is page-relative: sort within a page, top to bottom then
 * left to right. A page that also has ordinary paragraphs keeps document
 * order, because those paragraphs have no position to sort by.
 */
export function orderTypesetLines<T extends TypesetLine>(lines: T[]): T[] {
  const pages: T[][] = []
  for (const line of lines) {
    const last = pages[pages.length - 1]
    if (!last || last[0].page !== line.page) pages.push([line])
    else last.push(line)
  }
  return pages.flatMap((page) => {
    if (!page.every((line) => line.frame)) return page
    return page.slice().sort((a, b) => a.frame!.y - b.frame!.y || a.frame!.x - b.frame!.x)
  })
}

export function groupTypesetLines<T extends TypesetLine>(lines: T[]): T[][] {
  const groups: T[][] = []
  for (const line of lines) {
    const current = groups[groups.length - 1]
    const prev = current?.[current.length - 1]
    if (prev && continuesTypesetLine(prev, line)) current.push(line)
    else groups.push([line])
  }
  return groups
}

function continuesTypesetLine(prev: TypesetLine, next: TypesetLine): boolean {
  if (!prev.frame || !next.frame) return false
  if (prev.page !== next.page) return false
  if (prev.type !== next.type || prev.style !== next.style) return false
  // A bold line is a subheading. It must not swallow the body line under it,
  // or be swallowed by the line above. Two bold lines are still one heading.
  if ((prev.emphasis === "bold") !== (next.emphasis === "bold")) return false
  if (
    prev.fontHalfPoints !== null && next.fontHalfPoints !== null
    && Math.abs(prev.fontHalfPoints - next.fontHalfPoints) >= FONT_SIZE_BREAK_HALF_POINTS
  ) return false
  const dx = Math.abs(prev.frame.x - next.frame.x)
  const dy = next.frame.y - prev.frame.y
  if (dy < LINE_DY_MIN_TWIPS || dy > LINE_DY_MAX_TWIPS) return false
  if (dx <= LINE_DX_TWIPS) return true
  return dx <= LINE_DX_LOOSE_TWIPS && !endsSentence(prev.plain)
}

function endsSentence(text: string): boolean {
  const trimmed = text.trim().replace(/["”’']+$/, "")
  return /[.!?]$/.test(trimmed)
}

export function joinTypesetLines(lines: { plain: string; html: string }[]): { plain: string; html: string } {
  let plain = ""
  let html = ""
  for (const line of lines) {
    const nextPlain = line.plain.trim()
    if (!nextPlain) continue
    const nextHtml = line.html.trim()
    if (!plain) {
      plain = nextPlain
      html = nextHtml
      continue
    }
    const decision = lineJoin(plain, nextPlain)
    plain = applyJoin(plain, nextPlain, decision)
    html = applyJoin(html, nextHtml, decision)
  }
  return { plain, html }
}

type LineJoin = "space" | "drop" | "keep"

function lineJoin(prev: string, next: string): LineJoin {
  const trimmed = prev.replace(/\s+$/, "")
  if (trimmed.endsWith("‑")) return "keep"
  if (!endsWithLetterHyphen(trimmed) || !startsWithLowerLetter(next)) return "space"
  return keepLineEndHyphen(trimmed, next) ? "keep" : "drop"
}

function endsWithLetterHyphen(text: string): boolean {
  if (text.length < 2) return false
  const hyphen = text[text.length - 1]
  if (hyphen !== "-" && hyphen !== "‐") return false
  const before = text[text.length - 2]
  return isLetter(before)
}

function startsWithLowerLetter(text: string): boolean {
  return isLetter(text[0] ?? "") && text[0] === text[0].toLowerCase()
}

function isLetter(ch: string): boolean {
  return ch.toLowerCase() !== ch.toUpperCase()
}

function keepLineEndHyphen(prev: string, next: string): boolean {
  const leftToken = prev.split(/\s+/).pop() ?? ""
  const rightToken = next.split(/\s+/)[0] ?? ""
  if (leftToken.slice(0, -1).includes("-") || rightToken.includes("-")) return true
  const stem = leftToken.replace(/^[^A-Za-z]+/, "").replace(/-$/, "").toLowerCase()
  const rightLetters = rightToken.replace(/^[^A-Za-z]+/, "").replace(/[^A-Za-z].*$/, "")
  return HARD_HYPHEN_STEMS.has(stem) && rightLetters.length >= 5
}

function applyJoin(left: string, right: string, decision: LineJoin): string {
  const trimmed = mapTextEnd(left, (core) => core.replace(/\s+$/, ""))
  if (decision === "space") return `${trimmed} ${right}`
  if (decision === "drop") return `${mapTextEnd(trimmed, (core) => core.replace(/[-‐]$/, ""))}${right}`
  return `${trimmed}${right}`
}

function mapTextEnd(value: string, edit: (core: string) => string): string {
  const closers = value.match(TRAILING_CLOSERS)?.[1] ?? ""
  const core = value.slice(0, value.length - closers.length)
  return edit(core) + closers
}

const ABBREVIATIONS = new Set([
  "dr", "mr", "mrs", "ms", "st", "jr", "sr", "rev", "prof", "gen", "gov",
  "vol", "vols", "ch", "chap", "vs", "cf", "eg", "ie", "etc", "no", "nos", "pp", "fig",
  "matt", "mk", "lk", "jn", "rom", "cor", "gal", "eph", "phil", "col", "thess",
  "tim", "tit", "phlm", "heb", "jas", "pet", "jude",
  "exod", "lev", "num", "deut", "josh", "judg", "ruth", "sam", "kgs", "chr",
  "neh", "esth", "ps", "prov", "eccl", "isa", "jer", "lam", "ezek", "dan", "hos",
  "joel", "amos", "obad", "jonah", "mic", "nah", "hab", "zeph", "hag", "zech", "mal",
])

/**
 * One cell per sentence. Unlike `splitIntoSegments`, a short sentence is not packed
 * into the next one and a long sentence is not cut at a comma. A period after an
 * abbreviation, an initial, or before a digit ("Jer. 23") stays inside the sentence.
 */
export function splitTypesetSentences(text: string): string[] {
  const boundary = /(?<=[.!?])\s+/g
  const parts: string[] = []
  let start = 0
  for (const match of text.matchAll(boundary)) {
    const punctIndex = match.index - 1
    if (!isSentenceBoundary(text, punctIndex)) continue
    const sentence = text.slice(start, match.index).trim()
    if (sentence) parts.push(sentence)
    start = match.index + match[0].length
  }
  const tail = text.slice(start).trim()
  if (tail) parts.push(tail)
  return parts
}

function isSentenceBoundary(text: string, punctIndex: number): boolean {
  const punct = text[punctIndex]
  if (punct !== ".") {
    return punct === "!" || punct === "?"
  }
  let i = punctIndex - 1
  while (i >= 0 && /[A-Za-z.]/.test(text[i])) i--
  const word = text.slice(i + 1, punctIndex)
  if (/^[A-Za-z]$/.test(word)) return false
  if (word.includes(".") || ABBREVIATIONS.has(word.toLowerCase())) return false
  let j = punctIndex + 1
  while (j < text.length && /\s/.test(text[j])) j++
  while (j < text.length && /["'“‘«]/.test(text[j])) j++
  const next = text[j]
  if (!next) return true
  return isLetter(next) && next === next.toUpperCase()
}

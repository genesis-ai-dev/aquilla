// Carrying a Word line's inline marks through AI translation (AQU-2539).
//
// A Word line whose source carries bold, italic, underline or strikethrough on
// some of its words has them in `originalHtml` (src/lib/parsers/docx.ts). For
// such a line, and only such a line:
//
//   - the model is given that HTML as the source instead of the plain text
//     (the AQU-2385 tag protection masks its tags like any other inline tag,
//     and the shared instructions already say to preserve inline formatting);
//   - the model's answer is accepted as HTML only when it uses nothing but
//     those marks, properly nested, with no attributes. Then the plain
//     translation is the answer's text and `translatedHtml` is the answer.
//     Otherwise the answer's text, tags removed, is the plain translation and
//     `translatedHtml` is just that text, escaped — nothing of the translation
//     is lost, and no mark is invented.
//
// Every other cell — any other format, a Word line with no marks, a Word line
// whose source was edited after import — is untouched: same prompt source, the
// answer passed through as it is.

const MARK_TAGS: Record<string, "b" | "i" | "u" | "s"> = {
  b: "b", strong: "b", i: "i", em: "i", u: "u", s: "s", strike: "s",
}

export interface MarkedCompletionCell {
  readonly original?: string
  readonly originalHtml?: string
  readonly metadata?: Record<string, unknown> | null
}

/** A cell imported from a Word document's body (its package-block locator). */
function isWordLine(cell: MarkedCompletionCell): boolean {
  const envelope = cell.metadata?.aquillaImport
  if (!envelope || typeof envelope !== "object") return false
  const locator = (envelope as Record<string, unknown>).sourceLocator
  if (!locator || typeof locator !== "object") return false
  const value = locator as Record<string, unknown>
  return value.kind === "package-block" && value.memberPath === "word/document.xml"
}

export interface ParsedMarkedHtml {
  /** The text, tags removed and entities decoded. */
  text: string
  /** The same content, tags normalised to b/i/u/s and text escaped. */
  html: string
  /** True when at least one mark is present. */
  marked: boolean
}

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " }

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
    }
    return NAMED[body] ?? match
  })
}

/** Escaped for the saved HTML; a line break is `<br>`, which the editor keeps
 *  (a raw newline inside HTML would be shown as a space). */
const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\r?\n/g, "<br>")

/**
 * Parse HTML that may hold only inline marks (and `<br>` line breaks). Returns
 * null when it holds any other tag, a tag with attributes, or marks that are
 * not properly nested.
 */
export function parseMarkedHtml(input: string): ParsedMarkedHtml | null {
  const tagRe = /<[^<>]*>/g
  const stack: string[] = []
  let text = ""
  let html = ""
  let marked = false
  let cursor = 0
  let m: RegExpExecArray | null
  while ((m = tagRe.exec(input)) !== null) {
    const between = decodeEntities(input.slice(cursor, m.index))
    text += between
    html += escapeHtml(between)
    cursor = m.index + m[0].length
    if (/^<br\s*\/?>$/i.test(m[0])) {
      text += "\n"
      html += "<br>"
      continue
    }
    const tag = /^<(\/?)([a-zA-Z]+)>$/.exec(m[0])
    const mark = tag ? MARK_TAGS[tag[2].toLowerCase()] : undefined
    if (!tag || !mark) return null
    if (tag[1] === "/") {
      if (stack.pop() !== mark) return null
      html += `</${mark}>`
    } else {
      stack.push(mark)
      html += `<${mark}>`
      marked = true
    }
  }
  if (stack.length > 0) return null
  const tail = decodeEntities(input.slice(cursor))
  return { text: text + tail, html: html + escapeHtml(tail), marked }
}

/** Is this a Word line whose marked source HTML still matches its text? */
function markedSource(cell: MarkedCompletionCell, plainSource: string): string | null {
  if (!cell.originalHtml || !isWordLine(cell)) return null
  const parsed = parseMarkedHtml(cell.originalHtml)
  if (!parsed?.marked || parsed.text !== plainSource) return null
  return cell.originalHtml
}

/** What the model is given as this cell's source. */
export function markedPromptSource(cell: MarkedCompletionCell, fallbackSource: string): string {
  return markedSource(cell, fallbackSource) ?? fallbackSource
}

/** The saved draft for the model's answer: see the header. */
export function normalizeMarkedReply(
  cell: MarkedCompletionCell,
  generated: string,
): { value: string; valueHtml?: string } {
  if (markedSource(cell, cell.original ?? "") === null) return { value: generated }
  // The answer is read as HTML exactly once. Its HTML form is always returned,
  // because the commit runs this again on what it is handed (the HTML when
  // there is one): HTML reads back to the same text, decoded text would not.
  const parsed = parseMarkedHtml(generated.trim())
  if (parsed) return { value: parsed.text, valueHtml: parsed.html }
  const plain = decodeEntities(generated.replace(/<[^<>]*>/g, "")).trim()
  return { value: plain, valueHtml: escapeHtml(plain) }
}

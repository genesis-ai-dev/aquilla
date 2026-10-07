/**
 * Rule underlines for the read-only rich-text SOURCE surface (AQU-1757).
 *
 * The source column has two render paths, and only the plain-text one drew a
 * check's finding:
 *
 *   - plain text → `UsfmSourceText` / `HighlightedText`, given `ranges`;
 *   - inline markup (`cell.originalHtml`, or a source edit's `valueHtml`)
 *     → `SanitizedRichHtml`, which drew key terms (AQU-1135) and nothing else.
 *
 * A hand edit saves the source with HTML, so the moment someone touched a
 * source cell every underline on it vanished for good, while the finding
 * stayed in the Issues tab. Imported formatted cells never had them.
 *
 * The checks compute their spans against the cell's PLAIN source text, not the
 * HTML. This maps those offsets onto the HTML's own text, character by
 * character, and wraps the matching runs in the same spans `HighlightedText`
 * draws. The two texts agree except for whitespace (a `<p>`/`<br>` boundary
 * against "\n", an NBSP against a space) and the odd node the plain text
 * leaves out, so the alignment tolerates whitespace and resynchronises after a
 * short divergence. Every span is then checked against the HTML text it would
 * cover: a span that can't be placed exactly is skipped, never drawn under the
 * wrong characters.
 *
 * Runs after `decorateTermsInHtml` on already-sanitized HTML, for the same
 * reason that does: the sanitizer strips data-* attributes.
 */

import { buildDisplayChunks, rangeSpanClass, type RangeHighlight } from "./rule-ranges"
import { collectText } from "./terminology-html"

/** Marks a finding's span so the surface's delegated handlers can find it. */
export const RULE_RANGE_ATTR = "data-rule-range"

const isSpace = (ch: string) => /\s/.test(ch) || ch === "\u200b"

/** How far ahead a resync looks for the plain text again, in characters. */
const RESYNC_WINDOW = 200
/** How much text has to agree for a resync to count. */
const RESYNC_PROBE = 8

/**
 * For each index of `plain`, the index of the same character in `text`, or -1
 * where it has none. Equal characters map one-to-one; a whitespace character
 * maps to whitespace; extra whitespace on either side is skipped. On any other
 * difference the alignment looks a short way ahead on each side for the plain
 * text to resume, and gives up (leaving the rest unmapped) if it doesn't.
 */
export function alignPlainToText(plain: string, text: string): Int32Array {
  const map = new Int32Array(plain.length).fill(-1)
  let i = 0
  let j = 0
  while (i < plain.length && j < text.length) {
    const a = plain[i]
    const b = text[j]
    if (a === b || (isSpace(a) && isSpace(b))) {
      map[i++] = j++
      continue
    }
    if (isSpace(b)) { j++; continue }
    if (isSpace(a)) { i++; continue }

    // A real difference: something one side has and the other doesn't, such
    // as a footnote marker kept only in the markup. Find where they agree again.
    const probe = plain.slice(i, i + RESYNC_PROBE)
    const ahead = text.indexOf(probe, j + 1)
    if (probe.length === RESYNC_PROBE && ahead !== -1 && ahead - j <= RESYNC_WINDOW) {
      j = ahead
      continue
    }
    const back = text.slice(j, j + RESYNC_PROBE)
    const skipped = plain.indexOf(back, i + 1)
    if (back.length === RESYNC_PROBE && skipped !== -1 && skipped - i <= RESYNC_WINDOW) {
      i = skipped
      continue
    }
    break
  }
  return map
}

const collapse = (s: string) => s.replace(/[\s\u200b]+/g, " ").trim()

/**
 * Place each range (offsets into `plain`) onto `text`. A range is kept only
 * when its first and last characters both map and the text it lands on reads
 * the same as the plain text it came from (whitespace aside).
 */
export function mapRangesToText(
  plain: string,
  text: string,
  ranges: readonly RangeHighlight[],
): RangeHighlight[] {
  if (ranges.length === 0 || !plain || !text) return []
  const map = alignPlainToText(plain, text)
  const out: RangeHighlight[] = []
  for (const range of ranges) {
    const start = Math.max(0, Math.min(plain.length, range.start))
    const end = Math.max(0, Math.min(plain.length, range.end))
    if (start >= end) continue
    const first = map[start]
    const last = map[end - 1]
    if (first < 0 || last < first) continue
    const mapped = { ...range, start: first, end: last + 1 }
    if (collapse(text.slice(mapped.start, mapped.end)) !== collapse(plain.slice(start, end))) continue
    out.push(mapped)
  }
  return out
}

export interface DecorateRuleRangesOptions {
  /** Give each span a button role and a tab stop, for a surface that opens
   *  the finding on click (the source column's inline rule card). */
  clickable?: boolean
}

/**
 * Wrap every finding in `ranges` (offsets into `plain`, the text the checks
 * read) in the same nested spans `HighlightedText` renders. Returns `html`
 * untouched when nothing can be placed.
 */
export function decorateRuleRangesInHtml(
  html: string,
  plain: string,
  ranges: readonly RangeHighlight[] | undefined,
  options: DecorateRuleRangesOptions = {},
): string {
  if (!html || !ranges || ranges.length === 0) return html
  // No DOM (SSR, a worker): render the html plain rather than throw.
  if (typeof document === "undefined") return html

  const root = document.createElement("div")
  root.innerHTML = html
  const { text, entries } = collectText(root)
  const placed = mapRangesToText(plain, text, ranges)
  if (placed.length === 0) return html

  const chunks = buildDisplayChunks(text, placed).filter((chunk) => chunk.ranges.length > 0)
  if (chunks.length === 0) return html

  // Each text node is replaced wholesale, so nodes can be handled in any order.
  for (const entry of entries) {
    const covering = chunks.filter(
      (chunk) => chunk.start < entry.end && chunk.start + chunk.text.length > entry.start,
    )
    if (covering.length === 0) continue

    const value = entry.node.nodeValue ?? ""
    const fragment = document.createDocumentFragment()
    let cursor = 0
    for (const chunk of covering) {
      const from = Math.max(chunk.start, entry.start) - entry.start
      const to = Math.min(chunk.start + chunk.text.length, entry.end) - entry.start
      if (from > cursor) fragment.appendChild(document.createTextNode(value.slice(cursor, from)))
      // Innermost (most severe) first, wrapped outward — `HighlightedText`'s
      // RangeStack, so a stacked finding gets its own underline offset.
      let node: Node = document.createTextNode(value.slice(from, to))
      for (let depth = 0; depth < chunk.ranges.length; depth++) {
        const range = chunk.ranges[chunk.ranges.length - 1 - depth]
        const span = document.createElement("span")
        span.className = rangeSpanClass(range, depth)
        span.setAttribute("data-rule-id", range.ruleId)
        span.setAttribute(RULE_RANGE_ATTR, "")
        if (options.clickable) {
          span.setAttribute("role", "button")
          span.setAttribute("tabindex", "0")
        }
        span.appendChild(node)
        node = span
      }
      fragment.appendChild(node)
      cursor = to
    }
    if (cursor < value.length) fragment.appendChild(document.createTextNode(value.slice(cursor)))
    entry.node.parentNode?.replaceChild(fragment, entry.node)
  }

  return root.innerHTML
}

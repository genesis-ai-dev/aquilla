/**
 * AQU-1102 — applying a term rendering to the target cell.
 *
 * The rule (AQU-204 contract): Apply is a *replace the translator's own
 * selection* action. It is never an "append this word to the translation"
 * action. Before AQU-1102 the caller fell back to appending the rendering when
 * no selection had been captured, which meant a click on a source-column term
 * popover silently rewrote the target cell.
 *
 * `applyRenderingToTarget` encodes that rule as a pure function so the "no
 * selection → no write" case is a value (`null`), not a branch a future caller
 * can forget: a null result MUST NOT be committed.
 *
 * It also preserves the target's rich formatting. The old caller committed the
 * new plain text as both `value` and `valueHtml`, flattening any markup the
 * translator had. Here the replacement is performed against the stored HTML
 * (across text nodes, so a selection spanning markup still works) and the
 * surrounding elements survive.
 */

export interface TermApplyResult {
  value: string
  valueHtml: string
}

interface ApplyRenderingArgs {
  /** Exact target text the translator had selected when Apply was surfaced. */
  selectedText: string
  /** Current target plain text. */
  plain: string
  /** Current target HTML, when the cell has one. */
  html?: string | null
  /** The rendering the translator chose. */
  rendering: string
}

/**
 * Returns the commit payload for an Apply, or `null` when the apply must not
 * write: no captured selection, or the selection is no longer present in the
 * target (it changed underneath us).
 */
export function applyRenderingToTarget({
  selectedText,
  plain,
  html,
  rendering,
}: ApplyRenderingArgs): TermApplyResult | null {
  // No selection → read-only. This is the AQU-1102 guard: never append.
  if (!selectedText || !selectedText.trim()) return null
  if (!plain.includes(selectedText)) return null

  const value = plain.replace(selectedText, rendering)

  // No stored HTML: the cell is plain text, so plain text is the whole truth.
  if (!html) return { value, valueHtml: value }

  const valueHtml = replaceFirstTextOccurrence(html, selectedText, rendering)
  // Selection didn't line up with the HTML's text content (e.g. the markup
  // carries whitespace the plain text doesn't). Rather than flatten the
  // translator's formatting, decline the apply.
  if (valueHtml === null) return null

  return { value, valueHtml }
}

/**
 * Replace the first occurrence of `search` in an HTML fragment's *text*,
 * leaving the surrounding markup intact. Returns `null` when `search` does not
 * occur in the fragment's text content.
 *
 * The match may span several text nodes (a selection that crosses a `<em>`
 * boundary): the replacement lands in the first node touched and the matched
 * remainder is removed from the following ones.
 */
function replaceFirstTextOccurrence(
  html: string,
  search: string,
  replacement: string,
): string | null {
  const container = document.createElement("div")
  container.innerHTML = html

  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  const textNodes: Text[] = []
  let node = walker.nextNode()
  while (node) {
    textNodes.push(node as Text)
    node = walker.nextNode()
  }

  // Offset of each text node within the fragment's concatenated text.
  const combined = textNodes.map((n) => n.data).join("")
  const matchStart = combined.indexOf(search)
  if (matchStart === -1) return null
  const matchEnd = matchStart + search.length

  let cursor = 0
  let replacementWritten = false
  for (const textNode of textNodes) {
    const nodeStart = cursor
    const nodeEnd = cursor + textNode.data.length
    cursor = nodeEnd
    // Untouched by the match.
    if (nodeEnd <= matchStart || nodeStart >= matchEnd) continue

    const localStart = Math.max(0, matchStart - nodeStart)
    const localEnd = Math.min(textNode.data.length, matchEnd - nodeStart)
    const head = textNode.data.slice(0, localStart)
    const tail = textNode.data.slice(localEnd)
    // The rendering goes into the first node the match touches; later nodes
    // just lose their share of the matched text.
    textNode.data = replacementWritten ? head + tail : head + replacement + tail
    replacementWritten = true
  }

  return container.innerHTML
}

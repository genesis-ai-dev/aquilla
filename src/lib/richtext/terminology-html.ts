/**
 * Terminology highlights for the read-only rich-text SOURCE surface.
 *
 * AQU-1135. The source column has two render paths and only one of them knew
 * about managed terms:
 *
 *   - plain text  → `SourceWithTermLookup`, which wraps every match in a
 *     `TermLookupPopover` trigger;
 *   - inline markup (`cell.originalHtml`, or a source edit's `valueHtml`)
 *     → `SanitizedRichHtml`, a bare `dangerouslySetInnerHTML` div.
 *
 * So the moment a cell carried any formatting — every DOCX/HTML/EPUB/Biblica
 * import with a bold word in it, and every cell whose source had been edited —
 * its key terms lost both the highlight and the click target, while the
 * double-click → "View term" path (which reads the browser selection, not the
 * rendered spans) kept working. That asymmetry is the reported bug.
 *
 * This decorates the ALREADY-SANITIZED html with the same
 * `.term-chip-host[data-source-term]` hook `TranslatedEditor` emits for the
 * target lane, so the existing delegated click handler opens the same popover.
 *
 * Running after sanitization is not a preference: `sanitizeSourceDisplayHtml`
 * sets `ALLOW_DATA_ATTR: false`, so a `data-source-term` added before it would
 * be stripped straight back off.
 */

import type { Concept } from "@/lib/terminology/types"
import { findTermMatches } from "@/lib/richtext/terminology-chip-plugin"

/** Class pair the delegated click handler and the shared highlight style key off. */
export const TERM_HIGHLIGHT_CLASS = "term-chip-host terminology-highlight"

/** Tags that end a line of text, so a term may not match across one. */
const BLOCK_TAGS = new Set(["P", "BR", "DIV", "LI", "TR", "TD", "BLOCKQUOTE"])

interface TextEntry {
  node: Text
  /** Offset of this node's text within the flattened document text. */
  start: number
  end: number
}

interface TermMatch {
  start: number
  end: number
  /** The concept's own source term — what the popover looks up. */
  term: string
}

/**
 * Flatten the element's text in document order, recording where each text node
 * landed. A newline is emitted at every block boundary: it is not a letter, so
 * the matcher's word-boundary lookarounds stop a term from spanning two
 * paragraphs, while an inline boundary (`<b>Holy</b> Spirit`) stays matchable.
 */
function collectText(root: HTMLElement): { text: string; entries: TextEntry[] } {
  const entries: TextEntry[] = []
  let text = ""

  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const value = node.nodeValue ?? ""
      if (!value) return
      entries.push({ node: node as Text, start: text.length, end: text.length + value.length })
      text += value
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const isBlock = BLOCK_TAGS.has((node as Element).tagName)
    if (isBlock && text.length > 0 && !text.endsWith("\n")) text += "\n"
    for (const child of Array.from(node.childNodes)) visit(child)
    if (isBlock && text.length > 0 && !text.endsWith("\n")) text += "\n"
  }

  for (const child of Array.from(root.childNodes)) visit(child)
  return { text, entries }
}

/**
 * Longest-first at each offset, then drop anything overlapping a span already
 * taken — the same precedence `SourceWithTermLookup` applies, so "Spirit"
 * inside "Holy Spirit" never splits the phrase.
 */
function findNonOverlappingMatches(text: string, concepts: Concept[]): TermMatch[] {
  const found: TermMatch[] = []
  for (const concept of concepts) {
    for (const m of findTermMatches(text, concept.sourceTerm)) {
      found.push({ ...m, term: concept.sourceTerm })
    }
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end)

  const kept: TermMatch[] = []
  let taken = -1
  for (const m of found) {
    if (m.start < taken) continue
    kept.push(m)
    taken = m.end
  }
  return kept
}

export interface DecorateTermsOptions {
  /**
   * Accessible name for one highlight, e.g. `Managed term: grace`. Supplied by
   * the component so the string comes from i18n rather than this module.
   * Without it the highlight stays a plain span: announcing an unnamed button
   * to a screen reader is worse than announcing nothing.
   */
  label?: (term: string) => string
}

/**
 * Wrap every active-concept match in `html` with the terminology highlight.
 * Returns `html` untouched when there is nothing to do, so an unformatted or
 * term-free cell pays no cost and no markup churn.
 */
export function decorateTermsInHtml(
  html: string,
  concepts: Concept[] | undefined,
  options: DecorateTermsOptions = {},
): string {
  if (!html) return ""
  const active = (concepts ?? []).filter((c) => c.status === "active")
  if (active.length === 0) return html
  // No DOM (SSR, a worker) → render the sanitized html plain rather than throw.
  // Losing a highlight is recoverable; losing the source text is not.
  if (typeof document === "undefined") return html

  const root = document.createElement("div")
  root.innerHTML = html

  const { text, entries } = collectText(root)
  if (!text) return html

  const matches = findNonOverlappingMatches(text, active)
  if (matches.length === 0) return html

  // Each text node is replaced wholesale, so nodes can be handled in any order.
  for (const entry of entries) {
    const segments = matches
      .filter((m) => m.start < entry.end && m.end > entry.start)
      .map((m) => ({
        start: Math.max(m.start, entry.start) - entry.start,
        end: Math.min(m.end, entry.end) - entry.start,
        term: m.term,
      }))
      .sort((a, b) => a.start - b.start)
    if (segments.length === 0) continue

    const value = entry.node.nodeValue ?? ""
    const fragment = document.createDocumentFragment()
    let cursor = 0
    for (const segment of segments) {
      if (segment.start > cursor) {
        fragment.appendChild(document.createTextNode(value.slice(cursor, segment.start)))
      }
      const mark = document.createElement("span")
      mark.className = TERM_HIGHLIGHT_CLASS
      // The concept's term, not the matched text: a wildcard concept (`grac*`)
      // must look itself up, not the inflection that happened to match.
      mark.setAttribute("data-source-term", segment.term)
      if (options.label) {
        // Keyboard parity with the target-lane chips: reachable by Tab and
        // activated by Enter/Space through the caller's delegated handler.
        mark.setAttribute("role", "button")
        mark.setAttribute("tabindex", "0")
        mark.setAttribute("aria-label", options.label(segment.term))
      }
      mark.textContent = value.slice(segment.start, segment.end)
      fragment.appendChild(mark)
      cursor = segment.end
    }
    if (cursor < value.length) {
      fragment.appendChild(document.createTextNode(value.slice(cursor)))
    }
    entry.node.parentNode?.replaceChild(fragment, entry.node)
  }

  return root.innerHTML
}

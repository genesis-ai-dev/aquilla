import type { InfractionSpan } from "@/lib/parsers/types"
import { diffInlineMarkers, usfmSpanToHtml } from "@/lib/parsers/usfm-html"

export const MESSAGE =
  "Source inline markup (formatting or footnote) is missing from the translation"

/** Extra context the rule engine threads in for HTML-aware checks. Plain-text
 *  checks ignore it. */
export interface BuiltinCheckContext {
  /** Source cell's rich-text HTML (`cells.value_html`). */
  sourceHtml?: string
  /** Target cell's rich-text HTML. */
  targetHtml?: string
}

/** Locate the Nth `\marker` opening in raw USFM, skipping its `\marker*` close
 *  and longer markers that merely share the prefix. */
function nthMarkerSpan(source: string, name: string, occurrence: number): InfractionSpan | null {
  const re = new RegExp(`\\\\${name}(?![\\w*])`, "g")
  let i = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(source)) !== null) {
    if (i === occurrence && m.index !== undefined) {
      return { side: "source", start: m.index, end: m.index + m[0].length, matchedText: `\\${name}` }
    }
    i++
  }
  return null
}

/**
 * Flags inline markup the source carries but the translation dropped — both
 * character formatting (`\nd`, `\bd`, `\wj`…) and notes (`\f`, `\x`). Block
 * structure is owned by the side-car and is NOT checked here. Spans point at the
 * source markers; the editor additionally underlines the mismatched styling in
 * the rendered source. Formatting is auto-restorable; footnotes are flag-only.
 */
export function runCheck(
  source: string,
  target: string,
  ctx?: BuiltinCheckContext,
): InfractionSpan[] | null {
  // Prefer the rich HTML on both sides; derive from raw source if absent so the
  // check still works for callers that only have plain text.
  const sourceHtml = ctx?.sourceHtml ?? usfmSpanToHtml(source)
  const targetHtml = ctx?.targetHtml ?? target
  const diff = diffInlineMarkers(sourceHtml, targetHtml)
  const missing = [...diff.missingFormat, ...diff.missingNote]
  if (missing.length === 0) return null

  const spans: InfractionSpan[] = []
  const cursor = new Map<string, number>()
  for (const name of missing) {
    const occ = cursor.get(name) ?? 0
    cursor.set(name, occ + 1)
    const span = nthMarkerSpan(source, name, occ)
    if (span) spans.push(span)
  }
  // The drift is real even if we couldn't pin a raw-source offset (e.g. source
  // had only HTML formatting, no backslash markers) — surface it anyway.
  if (spans.length === 0) {
    spans.push({ side: "source", start: 0, end: 0, matchedText: missing.map((n) => `\\${n}`).join(" ") })
  }
  return spans
}

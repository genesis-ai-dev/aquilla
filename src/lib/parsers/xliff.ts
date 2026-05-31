/**
 * XLIFF 1.2 and 2.0 bilingual importer.
 *
 * Spec refs:
 *   XLIFF 1.2: https://docs.oasis-open.org/xliff/xliff-core/xliff-core.html
 *   XLIFF 2.0: https://docs.oasis-open.org/xliff/xliff-core/v2.0/xliff-core-v2.0.html
 *
 * Inline markup (g, x, bpt, ept, ph, it, mrk in 1.2; pc, ph, sc, ec, sm, em
 * in 2.0) is stripped to plain text — the underlying text content is preserved.
 *
 * SWARM-TODO(import): preserve inline-tag structure for round-trip fidelity;
 *   currently stripped to text only.
 * SWARM-TODO(import): handle multi-segment units in XLIFF 2.0 (multiple
 *   <segment> children) — currently concatenated with a space separator.
 * XLIFF 2.0 <ignorable> spans (whitespace-only inter-segment content that
 *   should not be translated) are now skipped.
 * Multi-segment XLIFF 2.0 <unit> elements are now emitted as one
 *   TranslatableString per <segment> rather than concatenated, preserving
 *   segment granularity for review.  Inline tags (g/x/pc/bpt etc.) are still
 *   stripped to plain text — the underlying text content is preserved.
 */

import { v4 as uuid } from "uuid"
import type { TranslatableString } from "./types"

// ─── helpers ────────────────────────────────────────────────────────────────

/**
 * Recursively extract text content from an Element, ignoring tag names.
 * This correctly handles CDATA sections (which DOMParser merges into text
 * nodes) and nested inline markup.
 */
function textContent(el: Element): string {
  return el.textContent ?? ""
}

/**
 * Deep-first query: find the first element with this local name anywhere
 * inside `root`.
 */
function findByLocalName(root: Element, localName: string): Element | null {
  if (root.localName === localName) return root
  for (const child of Array.from(root.children)) {
    const found = findByLocalName(child, localName)
    if (found) return found
  }
  return null
}

/**
 * Collect all elements with a given local name anywhere under `root`.
 */
function allByLocalName(root: Element, localName: string): Element[] {
  const out: Element[] = []
  function walk(el: Element) {
    if (el.localName === localName) out.push(el)
    for (const child of Array.from(el.children)) walk(child)
  }
  walk(root)
  return out
}

// ─── XLIFF 1.2 ──────────────────────────────────────────────────────────────

/**
 * Parse XLIFF 1.2 documents.
 *
 * Structure: <xliff> → <file> → <body> → <trans-unit> → <source> + <target>
 * The `id` attribute on <trans-unit> is the stable cell identifier.
 */
function parseXliff12(doc: Document): TranslatableString[] {
  const results: TranslatableString[] = []

  const transUnits = allByLocalName(doc.documentElement, "trans-unit")

  for (const tu of transUnits) {
    const id = tu.getAttribute("id") || uuid()

    const sourceEl = findByLocalName(tu, "source")
    const targetEl = findByLocalName(tu, "target")

    const original = sourceEl ? textContent(sourceEl).trim() : ""
    const translated = targetEl ? textContent(targetEl).trim() : ""

    // <note> becomes context if present
    const noteEl = findByLocalName(tu, "note")
    const context = noteEl ? textContent(noteEl).trim() : id

    // Group context from nearest ancestor <group> id
    let group = id
    let cursor: Element | null = tu.parentElement
    while (cursor) {
      if (cursor.localName === "group") {
        group = cursor.getAttribute("id") || group
        break
      }
      cursor = cursor.parentElement
    }

    if (!original) continue  // skip empty source segments

    results.push({
      id: uuid(),
      original,
      translated,
      context,
      group,
      type: "text",
    })
  }

  return results
}

// ─── XLIFF 2.0 ──────────────────────────────────────────────────────────────

/**
 * Parse XLIFF 2.0 documents.
 *
 * Structure: <xliff> → <file> → <unit> → <segment|ignorable> → <source> + <target>
 *
 * Each <segment> child of a <unit> becomes its own TranslatableString keyed by
 * the segment's own id (falling back to "<unitId>/<index>").  This preserves
 * segment granularity so reviewers can address individual sentences rather than
 * a concatenated blob.
 *
 * <ignorable> children (inter-segment whitespace that must not be translated)
 * are skipped entirely.
 *
 * Units that have source/target directly (no <segment> wrapper) still work —
 * they produce one TranslatableString for the whole unit.
 */
function parseXliff20(doc: Document): TranslatableString[] {
  const results: TranslatableString[] = []

  const units = allByLocalName(doc.documentElement, "unit")

  for (const unit of units) {
    const unitId = unit.getAttribute("id") || uuid()

    // <notes> → <note> as context (shared across segments)
    const notesEl = findByLocalName(unit, "notes")
    const noteEl = notesEl ? findByLocalName(notesEl, "note") : null
    const unitContext = noteEl ? textContent(noteEl).trim() : unitId

    // Collect direct children that are <segment> or <ignorable>.
    // We use direct children only to avoid descending into nested units.
    const directChildren = Array.from(unit.children)
    const segmentEls = directChildren.filter((c) => c.localName === "segment")
    // <ignorable> children are intentionally skipped (not pushed to results).

    if (segmentEls.length > 0) {
      // Emit one TranslatableString per <segment> (preserves granularity).
      let segIndex = 0
      for (const seg of segmentEls) {
        segIndex++
        const segId = seg.getAttribute("id") || `${unitId}/${segIndex}`
        const srcEl = findByLocalName(seg, "source")
        const tgtEl = findByLocalName(seg, "target")
        const original = srcEl ? textContent(srcEl).trim() : ""
        if (!original) continue
        const translated = tgtEl ? textContent(tgtEl).trim() : ""
        results.push({
          id: uuid(),
          original,
          translated,
          context: unitContext,
          group: unitId,
          type: "text",
          // Expose segment id for downstream deduplication / round-trip matching.
          sourceLocation: { file: unitId, blockPath: segId },
        })
      }
    } else {
      // Fallback: unit has source/target directly (no <segment> wrapper).
      const directSource = findByLocalName(unit, "source")
      const directTarget = findByLocalName(unit, "target")
      if (!directSource) continue
      const original = textContent(directSource).trim()
      if (!original) continue
      const translated = directTarget ? textContent(directTarget).trim() : ""
      results.push({
        id: uuid(),
        original,
        translated,
        context: unitContext,
        group: unitId,
        type: "text",
      })
    }
  }

  return results
}

// ─── entry point ────────────────────────────────────────────────────────────

/**
 * Replace CDATA sections with their XML-escaped text equivalents so that
 * DOMParser environments with limited CDATA support (e.g. happy-dom in tests)
 * can still parse the document correctly.
 *
 * The standard browser DOMParser handles CDATA natively, but this pre-pass
 * ensures we work everywhere without silent data loss.
 */
function normalizeCdata(xml: string): string {
  return xml.replace(/<!\[CDATA\[([\s\S]*?)]]>/g, (_match, content: string) => {
    return content
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
  })
}

/**
 * Parse an XLIFF 1.2 or 2.0 file. Autodetects version from the `version`
 * attribute on the root <xliff> element; defaults to 1.2 heuristics when
 * the attribute is missing.
 *
 * Runs in the browser — uses the global `DOMParser`.
 */
export function parseXliff(xmlText: string): TranslatableString[] {
  const parser = new DOMParser()
  const doc = parser.parseFromString(normalizeCdata(xmlText), "application/xml")

  // Check for parse errors (the browser wraps them in a <parsererror> element)
  const parseError = doc.querySelector("parsererror")
  if (parseError) {
    throw new Error(`XLIFF parse error: ${parseError.textContent?.slice(0, 200)}`)
  }

  const root = doc.documentElement
  const version = root.getAttribute("version") || "1.2"

  if (version.startsWith("2")) {
    return parseXliff20(doc)
  }
  return parseXliff12(doc)
}

/**
 * Footnote extraction from cell text.
 *
 * Supports USFM \f...\f* inline footnotes that are preserved verbatim inside
 * verse text by the lossless parser (usfm-lossless.ts). The raw markers are
 * stored in cell.original / cell.translated; this module parses them for
 * display without mutating the stored text.
 *
 * Round-trip guarantee: extraction is READ-ONLY. The source text is never
 * rewritten here. Edits go back via the same path as any other cell edit
 * (TranslatedEditor → emitTargetCellCommit), preserving the \f...\f* markers
 * that the lossless serializer needs for export round-trip.
 *
 * Formats supported for inline display:
 *   - USFM: \f + \fr ref \ft text \f*  (and \fq, \fqa, \fk, \fl variants)
 *   - NOT DOCX (no footnote AST survives the current docx.ts parser). See
 *     TRACE comment at bottom of this file.
 */

export interface ExtractedFootnote {
  /** Index within the cell text (identifies position for later editing). */
  index: number
  /** The full raw marker span: "\f + \fr 1:1 \ft Some note\f*" */
  raw: string
  /** The caller character (e.g. "+", "-", "a"). */
  caller: string
  /** Verse reference from \fr, if present. */
  ref: string
  /** Translatable footnote text: concatenation of \ft, \fq, \fqa, \fk, \fl content. */
  text: string
}

/**
 * USFM footnote regex: matches \f CALLER [\fr REF ] [\ft TEXT ] ... \f*
 * The regex is intentionally non-greedy and handles multi-field notes.
 * Inline (mid-line) form only — the lossless parser keeps them inside verse text.
 */
const USFM_FOOTNOTE_RE = /\\f\s+([^\s\\]+)([\s\S]*?)\\f\*/g

/**
 * Extract USFM footnotes from a cell text string.
 * Returns an empty array for text with no \f...\f* spans.
 */
export function extractUsfmFootnotes(text: string): ExtractedFootnote[] {
  const results: ExtractedFootnote[] = []
  let m: RegExpExecArray | null
  const re = new RegExp(USFM_FOOTNOTE_RE.source, "g")

  while ((m = re.exec(text)) !== null) {
    const raw = m[0]
    const caller = m[1].trim()
    const body = m[2] ?? ""

    const fields = parseFootnoteFields(body)
    const ref = fields.find((field) => field.name === "fr")?.value.trim() ?? ""

    // Collect all translatable content fields in order: \ft \fq \fqa \fk \fl.
    // Values may contain nested character markers like \bd...\bd*, so the
    // parser stops only at the next footnote field marker, not every backslash.
    const textParts = fields
      .filter((field) => field.name !== "fr")
      .map((field) => field.value.trim())
      .filter(Boolean)
    const footnoteText = textParts.join(" ").trim()

    results.push({
      index: m.index,
      raw,
      caller,
      ref,
      text: footnoteText || body.trim(),
    })
  }

  return results
}

function parseFootnoteFields(body: string): Array<{ name: string; value: string }> {
  const fieldRe = /\\(fr|ft|fq|fqa|fk|fl)\s+/g
  const matches = Array.from(body.matchAll(fieldRe))
  const fields: Array<{ name: string; value: string }> = []
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i]
    const name = match[1]
    const valueStart = match.index + match[0].length
    const valueEnd = matches[i + 1]?.index ?? body.length
    fields.push({ name, value: body.slice(valueStart, valueEnd) })
  }
  return fields
}

/**
 * True when the given text contains at least one USFM footnote marker.
 * Cheap check — does not fully parse.
 */
export function hasUsfmFootnotes(text: string): boolean {
  return /\\f\s/.test(text)
}

// TRACE FRO-317: DOCX footnote round-trip is NOT yet safe.
//
// The current docx.ts parser (src/lib/parsers/docx.ts) uses mammoth.js
// to convert Word XML to HTML; footnotes are present in word/footnotes.xml
// but mammoth drops them from the main body HTML. There is no \f...\f* or
// equivalent anchor in the cell text that would survive re-serialization.
//
// To enable DOCX footnote editing safely, the importer would need to:
//  1. Parse word/footnotes.xml alongside word/document.xml
//  2. Insert a synthetic footnote marker (e.g. [[fn:1]]) at the anchor point
//     in the cell text during import
//  3. On export, map synthetic markers back to w:footnoteReference elements
//     in the serialized .docx
//
// Until that is built, DOCX footnotes are silently omitted from the
// inline-footnotes panel. Display for DOCX cells shows a safe "no footnotes
// in this format" message rather than partial/wrong data.

// AQU-1472: the paragraph rules of the structured plain-text export, in one
// alias-free leaf so the SPA exporter (exporters/plaintext.ts) and the
// sync-worker's `.txt` export route build the same bytes from the same cells.
// sync-worker's tsconfig has no `@/` paths, so this file imports nothing.

/** What one cell contributes to a structured plain-text export. */
export interface PlainTextStructuredCell {
  /** Current target text for the exported lane; empty when untranslated. */
  translated: string
  /** The cell's semantic source text (see `semanticSourceText`). */
  source: string
  /** Paragraph key: cells sharing a non-empty group rejoin into one paragraph. */
  group: string
}

/**
 * Cells that share a `group` are sub-segments of one source paragraph (see
 * splitIntoSegments in the plaintext importer) and are rejoined with a space;
 * paragraphs are separated by a blank line, matching the importer's
 * blank-line paragraph split so import→export→import is stable. Untranslated
 * cells fall back to source (Matecat-style draft export).
 */
export function plainTextStructuredBody(cells: Iterable<PlainTextStructuredCell>): string {
  const paragraphs: string[] = []
  let currentGroup: string | null = null
  for (const c of cells) {
    const text = (c.translated || c.source || "").trim()
    if (!text) continue
    if (c.group && c.group === currentGroup && paragraphs.length > 0) {
      paragraphs[paragraphs.length - 1] += ` ${text}`
    } else {
      paragraphs.push(text)
      currentGroup = c.group || null
    }
  }
  return paragraphs.length ? `${paragraphs.join("\n\n")}\n` : ""
}

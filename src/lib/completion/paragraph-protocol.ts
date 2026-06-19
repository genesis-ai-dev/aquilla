// Paragraph draft output protocol (F1 foundation, D11).
// Encodes source cells as cell-id-keyed tags for the draft prompt and
// parses model responses back to per-cell text — loudly, no silent drops.

export interface ParagraphSegment {
  cellId: string
  text: string
}

/**
 * Render source cells as `<c id="CELLID">TEXT</c>` tags, one per line.
 * The resulting string is intended for inclusion in a draft prompt so the
 * model knows which cell id each source segment belongs to.
 */
export function encodeParagraphCells(cells: { cellId: string; text: string }[]): string {
  return cells.map(({ cellId, text }) => `<c id="${cellId}">${text}</c>`).join("\n")
}

export interface ParseResult {
  /** Expected cells found in the response, in EXPECTED (not response) order. */
  mapped: ParagraphSegment[]
  /** Expected cell ids with no matching tag in the response. */
  missing: string[]
  /** Tag ids present in the response that were not expected. */
  extra: string[]
}

// Matches <c id="CELLID">TEXT</c> where TEXT may span multiple lines.
// The `s` (dotAll) flag lets `.` match newlines inside the tag body.
const TAG_RE = /<c\s+id="([^"]+)">([\s\S]*?)<\/c>/g

/**
 * Parse a model response containing `<c id="CELLID">TEXT</c>` tags back to
 * per-cell text. Reconciles LOUDLY (D11): every expected id is accounted for
 * in either `mapped` or `missing`; every unexpected id surfaces in `extra`.
 *
 * `mapped` is returned in EXPECTED order (the order of `expectedCellIds`).
 * TEXT content is trimmed of surrounding whitespace but internal newlines
 * are preserved.
 */
export function parseParagraphResponse(text: string, expectedCellIds: string[]): ParseResult {
  // Collect all tags found in the response.
  const found = new Map<string, string>()
  let match: RegExpExecArray | null
  TAG_RE.lastIndex = 0
  while ((match = TAG_RE.exec(text)) !== null) {
    const [, id, content] = match
    // Trim surrounding whitespace but preserve internal newlines.
    found.set(id, content.trim())
  }

  const expectedSet = new Set(expectedCellIds)

  // Determine extra: ids in the response not in the expected set.
  const extra: string[] = []
  for (const id of found.keys()) {
    if (!expectedSet.has(id)) extra.push(id)
  }

  // Build mapped and missing in expected order.
  const mapped: ParagraphSegment[] = []
  const missing: string[] = []
  for (const cellId of expectedCellIds) {
    if (found.has(cellId)) {
      mapped.push({ cellId, text: found.get(cellId)! })
    } else {
      missing.push(cellId)
    }
  }

  return { mapped, missing, extra }
}

// Paragraph-grouping model (F1 foundation, D1).
// Pure module — no side effects, no imports.

export interface ParagraphCell {
  id: string
  fileId: string
  /** D1: true on the first cell of a paragraph block. Absent/false = continuation. */
  paragraphStart?: boolean
}

/**
 * Derive paragraph groups from a flat ordered list of cells.
 *
 * Rules (D1):
 *   - The very first cell always begins a new group.
 *   - Any cell with `paragraphStart === true` begins a new group.
 *   - A file-boundary (fileId changes) always begins a new group, even
 *     without `paragraphStart`.
 *
 * Returns an array of groups; each group is an ordered array of cell ids.
 * Empty input → [].
 */
export function deriveParagraphs(cells: ParagraphCell[]): string[][] {
  if (cells.length === 0) return []

  const groups: string[][] = []
  let current: string[] = []

  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i]
    const prev = cells[i - 1]
    const isFirst = i === 0
    const fileBoundary = !isFirst && cell.fileId !== prev.fileId
    const explicitStart = cell.paragraphStart === true

    if (isFirst || fileBoundary || explicitStart) {
      if (current.length > 0) groups.push(current)
      current = [cell.id]
    } else {
      current.push(cell.id)
    }
  }

  if (current.length > 0) groups.push(current)
  return groups
}

/**
 * Return the full ordered list of cell ids in the same paragraph as `cellId`
 * (same file). Returns [] when `cellId` is not found in `cells`.
 */
export function paragraphGroupForCell(cells: ParagraphCell[], cellId: string): string[] {
  const groups = deriveParagraphs(cells)
  // Build a lookup: cellId → group index
  for (const group of groups) {
    if (group.includes(cellId)) return group
  }
  return []
}

// Left-context for a draft is the COMMITTED TARGET of the immediately preceding
// cells, not their source: this is what gives real discourse flow — connectives
// and participant reference that follow what was actually said in the target
// language. v1 measures the budget in CELL COUNT (not tokens) to avoid a tokenizer
// dependency; a token budget is a later refinement.
// See docs/superpowers/specs/2026-06-18-paragraph-drafting-retrieval-context-design.md (D4, D10).

export interface DraftContextSettings {
  /** How many preceding committed-target cells (same file, document order) to
   *  include as left-context. v1 unit is cell count; token budget is deferred. */
  precedingTargetCells: number
}

export const DEFAULT_DRAFT_CONTEXT: DraftContextSettings = {
  precedingTargetCells: 3,
}

type MinimalCell = { id: string; fileId: string; original: string; translated: string }

/**
 * Collect the committed target of up to `count` cells immediately preceding
 * `cellId` within the SAME file, in document order. Cells with an empty target
 * are skipped (nothing to learn from). `cells` is assumed to be in document order
 * (the order useCells/useProject already returns rows in).
 */
export function gatherPrecedingContext(
  cells: MinimalCell[],
  cellId: string,
  count: number,
): { source: string; target: string }[] {
  if (count <= 0) return []
  const idx = cells.findIndex((c) => c.id === cellId)
  if (idx === -1) return []
  const fileId = cells[idx].fileId

  const out: { source: string; target: string }[] = []
  for (let i = idx - 1; i >= 0 && out.length < count; i--) {
    const c = cells[i]
    if (c.fileId !== fileId) break // do not cross a file boundary
    if (!c.original.trim() || !c.translated.trim()) continue
    out.push({ source: c.original, target: c.translated })
  }
  return out.reverse() // restore document order (oldest → newest)
}

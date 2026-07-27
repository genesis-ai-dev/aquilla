// Left-context for a draft is the APPROVED TARGET of the immediately preceding
// cells, not their source: this is what gives real discourse flow — connectives
// and participant reference that follow what was actually said in the target
// language. v1 measures the budget in CELL COUNT (not tokens) to avoid a tokenizer
// dependency; a token budget is a later refinement.
// See docs/superpowers/specs/2026-06-18-paragraph-drafting-retrieval-context-design.md (D4, D10).

import { effectiveSourceText } from "@/lib/cell-text"

export interface DraftContextSettings {
  /** How many preceding approved-target cells (same file, document order) to
   *  include as left-context. v1 unit is cell count; token budget is deferred. */
  precedingTargetCells: number
}

export const DEFAULT_DRAFT_CONTEXT: DraftContextSettings = {
  precedingTargetCells: 3,
}

type MinimalCell = {
  id: string
  fileId: string
  original: string
  translated: string
  status: string
  // SUB-28: media sections source from their transcript.
  medium?: import("@/lib/sync/cells-read-types").SegmentMedium | null
  transcription?: string
}

/**
 * Collect the approved target of up to `count` cells immediately preceding
 * `cellId` within the SAME file, in document order. Cells with an empty target
 * are skipped (nothing to learn from). `cells` is assumed to be in document order
 * (the order useCells/useProject already returns rows in).
 */
export function gatherPrecedingContext(
  cells: MinimalCell[],
  cellId: string,
  count: number,
  // D4 source-fallback: when true, a preceding cell that has source but no
  // approved target yet is still included (target stays ""), so the first
  // paragraphs get SOME discourse context instead of none. Off by default — the
  // shipped single-cell path keeps approved-target-only behavior; the paragraph
  // draft path opts in. See spec (D4), the deferred-to-Phase-1 note.
  sourceFallback = false,
): { source: string; target: string }[] {
  if (count <= 0) return []
  const idx = cells.findIndex((c) => c.id === cellId)
  if (idx === -1) return []
  const fileId = cells[idx].fileId

  const out: { source: string; target: string }[] = []
  for (let i = idx - 1; i >= 0 && out.length < count; i--) {
    const c = cells[i]
    if (c.fileId !== fileId) break // do not cross a file boundary
    // SUB-28: media sections source from their transcript (empty until ASR).
    const src = effectiveSourceText(c)
    if (!src.trim()) continue // no source → nothing to show
    const approvedTarget = c.status === "validated" && c.translated.trim()
      ? c.translated
      : ""
    if (!approvedTarget && !sourceFallback) continue
    // Unapproved target text is never prompt context. In paragraph fallback
    // mode its source may still provide discourse information.
    out.push({ source: src, target: approvedTarget })
  }
  return out.reverse() // restore document order (oldest → newest)
}

/**
 * Collect the SOURCE of up to `count` cells immediately FOLLOWING `cellId`
 * within the SAME file, in document order. This is the right side of the
 * discourse window (D4): source only — the following cells are not drafted yet,
 * so there is no target. Cells with no source are skipped. Returns [] for
 * count <= 0 or an unknown cellId.
 */
export function gatherFollowingSource(
  cells: MinimalCell[],
  cellId: string,
  count: number,
): { source: string }[] {
  if (count <= 0) return []
  const idx = cells.findIndex((c) => c.id === cellId)
  if (idx === -1) return []
  const fileId = cells[idx].fileId

  const out: { source: string }[] = []
  for (let i = idx + 1; i < cells.length && out.length < count; i++) {
    const c = cells[i]
    if (c.fileId !== fileId) break // do not cross a file boundary
    const src = effectiveSourceText(c)
    if (!src.trim()) continue
    out.push({ source: src })
  }
  return out // already in document order (forward scan)
}

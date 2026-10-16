// Left-context for a draft is the TARGET of the immediately preceding cells
// (approved, or labelled as an unreviewed draft), not their source: this is
// what gives real discourse flow — connectives
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
  precedingTargetCells: 5,
}

/** One discourse-window row; `draft` marks an unreviewed target. */
export type PrecedingWindowEntry = { source: string; target: string; draft?: boolean }

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
 * Collect the target of up to `count` cells immediately preceding `cellId`
 * within the SAME file, in document order. Cells with an empty target are
 * skipped (nothing to learn from). `cells` is assumed to be in document order
 * (the order useCells/useProject already returns rows in).
 *
 * A preceding target that is not validated is still returned, marked `draft`,
 * so the prompt labels it as unreviewed. The discourse window carries state
 * the next cell depends on — an open quotation, who "he" is, a clause left
 * hanging — and a draft is the only record of that state until someone
 * validates it. Without it, a speech drafted across John 6:26–27 opens in
 * v.26 and never closes in v.27. Drafts never become retrieval EXAMPLES:
 * `selectApprovedExamples` excludes every discourse-window source.
 *
 * `skipIds` drops cells whose text is about to be superseded (a batch run's
 * own cells, whose fresh drafts arrive via `mergeInRunDraftContext`), so a
 * stale persisted draft cannot sit next to its replacement.
 */
export function gatherPrecedingContext(
  cells: MinimalCell[],
  cellId: string,
  count: number,
  // D4 source-fallback: when true, a preceding cell that has source but no
  // target yet is still included (target stays ""), so the first paragraphs
  // get SOME discourse context instead of none. Off by default — the shipped
  // single-cell path skips untranslated cells; the paragraph draft path opts
  // in. See spec (D4), the deferred-to-Phase-1 note.
  sourceFallback = false,
  skipIds?: ReadonlySet<string>,
): PrecedingWindowEntry[] {
  if (count <= 0) return []
  const idx = cells.findIndex((c) => c.id === cellId)
  if (idx === -1) return []
  const fileId = cells[idx].fileId

  const out: PrecedingWindowEntry[] = []
  for (let i = idx - 1; i >= 0 && out.length < count; i--) {
    const c = cells[i]
    if (c.fileId !== fileId) break // do not cross a file boundary
    if (skipIds?.has(c.id)) continue
    // SUB-28: media sections source from their transcript (empty until ASR).
    const src = effectiveSourceText(c)
    if (!src.trim()) continue // no source → nothing to show
    const target = c.translated.trim() ? c.translated : ""
    if (!target && !sourceFallback) continue
    out.push(target && c.status !== "validated"
      ? { source: src, target, draft: true }
      : { source: src, target })
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

/**
 * Merge the approved discourse window with the drafts THIS RUN has already
 * produced, and trim to the configured budget (AQU-1386 §3).
 *
 * Batch drafting sends several calls in sequence. The corpus snapshot is read
 * once before the loop and `gatherPrecedingContext` admits only validated
 * targets, so without this every call after the first starts its discourse
 * cold — which is why long files drift in connectives and participant
 * reference partway down.
 *
 * The carried rows are marked `draft` so the prompt labels them as unreviewed
 * and the model weighs them below approved work. The rule that unapproved text
 * never becomes a retrieval EXAMPLE is untouched: these rows are in-run
 * context, are never persisted, and never reach another run.
 *
 * Newest-last, and the budget is applied to the COMBINED list so a run's own
 * drafts displace the oldest approved rows rather than being appended past the
 * window. A budget of 0 yields nothing — note that `slice(-0)` would instead
 * return everything, which is the bug this function exists to make untestable
 * at the call site.
 */
export function mergeInRunDraftContext(
  approved: readonly PrecedingWindowEntry[],
  inRunDrafts: readonly { source: string; target: string }[],
  budget: number,
): PrecedingWindowEntry[] {
  if (budget <= 0) return []
  const combined = [
    ...approved,
    ...inRunDrafts.map((d) => ({ source: d.source, target: d.target, draft: true })),
  ]
  return combined.slice(-budget)
}

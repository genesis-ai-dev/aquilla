// AD-13 passage expansion.
//
// Takes the flat top-K results from `branchingSearch` and expands each hit
// cell into a passage by walking ±radius along its file's anchor chain.
// Used by the AI copilot's batch path (and any future "parallel passages"
// UI) so the LLM prompt context includes contiguous source/target pairs
// around the retrieved hit, not just the hit cell itself.
//
// Pure functions — the route handler is responsible for loading the
// corpus (which carries `fileId` + `anchorCellId` for every cell, by
// design) and invoking `expandToPassages`.

import type { CorpusCell } from "./algorithm"

export interface PassageCell {
  cellId: string
  sourceText: string
  targetText: string
  /** Anchor-chain predecessor in this file. Null for the file's first cell. */
  anchorCellId: string | null
  /** True for the cell the branching search selected; false for the
   *  ±radius context cells around it. */
  hit: boolean
}

export interface Passage {
  fileId: string
  /** The cell branching search returned. The expansion is centered on this. */
  hitCellId: string
  /** Cells in anchor-chain order: predecessors (oldest first), hit,
   *  successors (newest last). Length ≤ 2 * radius + 1. */
  cells: PassageCell[]
}

interface ChainIndexes {
  byCellId: Map<string, CorpusCell>
  /** Forward index: anchorCellId → the cell that points back at it.
   *  When a cell has no anchor (file head), it doesn't appear in this map
   *  as an anchor; it does appear as a value if some other cell anchors to it. */
  byAnchor: Map<string, CorpusCell>
}

/** Build the two lookup indexes once per request. O(n) over the corpus. */
function buildChainIndexes(corpus: readonly CorpusCell[]): ChainIndexes {
  const byCellId = new Map<string, CorpusCell>()
  const byAnchor = new Map<string, CorpusCell>()
  for (const c of corpus) {
    byCellId.set(c.cellId, c)
    if (c.anchorCellId) byAnchor.set(c.anchorCellId, c)
  }
  return { byCellId, byAnchor }
}

function toPassageCell(c: CorpusCell, hit: boolean): PassageCell {
  return {
    cellId: c.cellId,
    sourceText: c.sourceText,
    targetText: c.targetText,
    anchorCellId: c.anchorCellId ?? null,
    hit,
  }
}

/**
 * Expand a single hit into a passage. Walks the anchor chain `radius` steps
 * backward (following `anchorCellId`) and `radius` steps forward (finding
 * cells whose `anchorCellId` points at the current cell).
 *
 * Both walks stop early when the chain ends or crosses into a different
 * file — passage contents are always within one file by construction.
 */
export function expandPassage(
  hitCellId: string,
  radius: number,
  idx: ChainIndexes,
): Passage | null {
  const hit = idx.byCellId.get(hitCellId)
  if (!hit || !hit.fileId) return null

  const fileId = hit.fileId

  const back: CorpusCell[] = []
  {
    let cur: CorpusCell | undefined = hit
    for (let i = 0; i < radius; i++) {
      if (!cur.anchorCellId) break
      const prev = idx.byCellId.get(cur.anchorCellId)
      if (!prev || prev.fileId !== fileId) break
      back.push(prev)
      cur = prev
    }
  }

  const fwd: CorpusCell[] = []
  {
    let cur: CorpusCell | undefined = hit
    for (let i = 0; i < radius; i++) {
      const next = idx.byAnchor.get(cur.cellId)
      if (!next || next.fileId !== fileId) break
      fwd.push(next)
      cur = next
    }
  }

  // back was collected in walk order (closest neighbor first); reverse so
  // the passage reads oldest → hit → newest.
  back.reverse()

  const cells: PassageCell[] = []
  for (const c of back) cells.push(toPassageCell(c, false))
  cells.push(toPassageCell(hit, true))
  for (const c of fwd) cells.push(toPassageCell(c, false))

  return { fileId, hitCellId, cells }
}

/**
 * Expand a batch of hit cellIds (typically the `top_k` from a branching
 * search) into passages. Hit ordering is preserved; hits whose cellId is
 * absent from the corpus (e.g., consumed by `excludeCellId` filtering then
 * passed in by mistake) are skipped silently.
 *
 * `radius >= 0`; `0` returns single-cell passages with `hit=true`.
 */
export function expandToPassages(
  corpus: readonly CorpusCell[],
  hitCellIds: readonly string[],
  radius: number,
): Passage[] {
  if (radius < 0 || hitCellIds.length === 0 || corpus.length === 0) return []
  const idx = buildChainIndexes(corpus)
  const out: Passage[] = []
  for (const id of hitCellIds) {
    const passage = expandPassage(id, radius, idx)
    if (passage) out.push(passage)
  }
  return out
}

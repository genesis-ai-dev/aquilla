// segment — derive span SEEDS from parser structure (graph node `segment`).
//
// Seeds are ANCHORS, never trusted boundaries: pericopes cross chapter breaks,
// headings get misused, paragraph marks are editorial. The scene_closure loop
// exists precisely because these boundaries are unreliable — construe expands
// the window past a bad seed edge; nothing downstream assumes a seed is a
// scene. Deterministic code, zero tokens.

import type { CellPair } from "../agent/tools/select-cells"
import type { SpanSeed, SpanSeedSource } from "./types"

/** Fallback chunk size when the file carries no usable structure (8–12 range
 *  from the design; groups larger than MAX are subdivided near-evenly). */
const CHUNK_TARGET = 10
const CHUNK_MAX = 12

export interface SegmentOptions {
  /** Cell ids that begin a paragraph, when the parser recorded them
   *  (CellPair itself does not carry paragraph flags). */
  paragraphStartCellIds?: string[]
}

/** Parse "MRK 4:12" → chapter grouping key, or null for non-scripture refs. */
function chapterKey(ref: string | null): string | null {
  if (!ref) return null
  const m = ref.trim().toUpperCase().match(/^([1-3]?[A-Z]{2,4})\s+(\d+)/)
  return m ? `${m[1]} ${m[2]}` : null
}

/** Split one oversized run of pairs into near-even chunks of ≤ CHUNK_MAX. */
function subdivide(run: CellPair[]): CellPair[][] {
  if (run.length <= CHUNK_MAX) return [run]
  const parts = Math.ceil(run.length / CHUNK_TARGET)
  const size = Math.ceil(run.length / parts)
  const out: CellPair[][] = []
  for (let i = 0; i < run.length; i += size) out.push(run.slice(i, i + size))
  return out
}

function toSeed(fileId: string, run: CellPair[], seedSource: SpanSeedSource): SpanSeed {
  const start = run[0].cellId
  const end = run[run.length - 1].cellId
  return {
    id: `${fileId}#${start}..${end}`,
    fileId,
    anchorCellId: start,
    startCellId: start,
    endCellId: end,
    seedSource,
  }
}

/**
 * Derive span seeds from ORDERED pairs (callers order via `orderPairs`).
 * Structure priority: canonical_ref chapter transitions → paragraph starts
 * (when provided) → fixed-size chunks. Oversized structural groups are
 * subdivided (the subdivided pieces are marked "chunk" — only the piece that
 * starts at a real transition keeps the structural seedSource).
 */
export function deriveSpanSeeds(
  fileId: string,
  pairs: CellPair[],
  options?: SegmentOptions,
): SpanSeed[] {
  if (pairs.length === 0) return []

  const hasRefs = pairs.some((p) => chapterKey(p.canonicalRef) !== null)
  const paragraphStarts = new Set(options?.paragraphStartCellIds ?? [])

  let runs: CellPair[][]
  let source: SpanSeedSource
  if (hasRefs) {
    source = "canonical-ref"
    runs = []
    let current: CellPair[] = []
    let currentKey: string | null = null
    for (const p of pairs) {
      const key: string | null = chapterKey(p.canonicalRef) ?? currentKey
      // Split only on a real chapter TRANSITION — unref'd cells (headings,
      // file intros) inherit the surrounding chapter's run.
      if (current.length > 0 && currentKey !== null && key !== currentKey) {
        runs.push(current)
        current = []
      }
      currentKey = key
      current.push(p)
    }
    if (current.length > 0) runs.push(current)
  } else if (paragraphStarts.size > 0) {
    source = "paragraph"
    runs = []
    let current: CellPair[] = []
    for (const p of pairs) {
      if (current.length > 0 && paragraphStarts.has(p.cellId)) {
        runs.push(current)
        current = []
      }
      current.push(p)
    }
    if (current.length > 0) runs.push(current)
  } else {
    source = "chunk"
    runs = subdivide(pairs)
  }

  const seeds: SpanSeed[] = []
  for (const run of runs) {
    const pieces = subdivide(run)
    pieces.forEach((piece, i) => {
      seeds.push(toSeed(fileId, piece, source === "chunk" ? "chunk" : i === 0 ? source : "chunk"))
    })
  }
  return seeds
}

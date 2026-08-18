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
 *  from the design; groups larger than MAX are subdivided near-evenly, and
 *  groups smaller than MAX are coalesced up to it). */
const CHUNK_TARGET = 10
const CHUNK_MAX = 12

/** Bounds on a human-supplied `fixedSize`. The floor keeps a span from being a
 *  single cell (the construe loop has no discourse to work with); the ceiling
 *  keeps the draft node's reply inside its 6144-token cap — past roughly this
 *  many cells a span truncates mid-array and the whole span is discarded. */
export const MIN_FIXED_SIZE = 2
export const MAX_FIXED_SIZE = 50

export interface SegmentOptions {
  /** Cell ids that begin a paragraph, when the parser recorded them
   *  (CellPair itself does not carry paragraph flags). Read server-side from
   *  `cells.metadata->>'paragraphStart'`, which the importer sets. */
  paragraphStartCellIds?: string[]
  /** Human override: ignore file structure and cut every N cells. Clamped to
   *  [MIN_FIXED_SIZE, MAX_FIXED_SIZE]. This is the escape hatch for a file
   *  whose derived boundaries a translator judged wrong — deliberately blunt,
   *  deliberately predictable. */
  fixedSize?: number
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

/**
 * Merge consecutive structural runs up to CHUNK_MAX, never splitting one.
 *
 * Subdivision alone is half a policy: it caps a run that is too big but does
 * nothing about runs that are too small, and a prose paragraph is usually one
 * to three cells. Left un-merged, every paragraph would become its own span
 * and pay a whole construe → summarize → draft → verify pipeline for two
 * sentences — strictly worse than the fixed chunking it replaces. Merging
 * keeps span size inside the design's 8–12 band while every boundary still
 * lands on a real paragraph edge, which is the only reason to read paragraph
 * marks at all.
 *
 * A single run longer than `max` passes through untouched for `subdivide`.
 */
export function coalesceRuns(runs: CellPair[][], max: number = CHUNK_MAX): CellPair[][] {
  const out: CellPair[][] = []
  let current: CellPair[] = []
  for (const run of runs) {
    if (run.length === 0) continue
    if (current.length === 0) {
      current = [...run]
    } else if (current.length + run.length <= max) {
      current.push(...run)
    } else {
      out.push(current)
      current = [...run]
    }
  }
  if (current.length > 0) out.push(current)
  return out
}

/** Cut into fixed-size pieces of exactly `size` (the last one may be short). */
function fixedChunks(pairs: CellPair[], size: number): CellPair[][] {
  const out: CellPair[][] = []
  for (let i = 0; i < pairs.length; i += size) out.push(pairs.slice(i, i + size))
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
 *
 * Priority: an explicit `fixedSize` override → canonical_ref chapter
 * transitions → paragraph starts (when provided) → fixed-size chunks.
 * Structural groups are coalesced up to CHUNK_MAX and subdivided past it, so
 * every span lands in the 8–12 band whichever branch produced it. Subdivided
 * pieces are marked "chunk" — only the piece that starts at a real transition
 * keeps the structural seedSource.
 */
export function deriveSpanSeeds(
  fileId: string,
  pairs: CellPair[],
  options?: SegmentOptions,
): SpanSeed[] {
  if (pairs.length === 0) return []

  // A human said "just cut it every N" — honour that over any derived
  // structure, since the reason to reach for it is that the derived structure
  // was wrong.
  if (options?.fixedSize !== undefined) {
    const size = Math.min(MAX_FIXED_SIZE, Math.max(MIN_FIXED_SIZE, Math.floor(options.fixedSize)))
    return fixedChunks(pairs, size).map((run) => toSeed(fileId, run, "chunk"))
  }

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
    const paragraphs: CellPair[][] = []
    let current: CellPair[] = []
    for (const p of pairs) {
      if (current.length > 0 && paragraphStarts.has(p.cellId)) {
        paragraphs.push(current)
        current = []
      }
      current.push(p)
    }
    if (current.length > 0) paragraphs.push(current)
    // Prose paragraphs are one to three cells; merged, they reach the same
    // span size the other two branches produce. Only this branch coalesces:
    // canonical-ref runs are already chapter-sized, and a chapter boundary is
    // a navigation unit a translator recognizes, so merging across one would
    // trade a real edge for a marginal saving.
    runs = coalesceRuns(paragraphs)
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

/**
 * edit-miner.ts — AQU-198
 *
 * Mines candidate rule patterns from the currently-available cell snapshot.
 *
 * EDIT HISTORY AVAILABILITY NOTE:
 * Per-cell prior-value history lives in the D1 event log and is only accessible
 * via authenticated server calls (one round-trip per cell, requiring a sync token
 * from `getTokenForFile`). This service intentionally does NOT make those calls —
 * doing so inside a rules-suggestion flow would be slow, need a React hook, and
 * require a new sync endpoint or a batch fetch (neither exists today).
 *
 * What IS client-accessible:
 *   - The current `CellData[]` snapshot from useCells: `status`, `original`,
 *     `translated`, `hasPendingEdit`, `targetEventId` (last committed event).
 *
 * Mining strategy given this constraint:
 *   1. REPEATED edits (highest signal): find the same source→target
 *      transformation applied across multiple distinct cells. "Same
 *      transformation" = same (source_term → target_term) trigram pair after
 *      simple normalisation.
 *   2. RECENT edits: cells whose `hasPendingEdit` flag is set (they have an
 *      uncommitted local edit sitting in the outbox) — these are the user's most
 *      recent corrections.
 *   3. VALIDATED-PAIR pass: the existing `suggestRulesFromPairs` path (untouched).
 *
 * SWARM-TODO(event-layer): To detect ACTUAL prior-value corrections (e.g. "user
 * changed X→Y in cell ABC and also X→Y in cell DEF") the mining step needs:
 *   - A batch endpoint on sync-worker: GET /projects/:pid/events?kinds=target.cell.commit&limit=N
 *     returning (cellId, eventId, value, parentId, serverTs) so we can walk the
 *     chain for each cell without N round-trips.
 *   - OR a materialized "last N target commits per project" view in D1.
 * Until then, mining is done on the current translation snapshot only.
 */

export interface EditCandidate {
  /** "repeated" | "recent" | "validated-pair" */
  kind: "repeated" | "recent" | "validated-pair"
  /** Human-readable evidence string surfaced in RuleImportReview */
  evidence: string
  /** Rank score — higher = more important */
  score: number
  /** Example source text that triggered this candidate */
  sourceSample: string
  /** Example target text */
  targetSample: string
  /**
   * Normalised key for deduplication — the (sourceKey, targetKey) pair
   * produced by normalise(). Used to avoid showing duplicates between
   * repeated/recent candidates that happen to fire on the same text.
   */
  key: string
}

import { effectiveSourceText } from "@/lib/cell-text"

/** A flat cell shape — subset of CellData to avoid importing the full hook type. */
export interface MinerCell {
  id?: string
  original: string
  translated: string
  status: "empty" | "unvalidated" | "validated"
  hasPendingEdit?: boolean
  // SUB-28: media sections mine from their transcript, not the filename.
  medium?: import("@/lib/sync/cells-read-types").SegmentMedium | null
  transcription?: string
}

// SUB-28: every source read below goes through this (transcript for media
// sections; empty until transcribed, which the trim filters then drop).
const src = (c: MinerCell): string => effectiveSourceText(c)

// ---------------------------------------------------------------------------
// Normalisation helpers
// ---------------------------------------------------------------------------

/**
 * Normalise a translation string to a stable key:
 * - lowercase
 * - collapse whitespace
 * - strip leading/trailing punctuation that doesn't affect meaning
 *
 * Intentionally coarse: we want near-duplicates to group, not exact match only.
 */
function normalise(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[^\wÀ-￿]+|[^\wÀ-￿]+$/g, "")
}

/**
 * Produces a (sourceKey, targetKey) candidate key.
 * Uses the full normalised strings when short (≤80 chars), otherwise uses
 * a 6-gram prefix to avoid overly long keys while retaining enough signal.
 */
function candidateKey(source: string, target: string): string {
  const sk = normalise(source)
  const tk = normalise(target)
  const sKey = sk.length <= 80 ? sk : sk.slice(0, 80)
  const tKey = tk.length <= 80 ? tk : tk.slice(0, 80)
  return `${sKey}|||${tKey}`
}

// ---------------------------------------------------------------------------
// Mining functions
// ---------------------------------------------------------------------------

/**
 * Mine REPEATED transformation candidates: the same (source, target) pair
 * appearing in 2+ distinct cells.
 *
 * Returns candidates sorted descending by occurrence count.
 */
export function mineRepeatedEdits(cells: MinerCell[]): EditCandidate[] {
  // Only consider cells with actual content
  const usable = cells.filter(
    (c) => src(c).trim() && c.translated.trim() && c.status !== "empty",
  )

  const counts = new Map<string, { count: number; source: string; target: string }>()

  for (const cell of usable) {
    const key = candidateKey(src(cell), cell.translated)
    const existing = counts.get(key)
    if (existing) {
      existing.count++
    } else {
      counts.set(key, { count: 1, source: src(cell).trim(), target: cell.translated.trim() })
    }
  }

  const repeated: EditCandidate[] = []
  for (const [key, { count, source, target }] of counts) {
    if (count < 2) continue
    repeated.push({
      kind: "repeated",
      evidence: `Same translation in ${count} cells`,
      score: 1000 + count * 10, // repeats rank highest
      sourceSample: source,
      targetSample: target,
      key,
    })
  }

  return repeated.sort((a, b) => b.score - a.score)
}

/**
 * Mine RECENT edit candidates: cells that currently have a pending outbox edit
 * (`hasPendingEdit === true`). These represent the user's most recent corrections
 * and are high-signal even without the full prior-value chain.
 */
export function mineRecentEdits(cells: MinerCell[]): EditCandidate[] {
  const recent: EditCandidate[] = []
  let rank = 0
  for (const cell of cells) {
    if (!cell.hasPendingEdit) continue
    if (!src(cell).trim() || !cell.translated.trim()) continue
    recent.push({
      kind: "recent",
      evidence: "Recently edited (pending commit)",
      score: 500 - rank, // recent first, descending
      sourceSample: src(cell).trim(),
      targetSample: cell.translated.trim(),
      key: candidateKey(src(cell), cell.translated),
    })
    rank++
  }
  return recent
}

/**
 * Combine, deduplicate, and rank candidates from all sources.
 *
 * Order: repeated (score ≥1000) > recent (score ≥500) > validated-pair (score <500)
 *
 * Deduplication: if a candidate key appears in a higher-priority tier it is
 * dropped from lower tiers so we don't show the same pattern twice.
 */
export function combineAndRankCandidates(
  repeated: EditCandidate[],
  recent: EditCandidate[],
  validatedPair: EditCandidate[],
): EditCandidate[] {
  const seen = new Set<string>()
  const result: EditCandidate[] = []

  for (const candidate of [...repeated, ...recent, ...validatedPair]) {
    if (seen.has(candidate.key)) continue
    seen.add(candidate.key)
    result.push(candidate)
  }

  return result.sort((a, b) => b.score - a.score)
}

/**
 * Convert validated-pair source→target objects to EditCandidate format
 * so they can flow through combineAndRankCandidates.
 */
export function validatedPairsToCandidate(
  pairs: { source: string; target: string }[],
): EditCandidate[] {
  return pairs.map((p, i) => ({
    kind: "validated-pair" as const,
    evidence: "From validated translation pair",
    score: 100 - i, // preserve original order with slight decay
    sourceSample: p.source,
    targetSample: p.target,
    key: candidateKey(p.source, p.target),
  }))
}

/**
 * Top-level mine function: given cells + pre-collected validated pairs,
 * returns a ranked EditCandidate list.
 *
 * This is the main entry point called by RuleSuggestFromEditsDialog.
 */
export function mineCandidates(
  cells: MinerCell[],
  validatedPairs: { source: string; target: string }[],
): EditCandidate[] {
  const repeated = mineRepeatedEdits(cells)
  const recent = mineRecentEdits(cells)
  const pairCandidates = validatedPairsToCandidate(validatedPairs)
  return combineAndRankCandidates(repeated, recent, pairCandidates)
}

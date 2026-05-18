// AD-13 branching-search tunables — spec defaults + partial-merge helper.
//
// Per the spec these live in `project_settings.branchingSearch`. For v1 we
// hard-code defaults at the call site; reading from D1 settings is a follow-up
// once we have a real need to tune per-project (TODO before AD-14 lands —
// decay's endorsement bookkeeping has to use the same tunables this endpoint
// uses, so the source of truth has to migrate to D1 before then).

export interface BranchingSearchSettings {
  /** Number of result cells to return. Spec default 5 (matches the existing
   *  `numberOfFewShotExamples` knob from codex-editor). */
  topK: number
  /** Multiplier on `bm25 * (1 + coverage_weight * coverage)`. Larger values
   *  reward cells that cover more of the query's unique words. Spec default 0.5. */
  coverageWeight: number
  /** Okapi BM25 term-frequency saturation. Spec default 1.5. */
  bm25K1: number
  /** Okapi BM25 length normalization. Spec default 0.75. */
  bm25B: number
  /** When all branches run out before topK is full, re-seed with the full
   *  original query up to this many times. Spec default 3. */
  maxRestarts: number
}

export const BRANCHING_SEARCH_DEFAULTS: BranchingSearchSettings = {
  topK: 5,
  coverageWeight: 0.5,
  bm25K1: 1.5,
  bm25B: 0.75,
  maxRestarts: 3,
}

/** Merge a partial (typically from project_settings JSON) over the defaults.
 *  Any unset or non-finite field falls back to its default. */
export function applyBranchingSearchDefaults(
  partial: Partial<BranchingSearchSettings> | undefined | null,
): BranchingSearchSettings {
  if (!partial) return BRANCHING_SEARCH_DEFAULTS
  const pick = <K extends keyof BranchingSearchSettings>(
    k: K,
  ): BranchingSearchSettings[K] => {
    const v = partial[k]
    return typeof v === "number" && Number.isFinite(v) && v >= 0
      ? (v as BranchingSearchSettings[K])
      : BRANCHING_SEARCH_DEFAULTS[k]
  }
  return {
    topK: Math.max(1, Math.floor(pick("topK"))),
    coverageWeight: pick("coverageWeight"),
    bm25K1: pick("bm25K1"),
    bm25B: pick("bm25B"),
    maxRestarts: Math.max(0, Math.floor(pick("maxRestarts"))),
  }
}

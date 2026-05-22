// AD-13 branching-search tunables — spec defaults, partial-merge helper,
// and D1-backed loader for the `project_settings.branchingSearch` JSON
// subkey.
//
// The defaults match the spec verbatim and are applied:
//   - when the project has no settings row,
//   - when the settings row exists but `branchingSearch` is unset,
//   - when individual fields are missing / NaN / negative.
//
// AD-14's decay endorsement will use the same tunables — keeping this in
// one place so the AI copilot and the endorsement bookkeeping never drift.

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

export interface SettingsLoaderEnv {
  AQUILLA_DB?: D1Database
}

/**
 * Load branching-search tunables for `projectId` from D1's `project_settings`
 * row. Soft-fails to spec defaults on any error (missing binding, missing
 * row, missing key, malformed JSON, malformed values). Never throws — the
 * caller's retrieval should never break because of a settings parse problem.
 *
 * Wire into the route before invoking the algorithm. Layering precedence at
 * the call site is: defaults < project_settings.branchingSearch < query-string
 * override (e.g., the AI copilot's per-call `topK`).
 */
export async function loadBranchingSearchSettings(
  env: SettingsLoaderEnv,
  projectId: string,
): Promise<BranchingSearchSettings> {
  if (!env.AQUILLA_DB) return BRANCHING_SEARCH_DEFAULTS
  try {
    const row = await env.AQUILLA_DB.prepare(
      "SELECT settings FROM project_settings WHERE project_id = ?",
    )
      .bind(projectId)
      .first<{ settings: string | null }>()
    if (!row?.settings) return BRANCHING_SEARCH_DEFAULTS
    let parsed: unknown
    try {
      parsed = JSON.parse(row.settings)
    } catch {
      return BRANCHING_SEARCH_DEFAULTS
    }
    if (!parsed || typeof parsed !== "object") return BRANCHING_SEARCH_DEFAULTS
    const branchingSearch = (parsed as Record<string, unknown>).branchingSearch
    if (!branchingSearch || typeof branchingSearch !== "object") {
      return BRANCHING_SEARCH_DEFAULTS
    }
    return applyBranchingSearchDefaults(
      branchingSearch as Partial<BranchingSearchSettings>,
    )
  } catch {
    return BRANCHING_SEARCH_DEFAULTS
  }
}

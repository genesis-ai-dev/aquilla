// Types for the sync-worker project-wide search API (Phase 2b).
//
// Mirror of `sync-worker/src/events/search-route.ts`.

export interface SearchResult {
  cellId: string
  fileId: string
  side: "source" | "target"
  /** The full cell value (not just the snippet) so callers can highlight
   *  + jump-to without an extra round-trip. */
  value: string
  /** FTS5 snippet with `<mark>...</mark>` highlights around matched terms. */
  snippet: string
  /** FTS5 rank score. Lower is better (best matches first). */
  rank: number
  /**
   * Opposite-side cell value at the same (fileId, cellId). Null when that
   * side has no row. Absent only on responses from a server that predates
   * the field.
   */
  pairedValue?: string | null
  /**
   * Verse address (`GEN 1:1`), from the source row when the matched row has
   * none. Absent on a server that predates the field.
   */
  canonicalRef?: string | null
  /** Source cell type (`verse`, `heading`, …). */
  cellType?: string | null
  /** Section title, cell label, or import display label. May be a bare number. */
  placeLabel?: string | null
  /** 1-based place among the file's visible source cells. */
  position?: number | null
}

export interface SearchResponse {
  results: SearchResult[]
}

export interface FetchSearchOptions {
  side?: "source" | "target"
  /** Server clamps to [1, 500]; default 50. */
  limit?: number
  /** Case-sensitive literal/regexp match. Off keeps the default FTS search. */
  matchCase?: boolean
  /** Whole word. Off keeps the default FTS search. */
  wholeWord?: boolean
  /** Query is a regular expression. Off keeps the default FTS search. */
  useRegexp?: boolean
}

export interface ParallelPassageResult extends SearchResult {
  /** The paired-side cell value at the same (fileId, cellId), if it exists.
   *  null when no opposite-side cell is present. */
  pairedValue: string | null
  /** Which project this hit came from. Identical to the projectId query for
   *  single-project lookups; populated by the multi-project fan-out wrapper
   *  to disambiguate results from concurrent fetches. */
  projectId: string
}

export interface ParallelPassagesResponse {
  results: Omit<ParallelPassageResult, "projectId">[]
}

export interface FetchParallelPassagesOptions {
  side?: "source" | "target"
  limit?: number
}

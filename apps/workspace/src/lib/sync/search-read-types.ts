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
}

export interface SearchResponse {
  results: SearchResult[]
}

export interface FetchSearchOptions {
  side?: "source" | "target"
  /** Server clamps to [1, 500]; default 50. */
  limit?: number
}

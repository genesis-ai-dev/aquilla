// Types for the sync-worker AD-13 branching-search read API.
//
// Mirror of `apps/sync/src/events/branching-search-route.ts`. Kept hand-
// authored on the client side (no cross-app imports per AD-11); update both
// when the response shape changes.

export interface BranchingSearchResult {
  cellId: string
  sourceText: string
  /** Paired target text. Empty string for source-only projects (no target). */
  targetText: string
  /** Fraction of the FULL original query's unique words present in this cell's
   *  bag-of-words. [0, 1]. */
  queryCoverage: number
}

export interface BranchingSearchResponse {
  results: BranchingSearchResult[]
  /** cellId → the contiguous words from the winning branch this cell
   *  satisfied. Empty array is possible (defensive bailout). */
  provenance: Record<string, string[]>
  /** Resolved upstream id, or null for self-contained / source-only. */
  upstreamProjectId: string | null
  /** Max source-side event_id observed across the loaded corpus. Stable
   *  while the corpus is unchanged — useful as a cache key when client-
   *  side caching lands. */
  corpusEventMax: string | null
  /** Number of source cells the query ran over. */
  corpusSize: number
}

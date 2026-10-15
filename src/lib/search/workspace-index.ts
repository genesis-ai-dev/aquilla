// Phase 2c-gamma: the in-process workspace search index read directly from
// Y.Doc cells. Search now flows through the server's branching-search
// endpoint (see lib/sync/branching-search-read.ts) — useWorkspaceSearch
// delegates to that. This module survives only as the canonical home for
// the shared search-result + match-field types referenced by the panel UI.

export type MatchField = "original" | "translated" | "context"

/** Public result shape mirroring the one consumed by useWorkspaceSearch. */
export interface WorkspaceSearchResult {
  cellId: string
  fileId: string
  fileName: string
  original: string
  translated: string
  context: string
  matchedFields: Set<MatchField>
  matchCount: number
  matchedTokens: string[]
  snippet: string
  rank: number
  /** Optional paired-side snippet for parallel passage results. Populated
   *  by `searchParallelPassages`; absent on regular `search` results. */
  paired?: string | null
  /** Verse address (`GEN 1:1`). Absent when the cell has none. */
  canonicalRef?: string | null
  /** Source cell type (`verse`, `heading`, …). */
  cellType?: string | null
  /** Section title, cell label, or import display label. */
  placeLabel?: string | null
  /** 1-based place among the file's visible source cells. */
  position?: number | null
}

export interface SearchOptions {
  scope?: "project" | "file"
  fileId?: string
  caseSensitive?: boolean
  matchWord?: boolean
  /** Interpret the query as a regular expression. */
  useRegexp?: boolean
  /** Content-side filter. "source" | "target"; omit (or "both") to return both sides. */
  side?: "both" | "source" | "target"
}

/** Find-widget toggles. All false keeps the default full-text search. */
export interface FindToggles {
  caseSensitive: boolean
  matchWord: boolean
  useRegexp: boolean
}

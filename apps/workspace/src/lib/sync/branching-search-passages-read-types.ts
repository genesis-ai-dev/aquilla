// Types for the sync-worker AD-13 passages route.
//
// Mirror of `apps/sync/src/events/branching-search-passages-route.ts`.

export interface PassageCell {
  cellId: string
  sourceText: string
  targetText: string
  /** Anchor-chain predecessor; null for the file head. */
  anchorCellId: string | null
  /** True only for the cell branching search picked; false for ±radius context. */
  hit: boolean
}

export interface Passage {
  fileId: string
  hitCellId: string
  /** Cells in anchor-chain order — predecessors → hit → successors. */
  cells: PassageCell[]
}

export interface BranchingSearchPassagesResponse {
  passages: Passage[]
  upstreamProjectId: string | null
  corpusEventMax: string | null
  corpusSize: number
}

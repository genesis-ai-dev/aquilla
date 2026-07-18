// Shared shapes for the semantic tools (read / examples / search / draft).
//
// ToolResultData is the DISPLAY payload a code_result frame may carry for the
// client's working-set panel — it must mirror src/lib/agent/protocol.ts
// byte-for-byte (same reason protocol.ts mirrors the server frames). The
// model never sees it; the model gets the compact `text`.

export interface PassageRow {
  cellId: string
  fileId?: string
  ref?: string
  source: string
  target: string
  status?: "untranslated" | "drafted" | "stale" | "validated" | "flagged"
}

export interface ExamplePair {
  cellId?: string
  ref?: string
  source: string
  target: string
  validated?: boolean
}

export interface SearchHit {
  cellId: string
  fileId?: string
  ref?: string
  side: "source" | "target" | "comments" | "terms"
  snippet: string
}

export interface ToolResultData {
  cells?: PassageRow[]
  examples?: ExamplePair[]
  hits?: SearchHit[]
}

/** What every semantic tool hands back to the loop. */
export interface ToolOutcome {
  ok: boolean
  /** Compact text the model sees as the tool result. */
  text: string
  /** Typed payload for the client's working-set panel (display only). */
  data?: ToolResultData
}

// The marker that says a person made this cell, rather than an import.
//
// Split out of user-lines.ts (AQU-1068) so that asking the question costs
// NOTHING. The predicate reads one metadata field, but its old home also holds
// `isLineEmpty`, which needs `audioIdSeededWith` — and that pulls in the audio
// upload module, then sync-worker URL resolution, which reads `import.meta.env`
// at module scope. Surfaces that only want to know "did somebody add this?" —
// the export dialog, the docx and pptx exporters — were dragging all of that in
// behind them.
//
// The marker is written on the create event and is the ONLY signal used. The
// tempting alternative — "it has no import envelope, so a person must have made
// it" — is wrong: `importDisplayLabel`'s own contract defines a missing
// envelope as "legacy content with no normalized metadata", which describes
// every file imported before the normalized manifest. Inferring from absence
// would offer to delete somebody's whole VTT.

export interface AquillaOrigin {
  version: number
  kind: "user-insert"
  createdAt?: number
  /**
   * AQU-1759: the row this one was split off. The same key the Agent API's
   * SplitCell writes (sync-worker structure-engine `agentLineOrigin`), so a
   * piece cut in the editor and one cut by an agent read alike. Still a
   * `user-insert`: the exporters place it under the verse it follows exactly
   * as they place any line added here, which is what puts a split verse back
   * together on the way out.
   */
  splitFrom?: string
}

/** The metadata a newly added line carries. */
export function userLineOrigin(): AquillaOrigin {
  return { version: 1, kind: "user-insert", createdAt: Date.now() }
}

/** AQU-1759: the metadata a piece split off `fromCellId` carries. */
export function splitLineOrigin(fromCellId: string): AquillaOrigin {
  return { ...userLineOrigin(), splitFrom: fromCellId }
}

/** AQU-1759: the row this one was split off, if it was. */
export function splitFromCellId(cell: { metadata?: Record<string, unknown> | null }): string | null {
  if (!isUserAddedLine(cell)) return null
  const from = (cell.metadata?.aquillaOrigin as AquillaOrigin).splitFrom
  return typeof from === "string" && from ? from : null
}

export function isUserAddedLine(cell: { metadata?: Record<string, unknown> | null }): boolean {
  const o = cell.metadata?.aquillaOrigin
  return typeof o === "object" && o !== null && (o as AquillaOrigin).kind === "user-insert"
}

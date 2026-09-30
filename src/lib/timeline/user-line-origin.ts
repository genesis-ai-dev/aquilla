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
}

/** The metadata a newly added line carries. */
export function userLineOrigin(): AquillaOrigin {
  return { version: 1, kind: "user-insert", createdAt: Date.now() }
}

export function isUserAddedLine(cell: { metadata?: Record<string, unknown> | null }): boolean {
  const o = cell.metadata?.aquillaOrigin
  return typeof o === "object" && o !== null && (o as AquillaOrigin).kind === "user-insert"
}

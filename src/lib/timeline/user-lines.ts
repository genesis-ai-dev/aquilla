// Lines a person added over a stretch of film, as opposed to cues that came
// from the imported subtitle file. (AQU-646)
//
// The marker is written on the create event and is the ONLY signal used. The
// tempting alternative — "it has no import envelope, so a person must have made
// it" — is wrong: `importDisplayLabel`'s own contract defines a missing
// envelope as "legacy content with no normalized metadata", which describes
// every file imported before the normalized manifest. Inferring from absence
// would offer to delete somebody's whole VTT.

import type { CellData } from "@/hooks/useCells"
import { audioIdSeededWith } from "@/lib/audio/upload"

export interface AquillaOrigin {
  version: number
  kind: "user-insert"
  createdAt?: number
}

/** The metadata a newly added line carries. */
export function userLineOrigin(): AquillaOrigin {
  return { version: 1, kind: "user-insert", createdAt: Date.now() }
}

export function isUserAddedLine(cell: Pick<CellData, "metadata">): boolean {
  const o = cell.metadata?.aquillaOrigin
  return typeof o === "object" && o !== null && (o as AquillaOrigin).kind === "user-insert"
}

/**
 * Nothing on any side of it. Removal is restricted to this because
 * `source.cell.delete`'s projection drops one row and cleans up nothing else —
 * takes and their R2 bytes, validators, waivers, back-translations, comments
 * and assignment rows would all be left pointing at a cell that no longer
 * exists. Empty its parts first and it becomes removable.
 */
export function isLineEmpty(cell: CellData): boolean {
  if (cell.original?.trim()) return false
  if (cell.translated?.trim()) return false
  if (cell.transcription?.trim()) return false
  // Any take of its own. The imported source clip is file-seeded, so it is not
  // this cell's to lose — but a line added over a silence never has one anyway.
  for (const [audioId, att] of Object.entries(cell.attachments ?? {})) {
    if (att.isDeleted) continue
    if (audioIdSeededWith(audioId, cell.id)) return false
  }
  return true
}

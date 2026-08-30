// Lines a person added over a stretch of film, as opposed to cues that came
// from the imported subtitle file. (AQU-646)
//
// The ORIGIN MARKER itself now lives in user-line-origin.ts, which has no
// imports at all — see its header. This module keeps `isLineEmpty`, which needs
// the audio helper, and re-exports the marker so every existing caller is
// unaffected.

import type { CellData } from "@/hooks/useCells"
import { audioIdSeededWith } from "@/lib/audio/upload"

export { userLineOrigin, isUserAddedLine, type AquillaOrigin } from "./user-line-origin"

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

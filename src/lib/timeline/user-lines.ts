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
 * Nothing on any side of it.
 *
 * This used to gate REMOVAL — a cell had to be empty before it could go,
 * because `source.cell.delete` dropped one row and cleaned up nothing else.
 * AQU-1068 gave the projection a real cascade, so that reason is gone, and
 * keeping the test in the permission path was a bug in its own right: a line
 * you added stopped being yours the moment you recorded into it.
 *
 * What it answers now is the CONFIRMATION question — is there anything here
 * worth warning about before it is destroyed? An empty line you just added
 * needs no dialog; anything else does. See `buildCellRemovalInventory`.
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

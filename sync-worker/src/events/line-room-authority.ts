/**
 * AQU-2432 (review, Nov 9): what the server accepts as an unrecorded line's
 * ROOM (`cell.lane.retime`'s `recordingsRoomMs`, stored on the line's source
 * row under a key that carries the language — event-projection.ts).
 *
 *   - THE VALUE, at projection: a number from 0 to a day sets the room, null
 *     clears it, and anything else — negative, not a number, or so large that
 *     the bigint cast would fail (and with it every event flushed in the same
 *     batch) — is refused for that field only: skipped, while the event's
 *     other keys still land. An event that never carried a room (any older
 *     client's) is untouched.
 *   - THE ADDRESS, at the perimeter: the room is written to the line's row in
 *     the file the event names. A line that lives in ANOTHER file of the
 *     project (a heard line of a film's cue file, aimed at the open subtitle
 *     file) would change no row and be silently lost, so the event is refused
 *     and the client hears why. A line not found anywhere is let through: it
 *     may be created in the same flush, and the write is a no-op otherwise.
 */
import type { AquillaDb } from '../../../db/shim/postgres'
import type { RawEvent } from './types'

/** The most a room can be: a day, in ms. Far above any line's natural
 *  length, and far below what the bigint column refuses. */
export const LINE_ROOM_MAX_MS = 86_400_000

/** The room to store for a payload value: whole ms, null to clear it, or
 *  undefined to leave the stored room alone (absent, or refused). */
export function lineRoomToStore(value: unknown): number | null | undefined {
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > LINE_ROOM_MAX_MS) return undefined
  return Math.round(value)
}

/** Why a room event is refused at the perimeter, or null to let it through. */
export async function lineRoomRefusal(db: AquillaDb, raw: RawEvent): Promise<string | null> {
  if (raw.kind !== 'cell.lane.retime' || !raw.fileId || !raw.cellId) return null
  if ((raw.payload as { recordingsRoomMs?: unknown } | null)?.recordingsRoomMs === undefined) return null
  try {
    // The named file first: a line found there is always fine.
    const row = await db
      .prepare(
        `SELECT file_id FROM cells
         WHERE project_id = ? AND cell_id = ? AND side = 'source'
         ORDER BY (file_id = ?) DESC
         LIMIT 1`,
      )
      .bind(raw.projectId, raw.cellId, raw.fileId)
      .first<{ file_id: string }>()
    if (!row || row.file_id === raw.fileId) return null
    return `this line's room was sent for file '${raw.fileId}', but the line is not in the file the event names`
  } catch {
    // Unreadable: let it through. A misaddressed room changes no row.
    return null
  }
}

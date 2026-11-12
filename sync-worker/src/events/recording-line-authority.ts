/**
 * Slice 13 (Sam, Oct 28): taking back lines you have just made from a
 * recording.
 *
 * Below Maintainer, `source.cell.delete` may remove only a line added by hand
 * (authorize.ts, AQU-1068): an imported line is the client's content. Lines
 * made from a recording ("make rows from an audio or video file") are imported
 * lines, so a Project lead who made them could not undo making them — her Undo
 * was offered, then refused line by line. Sam ruled that she may, narrowly:
 *
 *   - the delete names the line's creating event (`undoOfEventId`),
 *   - that event is HER OWN `source.cell.create` of a line made from a
 *     recording (`medium: "media"`), for this very line,
 *   - and nobody else has written to the line since.
 *
 * Her own later writes (the recording's attach, its transcript) do not count
 * against her: they are part of making the lines. The client's Undo is
 * stricter still — it refuses once the line has a translation, a take or a
 * moved source (recording-lines-steps.ts) — so this is the floor the server
 * holds, not the whole rule.
 *
 * Fails closed: anything unreadable keeps the Maintainer requirement.
 */
import type { AquillaDb } from '../../../db/shim/postgres'

export async function isOwnUntouchedRecordingLine(
  db: AquillaDb,
  line: { projectId: string; fileId: string; cellId: string; createEventId: string; author: string },
): Promise<boolean> {
  try {
    const created = await db
      .prepare(
        `SELECT kind, author, payload, server_seq FROM events
         WHERE id = ? AND project_id = ? AND file_id = ? AND cell_id = ?`,
      )
      .bind(line.createEventId, line.projectId, line.fileId, line.cellId)
      .first<{ kind: string; author: string; payload: unknown; server_seq: number | string | null }>()
    if (!created || created.kind !== 'source.cell.create' || created.author !== line.author) return false

    const payload = (typeof created.payload === 'string' ? JSON.parse(created.payload) : created.payload) as
      | { medium?: unknown }
      | null
    if (payload?.medium !== 'media' || created.server_seq == null) return false

    const someoneElse = await db
      .prepare(
        `SELECT 1 AS hit FROM events
         WHERE project_id = ? AND file_id = ? AND cell_id = ? AND server_seq > ? AND author <> ?
         LIMIT 1`,
      )
      .bind(line.projectId, line.fileId, line.cellId, created.server_seq, line.author)
      .first<{ hit: number }>()
    return someoneElse == null
  } catch {
    return false
  }
}

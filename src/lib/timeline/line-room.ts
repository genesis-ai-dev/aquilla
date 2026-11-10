// AQU-2432 (Sam, Nov 9): AN UNRECORDED LINE'S ROOM, following the recordings.
//
// A file that follows its recordings lays its lines end to end. A line nobody
// has recorded yet takes its natural length there (its stand-in from its
// words, its own span, or its original's length). Dragging the NEXT take
// earlier, against such a line, makes that line's ROOM smaller, down to
// nothing; dragging it later gives the room back, up to the natural length.
// Nothing is stored on the dragged take.
//
// WHAT IS STORED, AND WHERE. One number per line per language, in ms: how much
// room the line is given while it has no recording. It lives with the line's
// other timeline state, in the SOURCE row's `cells.metadata`, written by
// `cell.lane.retime` (`recordingsRoomMs`) and merged per key like the subtitle
// span beside it. Whether a line is recorded is per language, so the key
// carries the language: `recordings_room_ms` for the project's default
// language, `recordings_room_ms:<tag>` for any other. The server writes the
// same key (sync-worker `event-projection.ts`, 'cell.lane.retime').
//
// The cell store stamps the active language's number onto the line as
// `CellData.recordingsRoomMs`, so the layout, the transport and the exports
// read one field and never need to know which language is open.
//
// The room is IGNORED while the line has a take (its take sets its length,
// like any recorded line) and applies again only if the line becomes empty
// again. It means nothing following the source.

import type { CellData } from "@/hooks/useCells"

const LINE_ROOM_KEY = "recordings_room_ms"

/** The `cells.metadata` key a language's room is stored under. */
export function lineRoomKey(lane: string | null | undefined): string {
  return lane ? `${LINE_ROOM_KEY}:${lane}` : LINE_ROOM_KEY
}

/** The room stored for `lane` in a source row's metadata, in ms; undefined for none. */
export function lineRoomMsFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
  lane: string | null | undefined,
): number | undefined {
  const v = metadata?.[lineRoomKey(lane)]
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined
}

/** The line's stored room in seconds, or null when none is stored. */
export function storedRoomSec(cell: Pick<CellData, "recordingsRoomMs">): number | null {
  const ms = cell.recordingsRoomMs
  return typeof ms === "number" && Number.isFinite(ms) && ms >= 0 ? ms / 1000 : null
}

/** One line's room as a move leaves it: ms, or null for its natural length
 *  (nothing stored). */
export interface LineRoomChange {
  cellId: string
  roomMs: number | null
}

/**
 * AQU-2432 (review, Nov 9): THE ROOM IS WRITTEN TO THE FILE THAT OWNS THE
 * LINE. A film with an audio cue file is laid out, following its recordings,
 * from its heard lines, and those live in the cue file, not the file that is
 * open: aimed at the open file, the event changed no row and the drag sprang
 * back. Each room is shown at once and sent in its line's own file, and each
 * file written is re-read once everything is sent.
 */
export interface LineRoomWriter {
  /** The file the line lives in (a heard line's: the cue file), or null when
   *  no file holds it any more — nothing is written for it then. */
  fileOf(cellId: string): string | null
  /** Show the room at once, in that file. */
  paint(fileId: string, cellId: string, roomMs: number | null): void
  /** Queue the line's room event, aimed at that file. */
  emit(fileId: string, cellId: string, roomMs: number | null): Promise<unknown>
  /** Send what is queued, then re-read these files. */
  flush(fileIds: readonly string[]): Promise<void>
}

export async function writeLineRooms(w: LineRoomWriter, rooms: readonly LineRoomChange[]): Promise<void> {
  const owned = rooms.flatMap((r) => {
    const fileId = w.fileOf(r.cellId)
    return fileId ? [{ ...r, fileId }] : []
  })
  if (owned.length === 0) return
  for (const r of owned) w.paint(r.fileId, r.cellId, r.roomMs)
  for (const r of owned) await w.emit(r.fileId, r.cellId, r.roomMs)
  await w.flush([...new Set(owned.map((r) => r.fileId))])
}

/**
 * AQU-2432 (review, Nov 9): lines read OUTSIDE the cell store — a film's heard
 * lines, read once from its cue file — with the room the store would stamp on
 * them for `lane` (`CellStore` does it for the open file's), and any room
 * written here since that read (`written`; null: cleared).
 */
export function stampLineRooms<C extends CellData>(
  cells: readonly C[],
  lane: string | null | undefined,
  written: ReadonlyMap<string, number | null>,
): C[] {
  return cells.map((c) => {
    const roomMs = written.has(c.id) ? written.get(c.id) : lineRoomMsFromMetadata(c.metadata, lane)
    if (roomMs == null) {
      if (c.recordingsRoomMs === undefined) return c
      const { recordingsRoomMs: _gone, ...rest } = c
      return rest as C
    }
    return c.recordingsRoomMs === roomMs ? c : { ...c, recordingsRoomMs: roomMs }
  })
}

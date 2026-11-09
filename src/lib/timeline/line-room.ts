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

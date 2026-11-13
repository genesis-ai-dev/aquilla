/**
 * AQU-2432 (Sam, Nov 9, rule 7): the history step for a drag that changed the
 * ROOM of the unrecorded lines before a take (lib/timeline/line-room).
 *
 * Following the recordings, dragging a take against a line nobody has
 * recorded sets that line's room. One drag can close several lines' rooms,
 * one after another, and can also change the take's own place (its pause
 * closes first on the way earlier, and opens once the rooms are whole on the
 * way later). All of it is ONE step: Undo gives every line its room back and
 * puts the take where it was, together.
 *
 * Like the take steps beside it, the step is data and this module turns it
 * into undo/redo given the writes as plain functions, so the "changed since?"
 * guard is testable without a component.
 */
import type { StepHandler, StepOutcome } from "./history"
import type { StoredTakePlace, TakePlaceData } from "./take-steps"
import type { CodexCellAttachment } from "@/lib/codex-editor/types"
import type { LineRoomChange } from "@/lib/timeline/line-room"

const DONE: StepOutcome = { kind: "done" }
const GONE: StepOutcome = { kind: "skipped", reason: "gone" }
const CHANGED: StepOutcome = { kind: "skipped", reason: "changed" }

export interface LineRoomStepData {
  /** Each line whose room the drag changed: its stored room before and after,
   *  in ms. Null is "none stored" (its natural length); 0 is "no room". */
  rooms: { cellId: string; before: number | null; after: number | null }[]
  /** The dragged take's own move, when the drag changed that too. */
  take?: TakePlaceData
}

export interface LineRoomStepContext {
  /** The line's stored room NOW, in ms (null: none stored); undefined when
   *  the line is gone. */
  readRoom(cellId: string): number | null | undefined
  /** Store every room given (null clears one). */
  applyRooms(rooms: readonly LineRoomChange[]): Promise<void>
  /** The take as it reads NOW (null when it is gone, or deleted). */
  readTake(cellId: string, audioId: string): CodexCellAttachment | null
  /** Both of the take's places, in one write. */
  applyPlace(cellId: string, audioId: string, place: StoredTakePlace): Promise<void>
}

/**
 * AQU-2432 (review, Nov 9): a drag's rooms and the take's own place, shown
 * TOGETHER. Both writes paint before they wait for anything, so both are
 * started before either is waited for: waiting for the room's save first left
 * the take a pause away from where it was dropped for as long as the server
 * took to answer. The drag, its Undo and its Redo all write through here.
 */
export async function applyLineRoomMove(
  ctx: Pick<LineRoomStepContext, "applyRooms" | "applyPlace">,
  rooms: readonly LineRoomChange[],
  take: { cellId: string; audioId: string; place: StoredTakePlace } | null | undefined,
): Promise<void> {
  await Promise.all([ctx.applyRooms(rooms), take ? ctx.applyPlace(take.cellId, take.audioId, take.place) : undefined])
}

export function lineRoomStepHandlers(ctx: LineRoomStepContext): Record<string, StepHandler<never>> {
  // Everything the drag changed is checked before anything is written: a room
  // or a place changed since is someone else's work, and the step leaves all
  // of it alone rather than undoing half a drag.
  const flip = async (d: LineRoomStepData, from: "before" | "after", to: "before" | "after"): Promise<StepOutcome> => {
    const nowRooms = d.rooms.map((r) => ctx.readRoom(r.cellId))
    const take = d.take
    const att = take ? ctx.readTake(take.cellId, take.audioId) : null
    if (nowRooms.some((r) => r === undefined) || (take && !att)) return GONE
    if (d.rooms.some((r, i) => nowRooms[i] !== r[from])) return CHANGED
    const placeOf = (side: "before" | "after"): StoredTakePlace => ({
      targetOffsetMs: (side === "before" ? take?.before : take?.after) ?? null,
      recordingsOffsetMs: (side === "before" ? take?.recordingsBefore : take?.recordingsAfter) ?? null,
    })
    if (take && att) {
      const was = placeOf(from)
      if ((att.targetOffsetMs ?? null) !== was.targetOffsetMs) return CHANGED
      if ((att.recordingsOffsetMs ?? null) !== was.recordingsOffsetMs) return CHANGED
    }
    await applyLineRoomMove(
      ctx,
      d.rooms.map((r) => ({ cellId: r.cellId, roomMs: r[to] })),
      take ? { cellId: take.cellId, audioId: take.audioId, place: placeOf(to) } : null,
    )
    return DONE
  }
  return {
    "line.room": {
      undo: (d: LineRoomStepData) => flip(d, "after", "before"),
      redo: (d: LineRoomStepData) => flip(d, "before", "after"),
    } as StepHandler<never>,
  }
}

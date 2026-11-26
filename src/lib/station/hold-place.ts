// AQU-2493 (review, Nov 9): a Station save holds the take where it sounds.
//
// A take's place is where its clip's START (sample zero) sits from its line's
// start (lib/timeline/take-place.ts); its sound starts a head trim later.
// Deleting or inserting audio before the Start flag moves Start inside the
// new recording, so with the old place the sound came earlier (a delete) or
// later (an insert) on the timeline. Keep never did that: a trim leaves the
// clip where it is. So a save moves the clip's start the other way by the
// amount Start moved, and the sound stays put:
//   - following the source, on every track;
//   - following the recordings, on a layer track (music, effects, ambience),
//     where the sound also starts a head trim after the clip's start.
// Following the recordings on the main track or a voice track the take sounds
// from its place whatever its head trim (programme.ts, `pauseAskedSec`), so
// the pause before it is kept as it reads now — stated outright, because a
// take with no place of its own there reads the other one, which just moved.

import type { CellData } from "@/hooks/useCells"
import { placeNowMs } from "@/lib/timeline/take-place"

export interface HeldPlace {
  targetOffsetMs: number | null
  recordingsOffsetMs: number | null
}

/**
 * The places to give the saved version of `audioId` when the edit moved its
 * Start by `startMovedMs` inside the recording (negative: earlier). With no
 * move, the take's stored places as they are.
 */
export function placeHoldingStart(cell: CellData, audioId: string, startMovedMs: number, layer: boolean): HeldPlace {
  const att = cell.attachments?.[audioId]
  if (!startMovedMs) return { targetOffsetMs: att?.targetOffsetMs ?? null, recordingsOffsetMs: att?.recordingsOffsetMs ?? null }
  const following = placeNowMs(cell, audioId, "recordings")
  return {
    targetOffsetMs: placeNowMs(cell, audioId, "source") - startMovedMs,
    recordingsOffsetMs: layer ? following - startMovedMs : following,
  }
}

// AQU-2491 (review, Nov 9): WHERE A NEW TAKE SITS ON ITS LINE.
//
// A take with no place of its own reads its LINE's (`target_offset_ms`, the
// fallback rung of `targetAnchorSec` in lib/timeline/lane-timing). Until
// AQU-2491 every recorder save wrote its pre-roll there (-200 ms, more where
// the preview's start had been pulled in), so nearly every line already
// recorded on a timed file still holds one, and nothing writes it any more. A
// take born with no place of its own read that one and started early. So every
// way a take is added gives the new take a place of its own:
//
//   - BORN on a line with times (an upload, a bulk upload, a generated voice,
//     "Voice together"): the line's start, 0, exactly where the recorder puts a
//     take with no pre-roll. A line with no times gets none, as before: it sits
//     on no clock, and there no place already means its slot's start.
//   - MADE FROM another take (Change voice, Join into one recording, and, as
//     they always have, Remove noise and the Station): the place of the take it
//     came from, in both timings. A source with no place of its own reads the
//     line's, and so does the new take, so it lands on its source.
//
// The place is the take's own `cell.audio.place` (the write a drag on the
// timeline makes), sent right after its attach. Its place following the
// recordings is null for a born take: that timing then reads this one.

import type { CellData } from "@/hooks/useCells"
import type { AudioAttachmentOut } from "@/lib/sync/cell-audio-read-types"
import { emitCellAudioPlace } from "@/lib/sync/events-emit"

/** A take's two places, as `cell.audio.place` states them. */
export interface TakePlace {
  targetOffsetMs: number | null
  recordingsOffsetMs: number | null
}

function lineIsTimed(line: Pick<CellData, "startTime"> | null | undefined): boolean {
  return typeof line?.startTime === "number" && Number.isFinite(line.startTime)
}

/** A fresh take's place: its line's start on a line with times, none otherwise. */
export function bornTakePlace(line: Pick<CellData, "startTime"> | null | undefined): TakePlace | null {
  return lineIsTimed(line) ? { targetOffsetMs: 0, recordingsOffsetMs: null } : null
}

/**
 * The recorder's take: placed by its pre-roll (`laneOffsetMs`) when it kept
 * one, otherwise born on its line's start. One rule for Save and the preview,
 * so the picture checked against the take is where Save puts it.
 */
export function recordedTakePlaceMs(
  laneOffsetMs: number | null | undefined,
  line: Pick<CellData, "startTime"> | null | undefined,
): number | null {
  return laneOffsetMs ?? bornTakePlace(line)?.targetOffsetMs ?? null
}

/** A take made from another one keeps that take's own places; none, none. */
export function keptTakePlace(
  from: { targetOffsetMs?: number | null; recordingsOffsetMs?: number | null } | null | undefined,
): TakePlace | null {
  const targetOffsetMs = from?.targetOffsetMs ?? null
  const recordingsOffsetMs = from?.recordingsOffsetMs ?? null
  return targetOffsetMs == null && recordingsOffsetMs == null ? null : { targetOffsetMs, recordingsOffsetMs }
}

export interface PlaceNewTakeInput {
  projectId: string
  fileId: string
  cellId: string
  audioId: string
  place: TakePlace | null | undefined
  targetLang?: string
  author: string
}

/**
 * Write a just-attached take's own place, right after its attach. Returns the
 * event's id, or null when there is no place to write or it could not be
 * queued. Never throws: the take is already attached, and without its place it
 * merely reads its line's, as every take did before.
 */
export async function placeNewTake(input: PlaceNewTakeInput): Promise<string | null> {
  if (!input.place) return null
  try {
    return await emitCellAudioPlace({
      projectId: input.projectId,
      fileId: input.fileId,
      cellId: input.cellId,
      audioId: input.audioId,
      targetOffsetMs: input.place.targetOffsetMs,
      recordingsOffsetMs: input.place.recordingsOffsetMs,
      ...(input.targetLang ? { targetLang: input.targetLang } : {}),
      author: input.author,
    })
  } catch (e) {
    console.warn("[new-take-place] the new take's place could not be queued; it reads its line's", e)
    return null
  }
}

/** The places the optimistic copy carries, so the take is drawn there at once:
 *  only once its place was queued, or the overlay would wait for a place the
 *  server will never have. */
export function placedFields(
  place: TakePlace | null | undefined,
  placeEventId: string | null,
): Pick<AudioAttachmentOut, "targetOffsetMs" | "recordingsOffsetMs"> {
  if (!place || placeEventId == null) return {}
  return {
    ...(place.targetOffsetMs != null ? { targetOffsetMs: place.targetOffsetMs } : {}),
    ...(place.recordingsOffsetMs != null ? { recordingsOffsetMs: place.recordingsOffsetMs } : {}),
  }
}

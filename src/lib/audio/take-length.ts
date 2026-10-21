// How long a take is, as every label of it says it. (AQU-1767, Sam's walk 2026-10-15)
//
// The Recording tab said 2.4s for a split take the recorder called 2.3s. Both
// added up the same pieces; they rounded differently — the tab to the nearest
// tenth, the recorder down, as its target bar prints a length — so a take of
// 2.35s and more read differently in two places a click apart. One definition
// and one rounding, here, for the Recording tab, the recorder's selected take
// and the takes lists.

import { effectiveAttachmentDurationMs } from "@/lib/timeline/lane-timing"

interface PieceTimes {
  durationMs?: number | null
  trimStartMs?: number | null
  trimEndMs?: number | null
}

/**
 * What a take plays, in ms: its kept part, or for a split take the sum of its
 * pieces' kept parts (the space between pieces does not play). Null when no
 * piece has a known length.
 */
export function takePlayedMs(pieces: readonly PieceTimes[]): number | null {
  let total = 0
  let known = false
  for (const piece of pieces) {
    const ms = effectiveAttachmentDurationMs({
      durationMs: piece.durationMs ?? undefined,
      trimStartMs: piece.trimStartMs ?? undefined,
      trimEndMs: piece.trimEndMs ?? undefined,
    })
    if (ms == null) continue
    total += ms
    known = true
  }
  return known ? total : null
}

/** "2.3": seconds in tenths, rounded DOWN — as the recorder's target bar
 *  (DurationBar) prints a length, which must never disagree with the label. */
export function formatTakeSeconds(ms: number): string {
  return (Math.floor(Math.max(0, Math.round(ms)) / 100) / 10).toFixed(1)
}

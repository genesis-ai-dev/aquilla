// Sam, question 93: the Export dialog's "Mono loudness" — "As heard" (the
// default) or "As a single-channel meter reads it". A mono file plays on both
// speakers, so it sounds about 3 dB louder than one channel measures; a
// delivery that checks mono files on a loudness meter wants the meter reading.
//
// With the meter choice, this stamps every EVENED take of a mono export with
// `monoLoudness: "meter"`; the one gain rule (take-gain.ts, through
// clip-level.ts `exportGainDb`) then evens it MONO_METER_OFFSET_DB hotter, under
// the same +12 dB cap and −1 dBTP ceiling (a take the ceiling holds back is
// `held`, as always). Every export path reads that one rule once: by line and
// assembly from the take, by chapter and by character from the clip record
// `levelFields` builds. Unevened takes and stereo output are untouched, and
// playback never sees the stamp: it always plays as heard.
//
// Every audio export writes mono today (decode-mono → 16-bit mono WAV), so
// `channels` defaults to 1; a stereo export would pass 2 and be left alone.

import type { CellData } from "@/hooks/useCells"
import { evenOutCorrection } from "@/lib/audio/take-gain"

export type MonoLoudness = "heard" | "meter"

export function withMonoLoudness(cells: CellData[], mode: MonoLoudness, opts: { channels?: number } = {}): CellData[] {
  if (mode !== "meter" || (opts.channels ?? 1) !== 1) return cells
  return cells.map((cell) => {
    const atts = cell.attachments
    if (!atts) return cell
    let changed = false
    const next: Record<string, unknown> = {}
    for (const [id, att] of Object.entries(atts)) {
      if (att && att.evenTargetLufs != null && att.role !== "source") {
        next[id] = { ...att, monoLoudness: "meter" }
        changed = true
      } else next[id] = att
    }
    return changed ? ({ ...cell, attachments: next } as CellData) : cell
  })
}

/** Re-check S4: how many evened takes the meter reading holds back (the
 *  −1 dBTP ceiling or the +12 dB cap), so the dialog can say so. Same rule
 *  as the export, read once per take. */
export function monoMeterHeldCount(cells: readonly CellData[]): number {
  let n = 0
  for (const cell of cells) {
    for (const att of Object.values(cell.attachments ?? {})) {
      if (!att || att.isDeleted || att.role === "source" || att.evenTargetLufs == null) continue
      if (evenOutCorrection({ ...att, monoLoudness: "meter" }).held) n++
    }
  }
  return n
}

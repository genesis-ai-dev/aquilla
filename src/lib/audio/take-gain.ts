// AQU-2664: how loud a take plays — ONE rule, read by the playback mixer
// (mixer.ts `clipLevelOf`) and by every export (export/clip-level.ts), so the
// app and the files it writes can never disagree.
//
//     plays at = its own volume (gain_db, the Station's line)
//              + the evening-out correction, when the take is evened out
//
//     correction = target - measured loudness,
//                  held within ±20 dB,
//                  and, when it raises the take, only as far as the take's
//                  true peak (after its own volume) stays under -1 dBTP.
//
// WHY THESE LIMITS.
// - ±20 dB: far enough for a laptop-mic take at -36 LUFS to reach -16, and
//   for a hot generated voice to come down, but a near-silent take (room tone,
//   a mis-cut sliver) is not raised into a wall of hiss. The brief's own pick
//   was +12; the ticket's example was ±20. ±20 keeps one symmetric number.
// - -1 dBTP: the ceiling EBU R128, Apple Podcasts and AES all use. Raising
//   past it would distort on any player, so the take is raised "as far as it
//   cleanly goes" and `held` says so (brief decision 6), instead of being
//   squashed by a limiter. The mixer's own peak guard and the exports'
//   `guardPeak` stay for places where takes SUM.
// - The peak rule only ever HOLDS BACK a raise; it never turns a take down
//   below where its own volume puts it. Its own volume is the person's call.
// - Nothing happens until the take is measured, and a take with nothing above
//   the -70 LUFS gate (silence) has nothing to even out.
//
// The correction is never stored: the take stores its measurement and the
// target it was evened to, and this computes the rest. So clearing is setting
// the target to null, and a take measured after it was evened out simply
// starts playing at the target.

import { SILENT_LUFS } from "./loudness"

/** The level takes are evened out to unless the caller names another. */
export const DEFAULT_EVEN_TARGET_LUFS = -16
/** How far evening out may move a take, either way. */
export const MAX_EVEN_CORRECTION_DB = 20
/** No raised take's true peak goes above this. */
export const PEAK_CEILING_DBTP = -1

/** The stored fields the rule reads (CodexCellAttachment / AudioAttachmentOut). */
export interface TakeGainFields {
  /** Its own volume, dB; null = as recorded. */
  gainDb?: number | null
  /** Integrated loudness of the recording, LUFS (cell.audio.measure); null = not measured. */
  loudnessLufs?: number | null
  /** True peak of the recording, dBTP. */
  truePeakDb?: number | null
  /** The target it was evened out to, LUFS (cell.audio.gain); null = not evened out. */
  evenTargetLufs?: number | null
}

export interface TakeGain {
  /** What it plays at, dB: its own volume plus the correction. */
  gainDb: number
  /** Its own volume, dB. */
  ownDb: number
  /** The evening-out part, dB (0 when not evened, not measured or silent). */
  correctionDb: number
  /** What evening out asked for before the limits (0 when not evened). */
  wantedDb: number
  /** Why the correction is less than asked: the ±20 dB range, or the peak. */
  held: "range" | "peak" | null
  /** Whether the take has a loudness reading. */
  measured: boolean
  /** Whether the take is evened out (it has a target). */
  evened: boolean
}

const num = (v: number | null | undefined): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null)

/** The whole answer: what it plays at, and why. */
export function takeGain(att: TakeGainFields | null | undefined): TakeGain {
  const ownDb = num(att?.gainDb) ?? 0
  const loudness = num(att?.loudnessLufs)
  const peak = num(att?.truePeakDb)
  const target = num(att?.evenTargetLufs)
  const flat: TakeGain = { gainDb: ownDb, ownDb, correctionDb: 0, wantedDb: 0, held: null, measured: loudness != null, evened: target != null }
  if (target == null || loudness == null || loudness <= SILENT_LUFS) return flat
  const wantedDb = target - loudness
  let correctionDb = Math.max(-MAX_EVEN_CORRECTION_DB, Math.min(MAX_EVEN_CORRECTION_DB, wantedDb))
  let held: TakeGain["held"] = correctionDb !== wantedDb ? "range" : null
  if (correctionDb > 0) {
    const room = peak == null ? 0 : Math.max(0, PEAK_CEILING_DBTP - (peak + ownDb))
    if (correctionDb > room) {
      correctionDb = room
      held = "peak"
    }
  }
  return { ...flat, gainDb: ownDb + correctionDb, correctionDb, wantedDb, held }
}

/** What the take plays at, dB: the number the mixer and the exports apply. */
export function takeGainDb(att: TakeGainFields | null | undefined): number {
  return takeGain(att).gainDb
}

// AQU-2664: how loud a take plays — ONE rule, read by the playback mixer
// (mixer.ts `clipLevelOf`) and by every export (export/clip-level.ts), so the
// app and the files it writes can never disagree.
//
// THE STAGES, in order (Sam, Nov 19: "I do not want normalization to override
// volume automation"; evening out works like Logic's region gain):
//
//     recording
//       → evening-out correction      (its own stage, from its own field)
//       → the take's own volume       (gain_db, the Station's line)
//         and fades
//       → track volume → main volume  (the mixer's track and master nodes)
//       → peak guard                  (the mixer's limiter / exports' guardPeak)
//
// The correction depends on the RECORDING AND THE TARGET ALONE:
//
//     correction = target − measured loudness,
//                  a raise at most +12 dB, a cut at most −20 dB,
//                  and a raise only as far as the recording's true peak
//                  stays under −1 dBTP.
//
// So a person's volume reads relative to the evened level — 0 dB means "as
// evened" — and evening out (running, re-running, clearing) only ever replaces
// its own stored target, never gain_db, the fades or a track's volume. Any
// later automation also sits after it. The peak guard at the end of the chain
// holds the SUM of every stage under full scale.
//
// WHY THESE LIMITS.
// - +12 dB raise: the audio brief's pick (§3.2), Sam's cap for the correction
//   alone — a near-silent take (room tone, a mis-cut sliver) is not raised
//   into a wall of hiss. −20 dB cut: a hot generated voice can always come
//   down. Turning down never distorts, so the cut needs no tighter limit.
// - −1 dBTP: the ceiling EBU R128, Apple Podcasts and AES use. The correction
//   raises a take "as far as it cleanly goes" and `held` says so (brief
//   decision 6), rather than leaning on the limiter.
// - Nothing happens until the take is measured (the fallback: unmeasured =
//   its own volume, exactly as before), and a take with nothing above the
//   −70 LUFS gate (silence) has nothing to even out.
//
// The correction is never stored as a number: the take stores its reading and
// the target it was evened to, and this computes the rest. So clearing is
// setting the target to null, and a take measured after it was evened out
// simply starts playing at the target.

import { SILENT_LUFS } from "./loudness"

/** The level takes are evened out to unless the caller names another. */
export const DEFAULT_EVEN_TARGET_LUFS = -16
/** The most evening out raises a take. */
export const MAX_EVEN_RAISE_DB = 12
/** The most evening out turns a take down. */
export const MAX_EVEN_CUT_DB = 20
/** No take is raised by evening out past this true peak. */
export const PEAK_CEILING_DBTP = -1

/** The stored fields the rule reads (CodexCellAttachment / AudioAttachmentOut). */
export interface TakeGainFields {
  /** Its own volume, dB; null = as evened (or as recorded). */
  gainDb?: number | null
  /** Integrated loudness of the recording, LUFS (cell.audio.measure); null = not measured. */
  loudnessLufs?: number | null
  /** True peak of the recording, dBTP. */
  truePeakDb?: number | null
  /** The target it was evened out to, LUFS (cell.audio.even); null = not evened out. */
  evenTargetLufs?: number | null
}

export type GainStage = { stage: "evenOut" | "ownVolume"; db: number }

export interface TakeGain {
  /** What the take's stages add up to, dB (before its fades and the track). */
  gainDb: number
  /** Its own volume, dB (stage 2). */
  ownDb: number
  /** The evening-out correction, dB (stage 1; 0 when not evened, not measured or silent). */
  correctionDb: number
  /** The take's stages in the order they apply. */
  stages: GainStage[]
  /** What evening out asked for before the limits (0 when not evened). */
  wantedDb: number
  /** Why the correction is less than asked: the +12/−20 range, or the peak. */
  held: "range" | "peak" | null
  /** Whether the take has a loudness reading. */
  measured: boolean
  /** Whether the take is evened out (it has a target). */
  evened: boolean
}

const num = (v: number | null | undefined): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null)

/** Stage 1 alone: the evening-out correction, from the recording and the target. */
export function evenOutCorrection(att: TakeGainFields | null | undefined): { correctionDb: number; wantedDb: number; held: TakeGain["held"] } {
  const loudness = num(att?.loudnessLufs)
  const peak = num(att?.truePeakDb)
  const target = num(att?.evenTargetLufs)
  if (target == null || loudness == null || loudness <= SILENT_LUFS) return { correctionDb: 0, wantedDb: 0, held: null }
  const wantedDb = target - loudness
  let correctionDb = Math.max(-MAX_EVEN_CUT_DB, Math.min(MAX_EVEN_RAISE_DB, wantedDb))
  let held: TakeGain["held"] = correctionDb !== wantedDb ? "range" : null
  if (correctionDb > 0) {
    // An unknown peak can't be raised safely.
    const room = peak == null ? 0 : Math.max(0, PEAK_CEILING_DBTP - peak)
    if (correctionDb > room) {
      correctionDb = room
      held = "peak"
    }
  }
  return { correctionDb, wantedDb, held }
}

/** The whole answer: the take's stages, what they add up to, and why. */
export function takeGain(att: TakeGainFields | null | undefined): TakeGain {
  const ownDb = num(att?.gainDb) ?? 0
  const { correctionDb, wantedDb, held } = evenOutCorrection(att)
  return {
    gainDb: correctionDb + ownDb,
    ownDb,
    correctionDb,
    stages: [{ stage: "evenOut", db: correctionDb }, { stage: "ownVolume", db: ownDb }],
    wantedDb,
    held,
    measured: num(att?.loudnessLufs) != null,
    evened: num(att?.evenTargetLufs) != null,
  }
}

/** What the take's stages add up to, dB: the number the mixer's take node
 *  and every export apply (then its fades, then the track and main). */
export function takeGainDb(att: TakeGainFields | null | undefined): number {
  return takeGain(att).gainDb
}

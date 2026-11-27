// AQU-2664 review M1: a take's level in the Station, by the one rule
// (lib/audio/take-gain.ts). The volume line edits `ownDb` only, relative to
// the evened level; the preview plays and draws `playDb`.
import { takeGain, type TakeGainFields } from "@/lib/audio/take-gain"

export function stationLevelOf(att: TakeGainFields | null | undefined): { correctionDb: number; ownDb: number; playDb: number } {
  const g = takeGain(att)
  return { correctionDb: g.correctionDb, ownDb: g.ownDb, playDb: g.gainDb }
}

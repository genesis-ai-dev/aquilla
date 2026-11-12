// Voices, speech rails (AQU-1687).
//
// A cell inside a quotation draws one thin rail per open quote level at its
// inline-start edge, with a cap where a speech opens or closes. This module
// works out, for one cell, which levels are open at its start and at its end
// and which speeches open or close inside it. Pure.
//
// Each cell's segment comes from the speeches' own spans (first and last word)
// compared with the cell's words, not from its neighbours. So a row can draw
// its own segment with no cross-row overlay (the editor list is virtualized),
// and a speech interrupted by a whole verse of narration still reads as open.
//
// Spec: 05-user-stories/see-who-is-speaking.md (Acceptance criteria);
// design doc §8.4 "Speech rails".

import type { BkpSpeech } from "./pack-types"
import type { CellVoices, VoiceIndex } from "./voice-index"

/** Deeper quotations are rare (13 level-3 speeches in the whole NT) and draw no rail of their own. */
export const MAX_RAIL_LEVELS = 3
export type RailLevel = 1 | 2 | 3

/** What one speech does in the cell. */
export type SpeechRailState = "begins" | "continues" | "ends" | "begins-and-ends"

/**
 * How the cell draws one level's rail:
 *   continue — open at both edges, nothing opens or closes inside;
 *   begin    — opens inside, still open at the end (cap at the top);
 *   end      — open at the start, closes inside (cap at the bottom);
 *   both     — opens and closes inside (caps at both ends);
 *   break    — one speech closes and the next opens inside (two pieces).
 */
export type RailShape = "continue" | "begin" | "end" | "both" | "break"

export interface RailSpeech {
  speech: BkpSpeech
  state: SpeechRailState
}

export interface RailSegment {
  level: RailLevel
  shape: RailShape
  /** The level's speeches in this cell, in reading order. */
  speeches: readonly RailSpeech[]
}

function isRailLevel(level: number): level is RailLevel {
  return level >= 1 && level <= MAX_RAIL_LEVELS
}

/**
 * The rail a speech draws on, or null. The narrator (level 0) draws none.
 * Self-projected speeches ("I tell you that …") add no quote level: the pack
 * already leaves them out of `level`, which therefore equals their parent's.
 * They draw nothing of their own, or the parent's rail would look closed and
 * reopened in the middle of one quotation.
 */
export function railLevelOf(speech: BkpSpeech): RailLevel | null {
  if (speech.selfProjected) return null
  return isRailLevel(speech.level) ? speech.level : null
}

function stateOf(speech: BkpSpeech, first: string, last: string): SpeechRailState {
  // The speech touches the cell, so it starts before the cell ends and ends
  // after the cell starts.
  const opens = speech.from >= first
  const closes = speech.to <= last
  if (opens && closes) return "begins-and-ends"
  if (opens) return "begins"
  if (closes) return "ends"
  return "continues"
}

function shapeOf(speeches: readonly RailSpeech[]): RailShape {
  const openAtStart = speeches.some(({ state }) => state === "continues" || state === "ends")
  const openAtEnd = speeches.some(({ state }) => state === "continues" || state === "begins")
  if (openAtStart && openAtEnd) {
    return speeches.some(({ state }) => state !== "continues") ? "break" : "continue"
  }
  if (openAtStart) return "end"
  if (openAtEnd) return "begin"
  return "both"
}

/** The cell's rail segments, one per open quote level, shallowest first. */
export function railSegments(index: VoiceIndex, cell: CellVoices): RailSegment[] {
  const [first, last] = cell.range
  const byLevel = new Map<RailLevel, RailSpeech[]>()
  const seen = new Set<string>()
  for (const ref of cell.refs) {
    for (const speech of index.touching.get(ref) ?? []) {
      if (seen.has(speech.id)) continue
      seen.add(speech.id)
      const level = railLevelOf(speech)
      if (level === null) continue
      const list = byLevel.get(level) ?? []
      list.push({ speech, state: stateOf(speech, first, last) })
      byLevel.set(level, list)
    }
  }
  const segments: RailSegment[] = []
  for (const [level, speeches] of [...byLevel.entries()].sort(([a], [b]) => a - b)) {
    speeches.sort((a, b) => (a.speech.from < b.speech.from ? -1 : a.speech.from > b.speech.from ? 1 : 0))
    segments.push({ level, shape: shapeOf(speeches), speeches })
  }
  return segments
}

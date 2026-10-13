// Timeline for IntelligentProgress (see that file for the design rule). Pure,
// so the two-stage behaviour is testable without rendering.

export const FIRST_MS = 900
export const SECOND_MS = 2400
/** The second bar parks here while still waiting, and breathes. */
export const SECOND_HOLD = 0.92
export const FINISH_MS = 180
export const FADE_MS = 140

export type ProgressPhase = "first" | "second" | "finishing" | "done"

export interface ProgressFrame {
  phase: ProgressPhase
  /** 0..1 fill of the base bar. */
  first: number
  /** 0..1 fill of the bolder second bar. */
  second: number
  /** CSS transition duration (ms) to reach this frame. */
  ms: number
}

/** The frame to move to next. Pure, so the timeline is testable. */
export function nextFrame(current: ProgressPhase, pending: boolean): ProgressFrame {
  if (!pending) {
    if (current === "first") return { phase: "finishing", first: 1, second: 0, ms: FINISH_MS }
    if (current === "second") return { phase: "finishing", first: 1, second: 1, ms: FINISH_MS }
    return { phase: "done", first: 1, second: current === "finishing" ? 1 : 0, ms: FADE_MS }
  }
  if (current === "first") return { phase: "second", first: 1, second: SECOND_HOLD, ms: SECOND_MS }
  return { phase: current, first: 1, second: SECOND_HOLD, ms: 0 }
}

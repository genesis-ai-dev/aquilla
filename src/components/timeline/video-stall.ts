// Noticing that the picture has stopped, when the picture will not say so.
// (AQU-646, 2026-08-18)
//
// Sam, twice, a round apart: "it plays for like half a second… and then it just
// is stuck, even though the button is showing that it's unpaused." The first
// attempt at this listened for `waiting` and `stalled`, on the reasoning that a
// browser announces its own rebuffering. Safari does not announce THIS. The
// element keeps `paused === false`, keeps reporting a healthy `readyState`, and
// simply stops producing frames — no event of any kind. So the pane learned
// nothing, and every guard written in terms of `readyState` asked the wedged
// element whether it was wedged and believed the answer.
//
// The only honest witness is the clock. If the transport wants playback, and
// the element claims to be running, and `currentTime` has not moved, then it is
// not playing — whatever it says, and whatever it fired or did not fire. That
// test needs no cooperation from the browser, which is why it will still be
// right for whatever Safari does next.
//
// Pure, and shaped like `video-sync.ts` next door: the component samples and
// executes, the decision lives here where it can be tested without a DOM, a
// timer, or a media pipeline.

/** How often the pane samples the clock. */
export const STALL_TICK_MS = 1000

/** Samples of frozen clock, while the element claims to be running, before we
 *  believe it. Two — an ordinary rebuffer gets a moment to resolve itself, and
 *  two seconds of a still picture is already longer than anyone waits without
 *  reaching for the button. */
export const STALL_FROZEN_TICKS = 2

/** Samples of real motion before the escalation budget resets.
 *
 *  THIS IS THE ONE THAT MATTERS. Each rung of the ladder buys a twitch of
 *  playback — that is what a nudge DOES — so a budget reset by any motion at
 *  all would sit on rung one forever: nudge, twitch, freeze, nudge, twitch,
 *  freeze, never escalating and never getting out. Only sustained playback
 *  counts as recovery. */
export const STALL_SETTLED_TICKS = 3

/** Seconds of advance that count as the clock having moved. Small enough that
 *  a slowed-down film still qualifies (a quarter-speed sample advances 0.25s),
 *  large enough that floating-point noise does not. */
export const STALL_MOTION_EPS = 0.01

/** The ladder, in order. Each is a genuinely different attempt, not the same
 *  one louder: re-fetch at the same position; ask the pipeline to recover; then
 *  throw the pipeline away and build a new one. */
export type StallRung = "nudge" | "recover" | "rebuild"
const RUNGS: readonly StallRung[] = ["nudge", "recover", "rebuild"]

export type StallAction =
  /** Nothing to do, which is the overwhelmingly common answer. */
  | { kind: "none" }
  /** Believed stalled: report it, and try this. */
  | { kind: "recover"; rung: StallRung }
  /** Out of ideas. Stop claiming anything and offer the click that does work. */
  | { kind: "giveUp" }
  /** Moving again after a stall: take the spinner down and say so. */
  | { kind: "recovered" }

export interface StallState {
  /** Where the clock was at the previous sample. Null means "no baseline" —
   *  the next sample only establishes one, it never judges. */
  lastSec: number | null
  frozenTicks: number
  healthyTicks: number
  /** Rungs spent on THIS episode. Reset only by sustained playback. */
  spent: number
  /** Whether we are currently telling the world it has stopped. */
  stalled: boolean
  /** The ladder ran out. No further attempts until something resets us. */
  gaveUp: boolean
}

export const IDLE_STALL_STATE: StallState = {
  lastSec: null,
  frozenTicks: 0,
  healthyTicks: 0,
  spent: 0,
  stalled: false,
  gaveUp: false,
}

export interface StallSample {
  /** The element's `currentTime`. */
  sec: number
  /** What the TRANSPORT wants — not what the element claims. */
  wantPlay: boolean
  paused: boolean
  ended: boolean
  seeking: boolean
  /** True while the readiness gate is holding a start. That wait owns its own
   *  patience and its own spinner; two owners would fight over both. */
  pendingPlay: boolean
}

/**
 * Forget the baseline without forgetting the episode.
 *
 * After a rebuild the element is a different one, its clock starts at zero and
 * is then restored — a jump the sampler must not read as either motion or a
 * freeze. The BUDGET survives, because the episode has not ended just because
 * we replaced the player.
 */
export function forgetStallSample(state: StallState): StallState {
  return { ...state, lastSec: null, frozenTicks: 0, healthyTicks: 0 }
}

/**
 * One sample.
 *
 * Enter a stall after two frozen samples; leave it on the first moving one
 * (hysteresis, so a half-second twitch cannot flap the button between spinner
 * and playing); reset the ladder only after three moving ones.
 */
export function stallStep(
  state: StallState,
  sample: StallSample,
): { state: StallState; action: StallAction } {
  // Not our business. A paused, ended, seeking or not-yet-started picture is
  // frozen for reasons that already have owners, and reading any of them as a
  // stall would put a spinner over a film the user themselves stopped.
  if (
    !sample.wantPlay
    || sample.paused
    || sample.ended
    || sample.seeking
    || sample.pendingPlay
  ) {
    return {
      // The baseline goes too: resuming from a position we last saw minutes ago
      // would otherwise read as a huge jump forward, or after a backwards seek
      // as a freeze.
      state: { ...state, lastSec: null, frozenTicks: 0, healthyTicks: 0, stalled: false },
      action: { kind: "none" },
    }
  }

  const prev = state.lastSec
  const base = { ...state, lastSec: sample.sec }
  // The first sample of a run establishes the baseline and judges nothing.
  if (prev == null) {
    return { state: { ...base, frozenTicks: 0, healthyTicks: 0 }, action: { kind: "none" } }
  }

  if (sample.sec > prev + STALL_MOTION_EPS) {
    const healthyTicks = state.healthyTicks + 1
    const settled = healthyTicks >= STALL_SETTLED_TICKS
    return {
      state: {
        ...base,
        frozenTicks: 0,
        healthyTicks,
        stalled: false,
        // Sustained playback, and only that, buys the ladder back.
        spent: settled ? 0 : state.spent,
        gaveUp: settled ? false : state.gaveUp,
      },
      action: state.stalled ? { kind: "recovered" } : { kind: "none" },
    }
  }

  const frozenTicks = state.frozenTicks + 1
  if (frozenTicks < STALL_FROZEN_TICKS) {
    return { state: { ...base, frozenTicks, healthyTicks: 0 }, action: { kind: "none" } }
  }

  // Believed. The counter restarts so the next rung is another patience window
  // away rather than firing on the very next sample.
  const next = { ...base, frozenTicks: 0, healthyTicks: 0, stalled: true }
  if (state.gaveUp) return { state: next, action: { kind: "none" } }
  const rung = RUNGS[state.spent]
  if (rung) return { state: { ...next, spent: state.spent + 1 }, action: { kind: "recover", rung } }
  return { state: { ...next, gaveUp: true }, action: { kind: "giveUp" } }
}

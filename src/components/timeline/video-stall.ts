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

/** AQU-2253 (review, Nov 13): how long a film may load nothing new, while it is
 *  wanted and has not loaded past where it stands, before the wait stops and
 *  the pane says the film isn't arriving. A minute: far past a slow network
 *  that is still delivering (anything new loaded starts it again), and the one
 *  ceiling on waiting for the network, through a seek or a stall alike. */
export const FILM_NOT_ARRIVING_SEC = 60
const NOT_ARRIVING_TICKS = Math.round((FILM_NOT_ARRIVING_SEC * 1000) / STALL_TICK_MS)

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
  /** AQU-2253 (browser pass, Nov 11): believed stalled, but the film has played
   *  out what it loaded: say so (the spinner) and wait for the network. */
  | { kind: "wait" }
  /** AQU-2253 (review, Nov 13): nothing new has loaded for
   *  FILM_NOT_ARRIVING_SEC. Stop waiting, stop claiming anything, and say why. */
  | { kind: "notArriving" }

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
  /** AQU-2253 (review, Nov 13): samples in a row, while wanted and not loaded
   *  past where it stands, with nothing new loaded. */
  starvedTicks: number
  /** How far the film had loaded at the previous sample; null: no baseline. */
  loadedEnd: number | null
}

export const IDLE_STALL_STATE: StallState = {
  lastSec: null,
  frozenTicks: 0,
  healthyTicks: 0,
  spent: 0,
  stalled: false,
  gaveUp: false,
  starvedTicks: 0,
  loadedEnd: null,
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
  /** AQU-2253 (review, Nov 9): the still clock is a seek that never landed
   *  (`watchSeek`). Its ladder starts past the nudge, which seeks again: a
   *  second seek in flight is what wedges the streaming player
   *  (video-seek-coalesce.ts). */
  seekStuck?: boolean
  /** AQU-2253 (browser pass, Nov 11): has the film loaded past where it stands
   *  (`seekTargetLoaded`)? False: it is waiting on the network, and only the
   *  nudge is tried; the rungs that throw away what has loaded (reopening,
   *  rebuilding) are kept for loaded film that stops. Left out: loaded. */
  loadedAhead?: boolean
  /** AQU-2253 (review, Nov 13): the furthest second the film has loaded to
   *  (0 for nothing). Its not advancing is what counts toward the ceiling. */
  loadedEnd?: number
}

/** AQU-2253 (browser pass, Nov 9): how far past a seek's target the film must
 *  have loaded before a seek that has still not landed can count as stuck. */
export const SEEK_LOADED_AHEAD_SEC = 1

/**
 * AQU-2253 (review, Nov 9): how long a seek over film that has already loaded
 * may go on before it counts as stuck. Such a seek normally lands in a fraction
 * of a second, and even a slow one (a busy iPad, Safari with the streaming
 * player, a seek right after a quality switch) within a second or two; the
 * WebKit wedge it is for never lands. Five seconds is well past any healthy
 * seek of this kind, so it never judges one, and short of the point where
 * someone looking at a still picture gives up.
 */
export const SEEK_STUCK_MS = 5_000

/** The slice of `TimeRanges` read here. */
export interface LoadedRanges {
  readonly length: number
  start(index: number): number
  end(index: number): number
}

/**
 * AQU-2253 (browser pass, Nov 9): has the film loaded where it was sent: one
 * loaded range from the target to a second past it (or to the film's end)?
 */
export function seekTargetLoaded(video: {
  currentTime: number
  duration: number
  buffered?: LoadedRanges | null
}): boolean {
  const loaded = video.buffered
  if (!loaded) return false
  const at = video.currentTime
  const end = Number.isFinite(video.duration) && video.duration > 0
    ? Math.min(at + SEEK_LOADED_AHEAD_SEC, video.duration)
    : at + SEEK_LOADED_AHEAD_SEC
  for (let i = 0; i < loaded.length; i++) {
    if (loaded.start(i) <= at + STALL_MOTION_EPS && loaded.end(i) >= end - 0.1) return true
  }
  return false
}

/** AQU-2253 (review, Nov 13): the furthest second the film has loaded to, 0
 *  for nothing (`StallSample.loadedEnd`). */
export function loadedEndOf(loaded: LoadedRanges | null | undefined): number {
  let end = 0
  if (!loaded) return end
  for (let i = 0; i < loaded.length; i++) end = Math.max(end, loaded.end(i))
  return end
}

/** Since when the element has been seeking to `target` with it loaded. */
export interface SeekWatch {
  since: number | null
  target: number | null
}

export const IDLE_SEEK_WATCH: SeekWatch = { since: null, target: null }

/**
 * AQU-2253 (review, Nov 9): one sample of a seek. WebKit was seen to leave a
 * seek past what had loaded unfinished for good, though the film went on to
 * load all of it: seeking, not paused, enough data, a still clock. A seeking
 * film is the network's business, so the watchdog never looked, and the
 * picture stayed still for good.
 *
 * A seek counts as STUCK only when all of these hold: the element has been
 * seeking for `SEEK_STUCK_MS`; the film has been loaded a second past the
 * target for all of that time; no `seeked` came (the pane resets the watch on
 * one); and nobody asked for another seek meanwhile (`askedAt`, the newest
 * seek the person or the app asked for, even one held back while this one is
 * in flight). Scrubbing, Previous line and the film following the queue all
 * ask for seeks, so they never trip it; a seek into film that has not loaded
 * is waited on however long it takes.
 */
export function watchSeek(
  watch: SeekWatch,
  sample: { seeking: boolean; sec: number; loaded: boolean; now: number; askedAt: number | null },
): { watch: SeekWatch; stuck: boolean } {
  if (!sample.seeking || !sample.loaded) return { watch: IDLE_SEEK_WATCH, stuck: false }
  const same = watch.since != null && watch.target != null && Math.abs(watch.target - sample.sec) <= STALL_MOTION_EPS
  let since = same ? watch.since! : sample.now
  if (sample.askedAt != null && sample.askedAt > since) since = sample.askedAt
  return { watch: { since, target: sample.sec }, stuck: sample.now - since >= SEEK_STUCK_MS }
}

/**
 * AQU-2253 (review, Nov 9): can this browser play a stream (HLS) with its own
 * player? Safari can; Chromium and Firefox cannot, and a streamed film handed
 * to their own player does not play at all.
 */
export function browserPlaysHls(video: { canPlayType?: (type: string) => string }): boolean {
  try {
    return Boolean(video.canPlayType?.("application/vnd.apple.mpegurl"))
  } catch {
    return false
  }
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
  return { ...state, lastSec: null, frozenTicks: 0, healthyTicks: 0, loadedEnd: null }
}

/**
 * One sample.
 *
 * Enter a stall after two frozen samples; leave it on the first moving one
 * (hysteresis, so a half-second twitch cannot flap the button between spinner
 * and playing); reset the ladder only after three moving ones.
 */
export function stallStep(
  prior: StallState,
  sample: StallSample,
): { state: StallState; action: StallAction } {
  // AQU-2253 (review, Nov 13): the one ceiling on waiting for the network. A
  // film wanted, not loaded past where it stands, and loading nothing new
  // (through a seek or a stall alike) is waited on for FILM_NOT_ARRIVING_SEC,
  // then given up on with the reason. Anything new loaded starts the minute
  // again; a pause, a film no longer wanted, or one that has loaded ends it.
  const wanted = sample.wantPlay && !sample.paused && !sample.ended
  const end = sample.loadedEnd ?? 0
  const starvedTicks = !wanted || sample.loadedAhead !== false
    ? 0
    : prior.loadedEnd == null
      ? prior.starvedTicks
      : end > prior.loadedEnd + STALL_MOTION_EPS ? 0 : prior.starvedTicks + 1
  const state: StallState = { ...prior, starvedTicks, loadedEnd: wanted ? end : null }
  if (starvedTicks >= NOT_ARRIVING_TICKS && !state.gaveUp) {
    return {
      state: { ...state, lastSec: null, frozenTicks: 0, healthyTicks: 0, starvedTicks: 0, stalled: false, gaveUp: true },
      action: { kind: "notArriving" },
    }
  }

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
        starvedTicks: 0,
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
  // AQU-2253 (review, Nov 9): never a re-seek on top of a seek in flight.
  const spent = sample.seekStuck && RUNGS[state.spent] === "nudge" ? state.spent + 1 : state.spent
  const rung = RUNGS[spent]
  // AQU-2253 (browser pass, Nov 11): a film waiting on the network is waited
  // on, as a seek into film that has not loaded is: asked to fetch again once
  // (the nudge), never emptied to reopen or rebuild it. (Review, Nov 13: up to
  // the ceiling above.)
  if (sample.loadedAhead === false && rung !== "nudge") return { state: next, action: { kind: "wait" } }
  if (rung) return { state: { ...next, spent: spent + 1 }, action: { kind: "recover", rung } }
  return { state: { ...next, gaveUp: true }, action: { kind: "giveUp" } }
}

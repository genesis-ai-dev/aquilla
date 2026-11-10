// The app's one playback mixer (AQU-2327, slice 8; the audio-levels plan's
// phase 1b reuses it to even out takes). Built on the ONE long-lived output
// context (output-context.ts says why there is only one):
//
//     element ─▶ take gain (its volume, its fades) ─▶ track gain ─▶ main volume ─▶ peak guard ─▶ out
//
// Why a graph at all: an <audio> element's `volume` can only turn a take DOWN
// (it stops at 1), iPhone and iPad ignore it entirely, and a fade has to land
// on the sample, not on the next timer tick. A take's volume and fades are
// data on the clip (cell.audio.gain); this is where playback honours them, so
// the timeline sounds like the Station and like the exports.
//
// WHICH ELEMENTS. Only elements whose sound is same-origin can feed a graph:
// a cross-origin stream without CORS plays SILENCE once routed. Takes play
// from blob URLs (the bytes cache), so they are routed; a stream URL is left
// on its own `volume` (it can still be turned down) until stream elements are
// proven with `crossOrigin` in every browser (the worker already answers `*`).
// Where there is no AudioContext at all (the unit suite), nothing is routed
// and every element keeps `volume`, exactly as before.

import { getOutputContext, peekOutputContext } from "./output-context"

/** A take's level on its own clock: its volume, its fades, its kept part. */
export interface ClipLevel {
  gainDb: number
  fadeInSec: number
  fadeOutSec: number
  /** The kept part on the clip's own clock (its trim). */
  startSec: number
  /** Null = the clip's natural end (unknown until it is measured). */
  endSec: number | null
}

export const FLAT_LEVEL: ClipLevel = { gainDb: 0, fadeInSec: 0, fadeOutSec: 0, startSec: 0, endSec: null }

/** A take's stored level (CodexCellAttachment fields), or null when it has none. */
export function clipLevelOf(att: {
  gainDb?: number | null
  fadeInMs?: number | null
  fadeOutMs?: number | null
  trimStartMs?: number | null
  trimEndMs?: number | null
  durationMs?: number | null
} | null | undefined): ClipLevel | null {
  if (!att) return null
  const gainDb = att.gainDb ?? 0
  const fadeInSec = (att.fadeInMs ?? 0) / 1000
  const fadeOutSec = (att.fadeOutMs ?? 0) / 1000
  if (!gainDb && !fadeInSec && !fadeOutSec) return null
  const end = att.trimEndMs ?? att.durationMs ?? null
  return { gainDb, fadeInSec, fadeOutSec, startSec: (att.trimStartMs ?? 0) / 1000, endSec: end != null ? end / 1000 : null }
}

/**
 * AQU-2494 (review, Nov 9): a clip made of several takes' kept parts back to
 * back — a cut take joined into one copy for playback following the
 * recordings. One level per part, in order, each on the COPY's clock (where
 * that part starts and ends in it). A single take is still one ClipLevel.
 */
export type ClipLevels = ClipLevel | readonly ClipLevel[]

const isParts = (l: ClipLevels): l is readonly ClipLevel[] => Array.isArray(l)

/**
 * The levels of a joined copy from its pieces: each piece's window on the
 * recording's clock, the silence left before it, and its take's stored level.
 * Null when every piece plays as recorded.
 */
export function joinedLevelsOf(
  pieces: readonly { start: number; end: number; gapBeforeSec?: number; att: Parameters<typeof clipLevelOf>[0] }[],
): readonly ClipLevel[] | null {
  let at = 0
  let any = false
  const out = pieces.map((p) => {
    at += p.gapBeforeSec != null && p.gapBeforeSec > 0 ? p.gapBeforeSec : 0
    const own = clipLevelOf(p.att)
    if (own) any = true
    const level: ClipLevel = { ...(own ?? FLAT_LEVEL), startSec: at, endSec: at + (p.end - p.start) }
    at = level.endSec as number
    return level
  })
  return any ? out : null
}

/** The level at a moment of the clip: volume, then the fades inside the kept
 *  part. For a joined copy, the level of the part that moment falls in. */
export function levelAt(t: number, levels: ClipLevels): number {
  const l = isParts(levels) ? (levels.find((s) => s.endSec != null && t < s.endSec) ?? levels[levels.length - 1]) : levels
  if (!l) return 1
  let g = Math.pow(10, (l.gainDb || 0) / 20)
  if (l.fadeInSec > 0 && t < l.startSec + l.fadeInSec) g *= Math.max(0, Math.min(1, (t - l.startSec) / l.fadeInSec))
  if (l.fadeOutSec > 0 && l.endSec != null && t > l.endSec - l.fadeOutSec) g *= Math.max(0, Math.min(1, (l.endSec - t) / l.fadeOutSec))
  return g
}

interface Graph {
  ctx: AudioContext
  master: GainNode
  /** Null where the context has no compressor: the main volume then goes
   *  straight out, unguarded, rather than the whole graph failing. */
  guard: DynamicsCompressorNode | null
  tracks: Map<string, GainNode>
}

interface Route {
  source: MediaElementAudioSourceNode
  clip: GainNode
  level: ClipLevels | null
}

let graph: Graph | null = null
let masterVolume = 1
const trackDb = new Map<string, number>()
const routes = new WeakMap<HTMLMediaElement, Route>()
/** AQU-2494 (review, Nov 9), as AQU-2471 has it: players sent straight to the
 *  output only because the context was asleep when they were wired, and where
 *  they would go. */
const routeLater = new WeakMap<HTMLMediaElement, { trackKey: string; level: ClipLevels | null }>()

function ensureGraph(): Graph | null {
  const ctx = getOutputContext()
  if (!ctx || typeof ctx.createGain !== "function") return null
  if (graph && graph.ctx === ctx) return graph
  // The peak guard: a hard-kneed, fast limiter just under full scale, so a
  // raised take (or two overlapping) never clips the output. A context
  // without a compressor still plays, unguarded: a missing guard must never
  // take every chip's Play down with it.
  let guard: DynamicsCompressorNode | null = null
  if (typeof ctx.createDynamicsCompressor === "function") {
    guard = ctx.createDynamicsCompressor()
    guard.threshold.value = -1
    guard.knee.value = 0
    guard.ratio.value = 20
    guard.attack.value = 0.003
    guard.release.value = 0.1
  }
  const master = ctx.createGain()
  master.gain.value = masterVolume
  if (guard) {
    master.connect(guard)
    guard.connect(ctx.destination)
  } else {
    master.connect(ctx.destination)
  }
  graph = { ctx, master, guard, tracks: new Map() }
  return graph
}

function trackNode(g: Graph, key: string): GainNode {
  let n = g.tracks.get(key)
  if (!n) {
    n = g.ctx.createGain()
    n.gain.value = Math.pow(10, (trackDb.get(key) ?? 0) / 20)
    n.connect(g.master)
    g.tracks.set(key, n)
  }
  return n
}

/** Can this element's sound feed a graph without going silent? */
function sameOriginSound(el: HTMLMediaElement): boolean {
  return sameOriginSrc(el.currentSrc || el.src || "")
}

function sameOriginSrc(src: string): boolean {
  if (src.startsWith("blob:") || src.startsWith("data:")) return true
  try {
    return typeof location !== "undefined" && new URL(src, location.href).origin === location.origin
  } catch {
    return false
  }
}

/** Is this element going through the mixer (its `volume` then stays at 1)? */
export function isMixed(el: HTMLMediaElement | null | undefined): boolean {
  return Boolean(el && routes.has(el))
}

/** The schedule for an element's take gain from where it is now. */
function schedule(el: HTMLMediaElement, r: Route, ctx: AudioContext): void {
  const p = r.clip.gain
  const now = ctx.currentTime
  p.cancelScheduledValues(now)
  if (el.muted) {
    p.setValueAtTime(0, now)
    return
  }
  const l = r.level
  if (!l) {
    p.setValueAtTime(1, now)
    return
  }
  const pos = el.currentTime
  const rate = el.playbackRate || 1
  p.setValueAtTime(levelAt(pos, l), now)
  if (el.paused) return
  // AQU-2494 (review, Nov 9): part by part for a joined copy. A later part
  // starts at its own level — a step where it begins, never a ramp across
  // from the part before it.
  const parts = isParts(l) ? l : [l]
  for (const s of parts) {
    if (s.endSec != null && s.endSec <= pos) continue
    if (parts.length > 1 && s.startSec > pos) p.setValueAtTime(levelAt(s.startSec, s), now + (s.startSec - pos) / rate)
    const keys = [s.startSec, s.startSec + s.fadeInSec, ...(s.endSec != null ? [s.endSec - s.fadeOutSec, s.endSec] : [])]
      .filter((k) => k > pos)
      .sort((a, b) => a - b)
    for (const k of keys) p.linearRampToValueAtTime(levelAt(k, s), now + (k - pos) / rate)
  }
}

/**
 * Send an element through the mixer, on `trackKey`'s gain, with a take's
 * level (null = as recorded). False when it can't be (no AudioContext, or
 * its sound is cross-origin): the caller keeps the element's own `volume`.
 * An element can feed only one source node ever, so this is once per element;
 * calling it again just changes the level.
 *
 * AQU-2494 (review, Nov 9), the same option as AQU-2471's: `unlessAsleep` —
 * also false when the mixer's context is not running ("suspended": Safari
 * outside a tap; "interrupted": an iPad after a phone call). An element wired
 * into a context that is asleep says it is playing and is silent for as long
 * as the context sleeps. Left alone it plays straight to the output and is
 * heard (`playUnmixed`); the context is asked to wake, and the element goes
 * into the mixer at its next pause once it runs (`mixIfAwake`).
 */
export function mixElement(
  el: HTMLMediaElement,
  trackKey: string,
  level: ClipLevels | null,
  opts?: { unlessAsleep?: boolean },
): boolean {
  const existing = routes.get(el)
  if (existing) {
    existing.level = level
    if (graph) schedule(el, existing, graph.ctx)
    return true
  }
  if (!sameOriginSound(el)) return false
  const g = ensureGraph()
  if (!g || typeof g.ctx.createMediaElementSource !== "function") return false
  if (opts?.unlessAsleep && g.ctx.state !== "running") {
    if (typeof g.ctx.resume === "function") void g.ctx.resume().catch(() => { /* needs a tap: it plays direct meanwhile */ })
    routeLater.set(el, { trackKey, level })
    return false
  }
  let source: MediaElementAudioSourceNode
  try {
    source = g.ctx.createMediaElementSource(el)
  } catch {
    return false
  }
  const clip = g.ctx.createGain()
  source.connect(clip)
  clip.connect(trackNode(g, trackKey))
  const r: Route = { source, clip, level }
  routes.set(el, r)
  el.volume = 1
  applyMuted(el)
  const resched = () => {
    if (g.ctx.state === "suspended") void g.ctx.resume().catch(() => {})
    schedule(el, r, g.ctx)
  }
  for (const ev of ["play", "playing", "pause", "seeked", "ratechange", "volumechange"]) el.addEventListener(ev, resched)
  resched()
  return true
}

// ── AQU-2494 (review, Nov 9): a context that is waking, or one that will not ──
// The same as AQU-2471's (sam/aqu-2471-players-and-memory-clips), so the two
// meet as one. On Safari the first Play of a page finds the context asleep, and
// it wakes within about a tenth of a second of being asked inside a tap. A
// player about to be wired while the context is not running waits for it, but
// never longer than MIXER_WAKE_WAIT_MS from when it was first asked; it goes
// straight to the output only if the context is still not running then (an
// iPad after a phone call, Safari outside a tap). Once a wake has failed,
// players go straight to the output at once, until the next Play asks again.

/** How long a player waits for a context that is waking (about a quarter of a second). */
export const MIXER_WAKE_WAIT_MS = 250

let waking: { ctx: AudioContext; done: Promise<void> } | null = null
/** A context that was asked to wake and was still not running when the wait ran out. */
let wouldNotWake: AudioContext | null = null

function askToWake(ctx: AudioContext): Promise<void> {
  if (waking?.ctx === ctx) return waking.done
  let timer: ReturnType<typeof setTimeout> | null = null
  let end: () => void = () => {}
  const done = new Promise<void>((resolve) => { end = resolve })
  const w = { ctx, done }
  waking = w
  const over = (): void => {
    if (timer != null) clearTimeout(timer)
    timer = null
    ctx.removeEventListener?.("statechange", check)
    if (waking === w) {
      waking = null
      wouldNotWake = ctx.state === "running" ? null : ctx
    }
    // Always: a player waiting on it must never be left waiting.
    end()
  }
  const check = (): void => {
    if (ctx.state === "running") over()
  }
  timer = setTimeout(over, MIXER_WAKE_WAIT_MS)
  ctx.addEventListener?.("statechange", check)
  try {
    if (typeof ctx.resume === "function") void ctx.resume().then(check, () => { /* needs a tap: the wait runs out */ })
  } catch {
    // An engine whose resume throws: the wait runs out, and it plays direct.
  }
  return done
}

/**
 * Play was pressed. A context that is not running is asked to wake NOW —
 * inside the tap, which is when Safari lets it — and the players made in the
 * next moment wait for it (`mixerWakeWait`). One that would not wake last time
 * is asked again. Never opens a context that is not open yet.
 */
export function wakeMixer(): void {
  const ctx = peekOutputContext()
  if (!ctx) return
  if (wouldNotWake === ctx) wouldNotWake = null
  if (ctx.state !== "running") void askToWake(ctx)
}

/**
 * Before a player for `src` is wired: null when it can be wired now (the
 * context is running, the mixer cannot take this sound anyway, or the context
 * will not wake), otherwise a promise that settles as soon as the context is
 * running, or when the wait is over. Either way the player is then wired as
 * the context is: through the mixer, or straight to the output.
 */
export function mixerWakeWait(src: string): Promise<void> | null {
  if (!sameOriginSrc(src)) return null
  const g = ensureGraph()
  if (!g || typeof g.ctx.createMediaElementSource !== "function") return null
  const { ctx } = g
  if (ctx.state === "running") {
    if (wouldNotWake === ctx) wouldNotWake = null
    return null
  }
  if (waking?.ctx === ctx) return waking.done
  if (wouldNotWake === ctx) return null
  return askToWake(ctx)
}

// ── AQU-2494 (review, Nov 9): an element that is NOT through the mixer ──────
// AQU-2471's direct player, taking a joined copy's per-piece levels as well.
// A player that plays straight to the output (the mixer's context is asleep,
// or its sound is a stream the mixer cannot take) has only its own `volume`
// to stand in for the mixer. That carries the main volume and the take's own
// level as far as `volume` goes: it turns a take down and shapes its fades in
// small steps, but it CANNOT RAISE ONE ABOVE AS RECORDED (a player's volume
// stops at 1), and iPhone and iPad ignore it (they honour `muted`, below).
// Never used for an element in the mixer.

interface Unmixed {
  level: ClipLevels
  main: number
  /** Steps the volume along a fade, while it is inside one. */
  timer: ReturnType<typeof setInterval> | null
  /** Wakes it just before the next fade. */
  wake: ReturnType<typeof setTimeout> | null
}
const unmixed = new WeakMap<HTMLMediaElement, Unmixed>()
/**
 * How often an unmixed element's volume is stepped while it is inside a fade:
 * every 10 ms inside a fade, and not at all outside one. A 100 ms fade moves
 * in tenths and a 20 ms one in halves, the finest a player's own volume can
 * follow without a click (through the mixer a fade is exact to the sample).
 */
const UNMIXED_FADE_STEP_MS = 10
const UNMIXED_FADE_STEP_SEC = UNMIXED_FADE_STEP_MS / 1000

const partsOf = (l: ClipLevels): readonly ClipLevel[] => (isParts(l) ? l : [l])

function unmixedVolumeNow(el: HTMLMediaElement, u: Unmixed): number {
  // Never above 1: a player can turn its take down, not raise it.
  return Math.max(0, Math.min(1, u.main * Math.min(1, levelAt(el.currentTime, u.level))))
}

/** Inside a fade at clip second `pos` — or one step short of one, so the
 *  first step lands on the fade's start. A later piece of a joined copy
 *  starts at its own level: the moment it begins is stepped over like a fade. */
function inFade(pos: number, levels: ClipLevels): boolean {
  const parts = partsOf(levels)
  return parts.some((l) =>
    (l.fadeInSec > 0 && pos >= l.startSec - UNMIXED_FADE_STEP_SEC && pos < l.startSec + l.fadeInSec) ||
    (l.fadeOutSec > 0 && l.endSec != null && pos >= l.endSec - l.fadeOutSec - UNMIXED_FADE_STEP_SEC && pos < l.endSec) ||
    (parts.length > 1 && pos >= l.startSec - UNMIXED_FADE_STEP_SEC && pos < l.startSec + UNMIXED_FADE_STEP_SEC))
}

/** Where the next fade (or the next piece) begins after clip second `pos`; null when none is ahead. */
function nextFadeSec(pos: number, levels: ClipLevels): number | null {
  const parts = partsOf(levels)
  let next: number | null = null
  for (const l of parts) {
    const ahead = [
      l.fadeInSec > 0 || parts.length > 1 ? l.startSec : null,
      l.fadeOutSec > 0 && l.endSec != null ? l.endSec - l.fadeOutSec : null,
    ]
    for (const k of ahead) if (k != null && k > pos && (next == null || k < next)) next = k
  }
  return next
}

function stopStepping(u: Unmixed): void {
  if (u.timer != null) clearInterval(u.timer)
  if (u.wake != null) clearTimeout(u.wake)
  u.timer = null
  u.wake = null
}

/**
 * Give an element that plays straight to the output the main volume and its
 * take's level (null = as recorded), kept up as it plays. A take with fades is
 * stepped along them while it plays; the stepping stops by itself when the
 * element pauses, ends or is let go. The level for where it is is set NOW,
 * before it starts, so its first sample is at the fade's own starting level.
 */
export function playUnmixed(el: HTMLMediaElement, level: ClipLevels | null, mainVolume: number): void {
  if (routes.has(el)) return
  const main = Math.max(0, Math.min(1, mainVolume))
  directMain.set(el, main)
  applyMuted(el)
  if (!level) {
    const had = unmixed.get(el)
    if (had) stopStepping(had)
    unmixed.delete(el)
    el.volume = main
    return
  }
  const had = unmixed.get(el)
  if (had) {
    had.level = level
    had.main = main
    el.volume = unmixedVolumeNow(el, had)
    return
  }
  const u: Unmixed = { level, main, timer: null, wake: null }
  unmixed.set(el, u)
  const apply = (): void => {
    // Moved into the mixer since (`mixIfAwake`): its take gain carries the
    // level now, and the player stays at 1.
    if (unmixed.get(el) !== u) {
      stopStepping(u)
      return
    }
    el.volume = unmixedVolumeNow(el, u)
    if (u.wake != null) clearTimeout(u.wake)
    u.wake = null
    if (el.paused || el.ended) {
      stopStepping(u)
      return
    }
    const pos = el.currentTime
    if (inFade(pos, u.level)) {
      u.timer ??= setInterval(() => {
        if (el.paused || el.ended || unmixed.get(el) !== u) {
          stopStepping(u)
          return
        }
        el.volume = unmixedVolumeNow(el, u)
        // Out of the fade: stop stepping, and wake for the next one.
        if (!inFade(el.currentTime, u.level)) {
          stopStepping(u)
          apply()
        }
      }, UNMIXED_FADE_STEP_MS)
      return
    }
    stopStepping(u)
    const next = nextFadeSec(pos, u.level)
    if (next == null) return
    const inMs = ((next - pos) / (el.playbackRate || 1)) * 1000 - UNMIXED_FADE_STEP_MS
    u.wake = setTimeout(apply, Math.max(1, inMs))
  }
  if (typeof el.addEventListener === "function") {
    for (const ev of ["play", "playing", "seeked", "timeupdate", "ratechange"]) el.addEventListener(ev, apply)
  }
  apply()
}

/**
 * A player that went straight to the output only because the context was
 * asleep when it was wired is moved into the mixer HERE: at a pause, once the
 * context is running. Paused, the move can neither click nor jump in level;
 * while it plays it is never moved. Its take's level goes onto its take gain
 * and the player goes back to 1. True when it moved.
 */
export function mixIfAwake(el: HTMLMediaElement): boolean {
  const later = routeLater.get(el)
  if (!later || !el.paused) return false
  if (!graph || graph.ctx.state !== "running") return false
  routeLater.delete(el)
  const u = unmixed.get(el)
  if (u) stopStepping(u)
  unmixed.delete(el)
  const moved = mixElement(el, later.trackKey, later.level)
  applyMuted(el)
  return moved
}

/**
 * A player takes a main volume of `mainVolume`: 1 through the mixer (the
 * mixer's main volume is its volume), and otherwise the main volume, with its
 * take's level when it carries one (`playUnmixed`) — and muted while that is 0
 * (`setPlayerMuted`).
 */
export function setPlayerVolume(el: HTMLMediaElement, mainVolume: number): void {
  if (routes.has(el)) {
    el.volume = 1
    applyMuted(el)
    return
  }
  const main = Math.max(0, Math.min(1, mainVolume))
  directMain.set(el, main)
  const u = unmixed.get(el)
  if (u) u.main = main
  el.volume = u ? unmixedVolumeNow(el, u) : main
  applyMuted(el)
}

// ── AQU-2494 (review, Nov 9): mute, for a player straight to the output ─────
// As AQU-2471's. The playback bar's speaker button is the main volume at 0.
// Through the mixer that is the mixer's own volume and silences every device.
// A player straight to the output has only its `volume`, which iPhone and iPad
// ignore; they do honour `muted`. So such a player is MUTED whenever the level
// it should be at is zero — the main volume at 0, or its track muted — and
// un-muted when it is not. Only players registered here (`setPlayerMuted`)
// are touched: any other player's mute is its owner's.

/** Each registered player's own track mute, as its owner last set it. */
const trackMuted = new WeakMap<HTMLMediaElement, boolean>()
/** The main volume a player straight to the output was last given. */
const directMain = new WeakMap<HTMLMediaElement, number>()

function applyMuted(el: HTMLMediaElement): void {
  const track = trackMuted.get(el)
  if (track == null) return
  el.muted = track || (!routes.has(el) && (directMain.get(el) ?? masterVolume) <= 0)
}

/** Mute or un-mute a player for its track. A player straight to the output
 *  stays muted while the main volume is 0 as well. */
export function setPlayerMuted(el: HTMLMediaElement, muted: boolean): void {
  trackMuted.set(el, muted)
  applyMuted(el)
}

/** The main volume, 0–1: the transport's volume control. */
export function setMixerVolume(v: number): void {
  masterVolume = Math.max(0, Math.min(1, v))
  if (graph) graph.master.gain.setValueAtTime(masterVolume, graph.ctx.currentTime)
}

/** AQU-2494 (review, Nov 9): the main volume as the playback bar last set it,
 *  for a player outside the queue that goes straight to the output. */
export function mixerVolume(): number {
  return masterVolume
}

/** A track's own volume in dB (the audio-levels plan's track fader). */
export function setTrackGainDb(trackKey: string, db: number): void {
  trackDb.set(trackKey, db)
  const n = graph?.tracks.get(trackKey)
  if (n && graph) n.gain.setValueAtTime(Math.pow(10, db / 20), graph.ctx.currentTime)
}

/** Where a one-off player (the chip's play button) connects: the main volume
 *  and the peak guard, so it is as loud as the timeline would be. */
export function mixerInput(trackKey?: string): AudioNode | null {
  const g = ensureGraph()
  if (!g) return null
  return trackKey ? trackNode(g, trackKey) : g.master
}

export function __resetMixerForTests(): void {
  graph = null
  masterVolume = 1
  trackDb.clear()
  waking = null
  wouldNotWake = null
}

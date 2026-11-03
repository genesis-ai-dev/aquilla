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

import { getOutputContext } from "./output-context"

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

/** The level at a moment of the clip: volume, then the fades inside the kept part. */
export function levelAt(t: number, l: ClipLevel): number {
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
  level: ClipLevel | null
}

let graph: Graph | null = null
let masterVolume = 1
const trackDb = new Map<string, number>()
const routes = new WeakMap<HTMLMediaElement, Route>()

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
  const src = el.currentSrc || el.src || ""
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
  const keys = [l.startSec, l.startSec + l.fadeInSec, ...(l.endSec != null ? [l.endSec - l.fadeOutSec, l.endSec] : [])]
    .filter((k) => k > pos)
    .sort((a, b) => a - b)
  for (const k of keys) p.linearRampToValueAtTime(levelAt(k, l), now + (k - pos) / rate)
}

/**
 * Send an element through the mixer, on `trackKey`'s gain, with a take's
 * level (null = as recorded). False when it can't be (no AudioContext, or
 * its sound is cross-origin): the caller keeps the element's own `volume`.
 * An element can feed only one source node ever, so this is once per element;
 * calling it again just changes the level.
 */
export function mixElement(el: HTMLMediaElement, trackKey: string, level: ClipLevel | null): boolean {
  const existing = routes.get(el)
  if (existing) {
    existing.level = level
    if (graph) schedule(el, existing, graph.ctx)
    return true
  }
  if (!sameOriginSound(el)) return false
  const g = ensureGraph()
  if (!g || typeof g.ctx.createMediaElementSource !== "function") return false
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
  const resched = () => {
    if (g.ctx.state === "suspended") void g.ctx.resume().catch(() => {})
    schedule(el, r, g.ctx)
  }
  for (const ev of ["play", "playing", "pause", "seeked", "ratechange", "volumechange"]) el.addEventListener(ev, resched)
  resched()
  return true
}

/** The main volume, 0–1: the transport's volume control. */
export function setMixerVolume(v: number): void {
  masterVolume = Math.max(0, Math.min(1, v))
  if (graph) graph.master.gain.setValueAtTime(masterVolume, graph.ctx.currentTime)
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
}

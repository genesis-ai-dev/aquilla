// How far behind the playhead's clock your ears actually are. (AQU-646)
//
// The timeline's playhead is driven by a media element's `currentTime`, which
// is "what has been handed to the audio pipeline", not "what is coming out of
// the speaker". The gap is output latency: tens of milliseconds on wired
// output, 150-300ms on Bluetooth. Nothing in the browser compensates for it and
// nothing here did either — it was invisible until take chips grew waveforms
// and Sam suddenly had a reference to see the playhead running ahead of.
//
// WHAT THIS NUMBER ACTUALLY IS, STATED PLAINLY: playback in this app never goes
// through WebAudio (`createMediaElementSource` taints the cross-origin HLS
// film, so it cannot), which means we cannot measure the element's own
// buffering. We read `outputLatency` off a silent context that shares the
// output DEVICE, and infer the element's tail from it. For the case that
// actually hurts — Bluetooth, where the delay is codec and radio buffering
// shared by every audio consumer on the machine — that inference is sound. For
// wired output it is off by a few milliseconds nobody can see. It makes the
// playhead truer; it will never make it exact.
//
// Everything degrades to ZERO, and zero means "do not compensate" — no
// AudioContext (happy-dom, and therefore the whole unit suite), a context that
// is not running, an unsupported property, private mode. The playhead then
// behaves exactly as it did before this module existed.

import { getOutputContext, peekOutputContext } from "./output-context"
import { micIsHeld } from "./mic-hold"

/**
 * The ceiling on how far back we will shift the playhead.
 *
 * DERIVED FROM `MAX_REGRESSION_SEC` IN TimelinePlayhead.tsx (0.5), and the
 * dependency is the whole reason this constant exists. Applying the shift is a
 * one-time BACKWARD step, and the playhead's never-move-backward rule renders a
 * backward step smaller than that bound as a HOLD — which is exactly the right
 * picture of "the sound you are about to hear is still in the buffer". A step
 * LARGER than the bound is treated as a genuine seek and passes straight
 * through as a visible jump. So this must stay comfortably under it.
 *
 * If MAX_REGRESSION_SEC ever changes, change this with it.
 */
export const MAX_COMPENSATION_SEC = 0.4

/** Above this, the output is essentially never a wired path — it is Bluetooth
 *  or something equally buffered, which is also where the reading is least
 *  complete. Measured wired values cluster around 0.015-0.025s; Bluetooth lands
 *  near 0.18s. */
export const HIGH_LATENCY_SEC = 0.1

let latencySec = 0
const listeners = new Set<() => void>()

function publish(next: number): void {
  if (next === latencySec) return
  latencySec = next
  for (const l of listeners) l()
}

/** A finite, non-negative number or null — `0` is a REAL measurement (Firefox
 *  on macOS built-in speakers reports literal zero), so it must not be treated
 *  as "unsupported" and fall through to the next source. */
function finiteSec(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null
}

/**
 * Read the context's latency, or null when the reading cannot be trusted.
 *
 * Untrusted while the context is not `running`: the value describes a real host
 * audio stream, and that stream does not exist until the context starts. A
 * suspended context tends to report 0, which is indistinguishable from a
 * genuine zero — so we refuse to read it rather than compensate by a number we
 * would have made up.
 */
function probe(): number | null {
  const ctx = peekOutputContext()
  if (!ctx || ctx.state !== "running") return null
  const raw =
    finiteSec((ctx as unknown as { outputLatency?: number }).outputLatency) ??
    finiteSec((ctx as unknown as { baseLatency?: number }).baseLatency)
  if (raw == null) return null
  return Math.min(raw, MAX_COMPENSATION_SEC)
}

/** Re-read now; returns whether a trusted reading was available. */
export function refreshOutputLatency(): boolean {
  const next = probe()
  if (next == null) return false
  publish(next)
  return true
}

/**
 * Called at a play gesture. Creates/resumes the shared context if allowed, then
 * probes now, on the context's next state change, and once more shortly after —
 * because a context created at a gesture is usually not `running` yet, and the
 * first trusted reading may be a beat away.
 *
 * NEVER creates or resumes while the recorder holds the mic. Reading a property
 * is harmless; opening the device is not.
 */
export function armOutputLatency(): void {
  if (micIsHeld()) return
  const ctx = getOutputContext()
  if (!ctx) return
  if (ctx.state === "suspended") {
    // Rejects outside a user gesture; that is fine, the next play tries again.
    void ctx.resume().catch(() => {})
  }
  if (refreshOutputLatency()) return
  const onState = () => {
    if (refreshOutputLatency()) ctx.removeEventListener("statechange", onState)
  }
  ctx.addEventListener("statechange", onState)
  setTimeout(() => {
    refreshOutputLatency()
    ctx.removeEventListener("statechange", onState)
  }, 250)
}

export function getOutputLatencySec(): number {
  return latencySec
}

export function isHighLatencyOutput(): boolean {
  return latencySec >= HIGH_LATENCY_SEC
}

export function subscribeOutputLatency(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * Where the playhead should be DRAWN, given where the clock says it is.
 *
 * Pure, so the interesting part is testable without a browser. `compensating`
 * is a latch owned by the timeline, not the transport's `playing` flag — see
 * TimelineEditor, where the reason is written out: `playing` dips false at
 * every cold verse gate, and gating on it would switch compensation off and on
 * at every verse.
 *
 * Clamped at zero: without it, playing from 0.05s draws the head at a negative
 * pixel, outside the track.
 */
export function displaySec(currentSec: number, latency: number, compensating: boolean): number {
  if (!compensating) return currentSec
  if (!Number.isFinite(latency) || latency <= 0) return currentSec
  return Math.max(0, currentSec - latency)
}

export function __resetOutputLatencyForTests(): void {
  latencySec = 0
  listeners.clear()
}

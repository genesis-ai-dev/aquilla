// 3-2-1 countdown with an optional WebAudio beep. onDone fires AT the zero
// instant — the same moment "GO" appears — and the modal starts the take there.
//
// IT DID NOT USED TO (fixed 2026-08-14, AQU-646). Zero was treated as a fourth
// tick: "GO" rendered at t=3s and onDone fired at t=4s. A full second separated
// what the screen said from when the recorder actually began, and since sample
// 0 of a take is anchored to the line's start on the timeline, that second went
// straight into the file as dead air. Worse, it was unlearnable: obey GO and
// your first word was recorded by nothing, so operators trained themselves to
// wait for the red dot instead, landing later still. Zero is now one instant.
//
// The beep uses an OscillatorNode so we don't ship an audio asset. Each tick is
// a short sine at 880 Hz. THE ZERO TICK IS SILENT, and that is not a style
// choice: the mic is already live at zero (the capture graph is armed during
// the countdown), so a beep there would print into the head of every take made
// on speakers, underneath the operator's first word. It also happens to be how
// dubbing studios have always cued — three beeps, and you come in where the
// fourth would be — which is a beat you can anticipate rather than react to,
// and anticipation is the only thing that shrinks the settle-in gap no software
// is allowed to trim away.

import { useCallback, useEffect, useRef, useState } from "react"

import { getOutputContext, resetOutputContextForTests } from "@/lib/audio/output-context"

/** Ticks before zero. Exported because the film's rolling lead-in has to cover
 *  exactly this much runway — the picture reaches the line's first frame as the
 *  count reaches zero, so the two cues say "now" at the same instant. */
export const COUNTDOWN_FROM = 3

/** One count, when nobody says otherwise: the count as it always was. */
export const DEFAULT_COUNTDOWN_STEP_MS = 1000

/** Past the tone's own length, the oscillator runs this much longer while its
 *  gain finishes falling away. */
const BEEP_RELEASE_MS = 20

/**
 * How long each beep lasts at a given count speed. (AQU-1210, Sam: "SHORTEN
 * BEEP!")
 *
 * 120ms at one second a count and slower — the beep as it always was — and
 * proportionally shorter below that, down to 60ms at the Fast half-second.
 * The last beep sounds one step before zero and the take's pre-roll starts
 * listening 200ms before zero, so at half a second a full-length beep (and the
 * room's ring after it) would end barely clear of the window that is kept as
 * the take's head. useCountdown.test pins the clearance at every speed.
 */
export function countdownBeepMs(stepMs: number): number {
  return Math.round(Math.max(60, Math.min(120, stepMs * 0.12)))
}

/** When, relative to zero, the last beep has fully stopped (negative = before). */
export function lastBeepEndsMs(stepMs: number): number {
  return -stepMs + countdownBeepMs(stepMs) + BEEP_RELEASE_MS
}

export interface CountdownStartOptions {
  beep?: boolean
  from?: number
  /** Milliseconds per count (see recording-countdown-pref). */
  stepMs?: number
  onDone?: () => void
}

export interface UseCountdown {
  /** null when idle; otherwise current tick (3 → 2 → 1 → 0). */
  count: number | null
  running: boolean
  start: (opts?: CountdownStartOptions) => void
  cancel: () => void
}

// The beep context now lives in lib/audio/output-context — SAME context, same
// never-closed lifetime, same capture-rate pinning, just shared. The reasoning
// that produced those rules (device churn reaching the mic and eating the head
// of a take) is written out there. Sharing it also means the context is usually
// created at first PLAYBACK, minutes before any mic opens, rather than being
// constructed during the countdown with the mic already hot.

/** The singleton outlives any one test's AudioContext fake — a test that
 *  counts beeps must drop it first, or it beeps into an earlier test's fake. */
export function resetCountdownBeepContextForTests(): void {
  resetOutputContextForTests()
}

function beepOnce(freq: number, durationMs: number) {
  try {
    const ctx = getOutputContext()
    if (!ctx) return
    if (ctx.state === "suspended") void ctx.resume()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = "sine"
    osc.frequency.value = freq
    gain.gain.value = 0.0001
    osc.connect(gain)
    gain.connect(ctx.destination)
    const now = ctx.currentTime
    gain.gain.setValueAtTime(0.0001, now)
    gain.gain.exponentialRampToValueAtTime(0.2, now + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + durationMs / 1000)
    osc.start(now)
    osc.stop(now + (durationMs + BEEP_RELEASE_MS) / 1000)
    // The NODES are released; the context is not. See the block comment above.
    osc.onended = () => {
      try { osc.disconnect() } catch {}
      try { gain.disconnect() } catch {}
    }
  } catch { /* no-op: AudioContext may be restricted */ }
}

export function useCountdown(): UseCountdown {
  const [count, setCount] = useState<number | null>(null)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onDoneRef = useRef<(() => void) | null>(null)

  const cancel = useCallback(() => {
    if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null }
    onDoneRef.current = null
    setCount(null)
  }, [])

  useEffect(() => () => cancel(), [cancel])

  const start = useCallback((opts?: CountdownStartOptions) => {
    cancel()
    const beep = opts?.beep ?? true
    const from = Math.max(1, opts?.from ?? 3)
    const stepMs = Math.max(1, opts?.stepMs ?? DEFAULT_COUNTDOWN_STEP_MS)
    const beepMs = countdownBeepMs(stepMs)
    onDoneRef.current = opts?.onDone ?? null

    let current = from
    setCount(current)
    if (beep) beepOnce(880, beepMs)

    const tick = () => {
      current -= 1
      setCount(current)
      if (current === 0) {
        // ZERO. Show GO and hand off in the same instant — no beep (the mic is
        // hot), no further tick. `count` stays 0 rather than going null so the
        // GO that is already on screen survives until the caller's own phase
        // change replaces it; cancel() is what clears it.
        timeoutRef.current = null
        const fn = onDoneRef.current
        onDoneRef.current = null
        fn?.()
        return
      }
      if (beep) beepOnce(880, beepMs)
      timeoutRef.current = setTimeout(tick, stepMs)
    }
    timeoutRef.current = setTimeout(tick, stepMs)
  }, [cancel])

  return { count, running: count !== null, start, cancel }
}

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

import { WAV_SAMPLE_RATE } from "@/lib/audio/recording-limits"

/** Ticks before zero. Exported because the film's rolling lead-in has to cover
 *  exactly this much runway — the picture reaches the line's first frame as the
 *  count reaches zero, so the two cues say "now" at the same instant. */
export const COUNTDOWN_FROM = 3

export interface UseCountdown {
  /** null when idle; otherwise current tick (3 → 2 → 1 → 0). */
  count: number | null
  running: boolean
  start: (opts?: { beep?: boolean; from?: number; onDone?: () => void }) => void
  cancel: () => void
}

// ONE context for every beep, opened on the first and NEVER closed. It used to
// be a context per beep, closed when its tone ended — three open/close cycles
// of the output device inside the three seconds before every take. Opening and
// closing audio contexts is what makes the browser/OS reconfigure the shared
// audio device, and on combined input/output hardware (headsets) that churn
// reaches the MICROPHONE: measured in a take as a degraded head, a hard gap
// and a fade-in that ate the operator's first word. Pinned to the capture rate
// so this context can never be the rate disagreement that forces the restart.
let beepCtx: AudioContext | null = null

/** The singleton outlives any one test's AudioContext fake — a test that
 *  counts beeps must drop it first, or it beeps into an earlier test's fake. */
export function resetCountdownBeepContextForTests(): void {
  beepCtx = null
}

function beepOnce(freq: number, durationMs: number) {
  try {
    if (!beepCtx || beepCtx.state === "closed") {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      try {
        beepCtx = new Ctx({ sampleRate: WAV_SAMPLE_RATE })
      } catch {
        beepCtx = new Ctx()
      }
    }
    const ctx = beepCtx
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
    osc.stop(now + durationMs / 1000 + 0.02)
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

  const start = useCallback((opts?: { beep?: boolean; from?: number; onDone?: () => void }) => {
    cancel()
    const beep = opts?.beep ?? true
    const from = Math.max(1, opts?.from ?? 3)
    onDoneRef.current = opts?.onDone ?? null

    let current = from
    setCount(current)
    if (beep) beepOnce(880, 120)

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
      if (beep) beepOnce(880, 120)
      timeoutRef.current = setTimeout(tick, 1000)
    }
    timeoutRef.current = setTimeout(tick, 1000)
  }, [cancel])

  return { count, running: count !== null, start, cancel }
}

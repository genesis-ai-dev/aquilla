// 3-2-1 countdown with an optional WebAudio beep. onDone fires once the final
// count hits zero — the modal hands off to start() at that moment.
//
// The beep uses an OscillatorNode so we don't ship an audio asset. Each tick
// is a short sine at 880 Hz (zero-tick is higher to signal "go"). Users can
// disable beeps from the modal settings.

import { useCallback, useEffect, useRef, useState } from "react"

export interface UseCountdown {
  /** null when idle; otherwise current tick (3 → 2 → 1 → 0). */
  count: number | null
  running: boolean
  start: (opts?: { beep?: boolean; from?: number; onDone?: () => void }) => void
  cancel: () => void
}

function beepOnce(freq: number, durationMs: number) {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    const ctx = new Ctx()
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
    osc.onended = () => ctx.close().catch(() => {})
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
      if (current < 0) {
        setCount(null)
        const fn = onDoneRef.current
        onDoneRef.current = null
        fn?.()
        return
      }
      setCount(current)
      if (beep) beepOnce(current === 0 ? 1320 : 880, current === 0 ? 200 : 120)
      timeoutRef.current = setTimeout(tick, 1000)
    }
    timeoutRef.current = setTimeout(tick, 1000)
  }, [cancel])

  return { count, running: count !== null, start, cancel }
}

// The countdown's ZERO is one instant. (AQU-646, 2026-08-14)
//
// This file exists because of a bug worth a full second of every take. Zero used
// to be treated as a fourth tick: "GO" rendered at t=3s and `onDone` — which
// starts the recorder — fired at t=4s. Since sample 0 of a saved take is
// anchored to the line's start time on the timeline, that whole second was
// written into the file as dead air at the head, and everything the operator
// said landed a second late and ran off the end of the cue.
//
// It was also unlearnable in the worst way: obey the word GO and your first
// word was recorded by nothing at all, so operators trained themselves to
// ignore it and wait for the red dot instead — landing later still.
//
// The two assertions below are the whole contract: the handoff happens AT zero,
// and zero makes no sound (the mic is live by then — see useAudioRecorder).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"

import {
  COUNTDOWN_FROM,
  countdownBeepMs,
  lastBeepEndsMs,
  resetCountdownBeepContextForTests,
  useCountdown,
} from "./useCountdown"
import { COUNTDOWN_STEP_MS } from "@/lib/store/recording-countdown-pref"
import { PRE_ROLL_MS } from "@/hooks/useAudioRecorder"

/** Counts beeps by standing in for the AudioContext beepOnce builds per tick.
 *  happy-dom has none, so without this the real code's try/catch would swallow
 *  every beep and a "no beep at zero" assertion would pass vacuously. */
function installAudioContextSpy(): { beeps: number[]; stops: number[] } {
  const record = { beeps: [] as number[], stops: [] as number[] }
  class FakeOsc {
    frequency = { value: 0 }
    type = ""
    onended: (() => void) | null = null
    connect() {}
    start() { record.beeps.push(this.frequency.value) }
    stop(at: number) { record.stops.push(at) }
  }
  class FakeCtx {
    currentTime = 0
    destination = {}
    createOscillator() { return new FakeOsc() }
    createGain() {
      return {
        gain: {
          value: 0,
          setValueAtTime() {},
          exponentialRampToValueAtTime() {},
        },
        connect() {},
      }
    }
    close() { return Promise.resolve() }
  }
  ;(globalThis as unknown as { AudioContext: unknown }).AudioContext = FakeCtx
  return record
}

describe("useCountdown — zero is one instant", () => {
  // The beep context is a deliberate module singleton (open/close churn of the
  // audio device is what ate take heads); drop it so each test's fake counts.
  beforeEach(() => { vi.useFakeTimers(); resetCountdownBeepContextForTests() })
  afterEach(() => { vi.useRealTimers() })

  it("hands off AT zero, not a tick later", () => {
    installAudioContextSpy()
    const onDone = vi.fn()
    const { result } = renderHook(() => useCountdown())

    act(() => { result.current.start({ beep: false, from: COUNTDOWN_FROM, onDone }) })
    expect(result.current.count).toBe(3)

    // One tick short of zero: still counting, nothing started.
    act(() => { vi.advanceTimersByTime(COUNTDOWN_FROM * 1000 - 1) })
    expect(result.current.count).toBe(1)
    expect(onDone).not.toHaveBeenCalled()

    // Zero. "GO" is on screen and the recorder has been told to start in the
    // SAME instant — this is the millisecond the whole fix turns on.
    act(() => { vi.advanceTimersByTime(1) })
    expect(result.current.count).toBe(0)
    expect(onDone).toHaveBeenCalledTimes(1)

    // And nothing fires a second time a tick later, which is where it used to.
    act(() => { vi.advanceTimersByTime(2000) })
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it("beeps on the counts and is SILENT at zero", () => {
    const audio = installAudioContextSpy()
    const { result } = renderHook(() => useCountdown())

    act(() => { result.current.start({ beep: true, from: COUNTDOWN_FROM }) })
    act(() => { vi.advanceTimersByTime(COUNTDOWN_FROM * 1000 + 500) })

    // Three counts, three beeps, all the same pitch — you come in where the
    // fourth would be. A tone at zero would be printed into the head of every
    // take made on speakers, under the operator's first word.
    expect(audio.beeps).toEqual([880, 880, 880])
  })

  it("cancel() stops the handoff", () => {
    installAudioContextSpy()
    const onDone = vi.fn()
    const { result } = renderHook(() => useCountdown())
    act(() => { result.current.start({ beep: false, from: COUNTDOWN_FROM, onDone }) })
    act(() => { result.current.cancel() })
    act(() => { vi.advanceTimersByTime(5000) })
    expect(onDone).not.toHaveBeenCalled()
    expect(result.current.count).toBeNull()
  })
})

// AQU-1210 (Sam, 2026-09-25): the count has a speed — Fast half a second,
// Normal one, Slow one and a half — and the beep is SHORTENED at the fast end.
describe("useCountdown — speed, and a beep that never reaches the take", () => {
  beforeEach(() => { vi.useFakeTimers(); resetCountdownBeepContextForTests() })
  afterEach(() => { vi.useRealTimers() })

  it.each(Object.entries(COUNTDOWN_STEP_MS))("%s: zero lands at three counts of its step", (_speed, stepMs) => {
    installAudioContextSpy()
    const onDone = vi.fn()
    const { result } = renderHook(() => useCountdown())
    act(() => { result.current.start({ beep: false, from: COUNTDOWN_FROM, stepMs, onDone }) })
    act(() => { vi.advanceTimersByTime(COUNTDOWN_FROM * stepMs - 1) })
    expect(onDone).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(1) })
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it("keeps today's beep at one second a count and slower, and halves it at Fast", () => {
    expect(countdownBeepMs(COUNTDOWN_STEP_MS.normal)).toBe(120)
    expect(countdownBeepMs(COUNTDOWN_STEP_MS.slow)).toBe(120)
    expect(countdownBeepMs(COUNTDOWN_STEP_MS.fast)).toBe(60)
  })

  // The take's pre-roll keeps the last 200ms before zero as the take's head.
  // The last beep sounds one step before zero; at every speed it has to be
  // over — with room for the room's own ring — before that window opens.
  it.each(Object.entries(COUNTDOWN_STEP_MS))("%s: the last beep ends at least 150ms before the pre-roll opens", (_speed, stepMs) => {
    expect(lastBeepEndsMs(stepMs)).toBeLessThanOrEqual(-(PRE_ROLL_MS + 150))
  })

  it("the beeps it plays are the shortened ones", () => {
    const audio = installAudioContextSpy()
    const { result } = renderHook(() => useCountdown())
    act(() => { result.current.start({ beep: true, from: COUNTDOWN_FROM, stepMs: COUNTDOWN_STEP_MS.fast }) })
    act(() => { vi.advanceTimersByTime(COUNTDOWN_FROM * COUNTDOWN_STEP_MS.fast + 100) })
    expect(audio.beeps).toEqual([880, 880, 880])
    // The fake context's clock sits at 0: each stop is the beep plus its release.
    for (const at of audio.stops) expect(at).toBeCloseTo(0.08)
  })
})

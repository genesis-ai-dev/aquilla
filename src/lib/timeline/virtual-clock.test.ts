// AQU-646 stage 3h — the clock for files with timings and no master.
//
// Everything here drives a STUBBED `performance.now()`. That is not a
// convenience: the whole design of this clock is that position comes from the
// wall clock against an anchor rather than from counting ticks, so the property
// worth pinning is exactly the one a real timer would hide — that a late, early
// or skipped tick still reports the right second.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import {
  getVirtualClockPlaying,
  getVirtualClockSec,
  resetVirtualClockForTests,
  setVirtualClockRate,
  startVirtualClock,
  stopVirtualClock,
  tickVirtualClock,
  virtualClockPause,
  virtualClockPlay,
  virtualClockSeek,
} from "./virtual-clock"

let now = 0
/** Move the wall clock AND let the store beat, the way the interval does.
 *  Driving the real tick is deliberate: the bug this file shipped with lived in
 *  the publish path, and a test that only read the maths could not see it. */
const advance = (ms: number) => {
  now += ms
  tickVirtualClock()
}

beforeEach(() => {
  now = 0
  vi.spyOn(performance, "now").mockImplementation(() => now)
  resetVirtualClockForTests()
})
afterEach(() => {
  resetVirtualClockForTests()
  vi.restoreAllMocks()
})

describe("owning the transport", () => {
  it("reports nothing until it is driving", () => {
    expect(getVirtualClockSec()).toBeNull()
    startVirtualClock(30)
    expect(getVirtualClockSec()).toBe(0)
    stopVirtualClock()
    expect(getVirtualClockSec()).toBeNull()
  })

  // Mirrors `video-clock`'s cleared state: a clock nobody is driving cannot be
  // playing, or the playhead extrapolates from a position no one updates.
  it("cannot be playing once it has handed the file back", () => {
    startVirtualClock(30)
    virtualClockPlay()
    expect(getVirtualClockPlaying()).toBe(true)
    stopVirtualClock()
    expect(getVirtualClockPlaying()).toBe(false)
  })

  it("refreshes the duration without restarting a run in progress", () => {
    startVirtualClock(30)
    virtualClockPlay()
    advance(5000)
    startVirtualClock(60) // a take was added; the file got longer
    expect(getVirtualClockSec()).toBeCloseTo(5, 3)
    expect(getVirtualClockPlaying()).toBe(true)
  })
})

describe("the position comes from the wall clock", () => {
  it("advances in real time", () => {
    startVirtualClock(60)
    virtualClockPlay()
    advance(2500)
    expect(getVirtualClockSec()).toBeCloseTo(2.5, 3)
  })

  // THE REASON FOR THE ANCHOR. A background tab throttles timers hard while the
  // audio elements keep playing at full speed; a clock that counted ticks would
  // slide further behind the sound the longer you looked away. Here nothing
  // ticked at all for ten seconds and the answer is still right.
  it("is right after a gap in which nothing ticked", () => {
    startVirtualClock(60)
    virtualClockPlay()
    advance(10_000)
    expect(getVirtualClockSec()).toBeCloseTo(10, 3)
  })

  it("holds still while paused", () => {
    startVirtualClock(60)
    virtualClockPlay()
    advance(3000)
    virtualClockPause()
    advance(9999)
    expect(getVirtualClockSec()).toBeCloseTo(3, 3)
    expect(getVirtualClockPlaying()).toBe(false)
  })

  it("resumes from where it stopped", () => {
    startVirtualClock(60)
    virtualClockPlay()
    advance(3000)
    virtualClockPause()
    advance(5000)
    virtualClockPlay()
    advance(1000)
    expect(getVirtualClockSec()).toBeCloseTo(4, 3)
  })
})

describe("speed", () => {
  it("scales how fast the clock runs", () => {
    startVirtualClock(60)
    virtualClockPlay()
    setVirtualClockRate(2)
    advance(2000)
    expect(getVirtualClockSec()).toBeCloseTo(4, 3)
  })

  // THE SUBTLE ONE. A rate change re-anchors FIRST, so the seconds already
  // elapsed keep the rate they were played at. Without that, changing to 2x
  // three seconds in would retroactively claim you were six seconds in — the
  // playhead would jump and every sounding dub would be wrong.
  it("does not retroactively rescale what already played", () => {
    startVirtualClock(60)
    virtualClockPlay()
    advance(3000)
    expect(getVirtualClockSec()).toBeCloseTo(3, 3)
    setVirtualClockRate(2)
    expect(getVirtualClockSec()).toBeCloseTo(3, 3) // no jump at the moment of change
    advance(1000)
    expect(getVirtualClockSec()).toBeCloseTo(5, 3) // 3 + 1s at 2x
  })

  it("ignores a nonsense rate rather than stopping the clock", () => {
    startVirtualClock(60)
    virtualClockPlay()
    setVirtualClockRate(0)
    setVirtualClockRate(-1)
    setVirtualClockRate(Number.NaN)
    advance(1000)
    expect(getVirtualClockSec()).toBeCloseTo(1, 3)
  })
})

describe("seeking and the end of the file", () => {
  it("seeks, and keeps running from there", () => {
    startVirtualClock(60)
    virtualClockPlay()
    virtualClockSeek(20)
    advance(1000)
    expect(getVirtualClockSec()).toBeCloseTo(21, 3)
  })

  it("clamps a seek into the file", () => {
    startVirtualClock(30)
    virtualClockSeek(-5)
    expect(getVirtualClockSec()).toBe(0)
    virtualClockSeek(999)
    expect(getVirtualClockSec()).toBe(30)
  })

  // Sam: "runs to end of last cue", no looping — and the position is LEFT at
  // the end rather than reset, the way a media element leaves it, so pressing
  // play again is a deliberate restart rather than a silent one.
  it("never reports past the end", () => {
    startVirtualClock(10)
    virtualClockPlay()
    advance(60_000)
    expect(getVirtualClockSec()).toBe(10)
  })

  it("restarts from the top when played from the end", () => {
    startVirtualClock(10)
    virtualClockPlay()
    advance(60_000)
    virtualClockPause()
    virtualClockPlay()
    advance(1000)
    expect(getVirtualClockSec()).toBeCloseTo(1, 3)
  })

  // A file with no timings at all: no end to stop at, so it must not clamp to
  // zero and sit there.
  it("runs unbounded when the duration is unknown", () => {
    startVirtualClock(0)
    virtualClockPlay()
    advance(5000)
    expect(getVirtualClockSec()).toBeCloseTo(5, 3)
  })
})

// ── THE CONTRACT THIS FILE BROKE ─────────────────────────────────────────────
//
// `useSyncExternalStore` asks for the snapshot during render and again to check
// nothing moved underneath it. If the two answers differ, React concludes it is
// looping and THROWS — which is what the app's error page was.
//
// The first version returned `computeSec()` straight out, reading
// `performance.now()` each call, so it answered differently every time. It only
// failed while PLAYING, because paused it early-returns the anchor — which is
// why everything looked fine right up until the press.
//
// Neither of these existed. That was the real gap: the maths was tested
// thoroughly and the React boundary not at all.
describe("the snapshot React reads", () => {
  it("does not change between two reads at the same moment", () => {
    startVirtualClock(60)
    virtualClockPlay()
    advance(1000)
    // No tick, no wall-clock movement between these two — but time is passing
    // in a real browser, and this used to read it live.
    const a = getVirtualClockSec()
    const b = getVirtualClockSec()
    expect(a).toBe(b)
  })

  // The sharper version: the wall clock MOVES between reads, as it always does
  // between React's two calls. The published value must not.
  it("does not change when the wall clock moves but nothing has ticked", () => {
    startVirtualClock(60)
    virtualClockPlay()
    advance(1000)
    const before = getVirtualClockSec()
    now += 250 // React's second call, a quarter-second later
    expect(getVirtualClockSec()).toBe(before)
    // …and it does move once the store actually beats.
    tickVirtualClock()
    expect(getVirtualClockSec()).toBeCloseTo(1.25, 3)
  })

  it("is stable while paused too, which is why the crash waited for play", () => {
    startVirtualClock(60)
    const a = getVirtualClockSec()
    now += 5000
    expect(getVirtualClockSec()).toBe(a)
  })
})

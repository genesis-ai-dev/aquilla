// AQU-646 stage 3h — the virtual clock AT THE REACT BOUNDARY.
//
// Separate from `virtual-clock.test.ts` because it is testing a different
// thing, and the split is the lesson. That file tests the maths, thoroughly,
// and all of it passed while the app threw its error page the instant Sam
// pressed play: the fault was never in the arithmetic, it was in what
// `useSyncExternalStore` was handed.
//
// `getSnapshot` returned a live `performance.now()` reading, so React's two
// calls in one render disagreed, React read that as an infinite loop and threw.
// Rendering the real hook is the only place that shows up.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { renderHook, act } from "@testing-library/react"

import {
  getVirtualClockPlaying,
  getVirtualClockSec,
  resetVirtualClockForTests,
  useVirtualClockForFile,
  virtualClockPause,
  startVirtualClock,
  tickVirtualClock,
  useVirtualClockPlaying,
  useVirtualClockSec,
  virtualClockPlay,
  virtualClockSeek,
} from "./virtual-clock"

let now = 0

beforeEach(() => {
  now = 0
  // A CLOCK THAT MOVES ON EVERY READ, because a real one does.
  //
  // This matters more than it looks. A stub returning a frozen number makes
  // React's two `getSnapshot` calls in one render agree by accident, and the
  // bug — a snapshot computed live from `performance.now()` — sails straight
  // through. Advancing a twentieth of a millisecond per read is what a browser
  // actually does, and it is what makes the regression below fail when the fix
  // is removed. (Far too small to disturb any assertion here; the positions are
  // checked to millisecond precision.)
  vi.spyOn(performance, "now").mockImplementation(() => {
    const t = now
    now += 0.05
    return t
  })
  resetVirtualClockForTests()
})
afterEach(() => {
  resetVirtualClockForTests()
  vi.restoreAllMocks()
})

describe("subscribing to the clock from React", () => {
  // THE REGRESSION. Before the fix this threw
  // "The result of getSnapshot should be cached to avoid an infinite loop",
  // which the app's error boundary showed as "something went wrong".
  it("renders while PLAYING without tripping React's loop guard", () => {
    startVirtualClock(60)
    act(() => { virtualClockPlay() })
    const { result } = renderHook(() => useVirtualClockSec())
    expect(result.current).toBeCloseTo(0, 3)
    // A render while the wall clock is moving underneath — the exact shape that
    // used to throw, because each getSnapshot read a fresh `performance.now()`.
    act(() => { now += 1234 })
    expect(() => renderHook(() => useVirtualClockSec())).not.toThrow()
  })

  it("updates when the store beats, and only then", () => {
    startVirtualClock(60)
    act(() => { virtualClockPlay() })
    const { result } = renderHook(() => useVirtualClockSec())
    const before = result.current
    act(() => { now += 2000 })
    // Time passed but nothing published, so subscribers have not been told.
    expect(result.current).toBe(before)
    act(() => { tickVirtualClock() })
    expect(result.current).toBeCloseTo(2, 2)
  })

  it("reports playing, and follows a seek", () => {
    startVirtualClock(60)
    const playing = renderHook(() => useVirtualClockPlaying())
    expect(playing.result.current).toBe(false)
    act(() => { virtualClockPlay() })
    expect(playing.result.current).toBe(true)

    const sec = renderHook(() => useVirtualClockSec())
    act(() => { virtualClockSeek(30) })
    expect(sec.result.current).toBeCloseTo(30, 3)
  })

  // Not driving means null, which is what tells the timeline to leave the
  // playhead to the queue or the picture.
  it("is null before it owns the file", () => {
    const { result } = renderHook(() => useVirtualClockSec())
    expect(result.current).toBeNull()
  })
})

// AQU-2711 x AQU-2253 (review, Nov 25): the workspace owns the clock through
// one hook. A new milestone, or the clock handed over, starts it again; a
// change to the milestone's first heard line (a retime, an earlier line
// added) moves its start in place and never stops it mid-play.
describe("useVirtualClockForFile", () => {
  const props = { owns: true, durationSec: 660, startSec: 600, milestoneKey: "m1" as string | null }
  const advance = (ms: number) => {
    now += ms
    act(() => tickVirtualClock())
  }

  it("takes the clock at the milestone's start, and hands it back", () => {
    const hook = renderHook((p: typeof props) => useVirtualClockForFile(p), { initialProps: props })
    expect(getVirtualClockSec()).toBe(600)
    hook.rerender({ ...props, owns: false })
    expect(getVirtualClockSec()).toBeNull()
  })

  it("the first heard line moves while playing: plays on, from where it was", () => {
    const hook = renderHook((p: typeof props) => useVirtualClockForFile(p), { initialProps: props })
    act(() => virtualClockPlay())
    advance(2000)
    hook.rerender({ ...props, startSec: 590 })
    expect(getVirtualClockPlaying()).toBe(true)
    expect(getVirtualClockSec()).toBeCloseTo(602, 1)
  })

  it("the first heard line moves later while paused before it: the head goes to it", () => {
    const hook = renderHook((p: typeof props) => useVirtualClockForFile(p), { initialProps: props })
    hook.rerender({ ...props, startSec: 610 })
    expect(getVirtualClockSec()).toBe(610)
  })

  it("paused inside the milestone, a start that moves earlier leaves the head where it is", () => {
    const hook = renderHook((p: typeof props) => useVirtualClockForFile(p), { initialProps: props })
    act(() => virtualClockSeek(630))
    hook.rerender({ ...props, startSec: 590 })
    expect(getVirtualClockSec()).toBe(630)
  })

  it("another milestone: starts again at its start", () => {
    const hook = renderHook((p: typeof props) => useVirtualClockForFile(p), { initialProps: props })
    act(() => virtualClockPlay())
    advance(2000)
    hook.rerender({ ...props, startSec: 700, durationSec: 900, milestoneKey: "m2" })
    expect(getVirtualClockPlaying()).toBe(false)
    expect(getVirtualClockSec()).toBe(700)
    act(() => virtualClockPause())
  })
})

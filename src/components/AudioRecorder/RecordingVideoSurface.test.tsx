// THE ROLLING LEAD-IN. (AQU-646, 2026-08-14)
//
// The film used to sit frozen on the line's first frame through the whole
// countdown and only start moving once the take was already capturing. That
// gave the operator nothing to come in ON — you cannot anticipate an entrance
// from a still frame, you can only react to one after it has gone past, and
// reaction time is the one part of the take-shift problem that may never be
// fixed by trimming (a performer's breath is content, not noise).
//
// So the picture now plays the seconds LEADING UP TO the line and crosses its
// first frame exactly as the count reaches zero. The rule these tests pin is
// that the picture is slaved to the countdown and never the other way round:
// the countdown is the take's clock, and a film that cannot keep up is a
// reading aid running slightly behind — never a take recorded at the wrong
// moment.
//
// The modal-level suite cannot cover this: a <video> in happy-dom never reaches
// HAVE_METADATA on its own, so the seek is deferred forever there. Here the
// readiness is controlled directly.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"

import { RecordingVideoSurface, seekTargetSec } from "./RecordingVideoSurface"

/** Countdown length — the surface derives the run-up from `zeroAtMs`, so this
 *  only has to agree with what the tests pass, not with the modal. */
const LEAD_SEC = 3

function readyVideo() {
  // happy-dom leaves readyState at 0 forever, which is below the bar a
  // currentTime write has to clear, so the surface would defer every seek to a
  // `loadedmetadata` that never comes.
  return vi
    .spyOn(window.HTMLMediaElement.prototype, "readyState", "get")
    .mockReturnValue(4)
}

describe("RecordingVideoSurface — the rolling lead-in", () => {
  let play: ReturnType<typeof vi.spyOn>
  let pause: ReturnType<typeof vi.spyOn>
  let ready: ReturnType<typeof readyVideo>

  beforeEach(() => {
    ready = readyVideo()
    play = vi.spyOn(window.HTMLMediaElement.prototype, "play").mockResolvedValue(undefined)
    pause = vi.spyOn(window.HTMLMediaElement.prototype, "pause").mockImplementation(() => {})
    localStorage.clear()
  })
  afterEach(() => {
    cleanup()
    ready.mockRestore()
    play.mockRestore()
    pause.mockRestore()
    vi.useRealTimers()
  })

  const video = () => screen.getByTestId("rec-video") as HTMLVideoElement

  it("rewinds by the countdown's length and rolls, so the line arrives at zero", () => {
    render(
      <RecordingVideoSurface
        src="film.webm"
        startSec={120}
        running={false}
        armNonce={1}
        overrun={false}
        leadIn={{ zeroAtMs: Date.now() + LEAD_SEC * 1000 }}
      />,
    )
    // Parked three seconds BEFORE the line, not on it.
    expect(video().currentTime).toBeCloseTo(120 - LEAD_SEC, 1)
    // And already moving — the run-up is the whole point.
    expect(play).toHaveBeenCalled()
  })

  it("waits on frame 0 when the line is closer to the head of the film than one lead-in", () => {
    vi.useFakeTimers()
    const zeroAtMs = Date.now() + LEAD_SEC * 1000
    render(
      <RecordingVideoSurface
        src="film.webm"
        startSec={1}
        running={false}
        armNonce={1}
        overrun={false}
        leadIn={{ zeroAtMs }}
      />,
    )
    // There is only one second of runway, so the picture holds at the very
    // start and sets off late enough to still land on zero — a shorter run-up,
    // never a wrong one.
    expect(video().currentTime).toBe(0)
    expect(play).not.toHaveBeenCalled()

    // Two seconds in (one second short of zero) it starts.
    vi.advanceTimersByTime(LEAD_SEC * 1000 - 1000)
    expect(play).toHaveBeenCalled()
  })

  it("parks ON the line and stays still when there is no countdown", () => {
    render(
      <RecordingVideoSurface
        src="film.webm"
        startSec={120}
        running={false}
        armNonce={1}
        overrun={false}
        leadIn={null}
      />,
    )
    expect(video().currentTime).toBeCloseTo(120, 1)
    expect(play).not.toHaveBeenCalled()
  })

  it("does not re-seek or re-start the picture when the take begins — it INHERITS it", () => {
    const leadIn = { zeroAtMs: Date.now() + LEAD_SEC * 1000 }
    const { rerender } = render(
      <RecordingVideoSurface
        src="film.webm" startSec={120} running={false} armNonce={1} overrun={false} leadIn={leadIn}
      />,
    )
    // Stand in for the lead-in having rolled: the picture is on the line now.
    video().currentTime = 120
    play.mockClear()

    // Zero: the countdown clears the lead-in and the take starts, in one commit.
    rerender(
      <RecordingVideoSurface
        src="film.webm" startSec={120} running={true} armNonce={1} overrun={false} leadIn={null}
      />,
    )
    // The picture is where the lead-in left it. A re-seek here would be a jump
    // cut on the operator's entrance.
    expect(video().currentTime).toBeCloseTo(120, 1)
    expect(pause).not.toHaveBeenCalled()
  })

  it("pauses when a countdown is cancelled without a take", () => {
    const leadIn = { zeroAtMs: Date.now() + LEAD_SEC * 1000 }
    const { rerender } = render(
      <RecordingVideoSurface
        src="film.webm" startSec={120} running={false} armNonce={1} overrun={false} leadIn={leadIn}
      />,
    )
    pause.mockClear()
    rerender(
      <RecordingVideoSurface
        src="film.webm" startSec={120} running={false} armNonce={1} overrun={false} leadIn={null}
      />,
    )
    expect(pause).toHaveBeenCalled()
  })

  describe("seekTargetSec", () => {
    it("keeps an untimed line's picture where it is rather than lying with 0", () => {
      expect(seekTargetSec(null)).toBeNull()
      expect(seekTargetSec(undefined)).toBeNull()
      expect(seekTargetSec(Number.NaN)).toBeNull()
    })
    it("never returns a negative, which currentTime would throw on", () => {
      expect(seekTargetSec(-5)).toBe(0)
      expect(seekTargetSec(12.5)).toBe(12.5)
    })
  })
})

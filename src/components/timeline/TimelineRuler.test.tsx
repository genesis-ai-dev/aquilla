// WHY these tests exist: the ruler sizes the whole track, so a bad duration
// here takes the timeline down with it, and its tick loop is the one part of
// the track that never windowed. Both are pinned below.

import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { TimelineRuler } from "./TimelineRuler"

describe("TimelineRuler", () => {
  it("renders a 0:00 label and scrubs to the clicked time", () => {
    const onScrub = vi.fn()
    render(<TimelineRuler durationSec={30} pxPerSec={38} onScrub={onScrub} />)
    expect(screen.getByText("0:00")).toBeInTheDocument()
    // happy-dom getBoundingClientRect is 0-origin, so clientX maps directly.
    fireEvent.click(screen.getByTestId("tl-ruler"), { clientX: 152 })
    expect(onScrub.mock.calls[0][0]).toBeCloseTo(4, 1) // 152 / 38
  })

  // A linked video that has not reported its metadata yet gives Infinity here.
  // The old `width: secToPx(Math.max(durationSec, step))` rendered the literal
  // string "Infinitypx", which the browser drops — taking the track with it.
  it.each([Infinity, NaN, -5])("clamps a %p duration to a finite width", (bad) => {
    render(<TimelineRuler durationSec={bad} pxPerSec={38} onScrub={() => {}} />)
    const width = screen.getByTestId("tl-ruler").style.width
    expect(width).toBe("76px") // one step (2s at this zoom) × 38
  })

  it("draws every tick when no window is given", () => {
    render(<TimelineRuler durationSec={20} pxPerSec={38} onScrub={() => {}} />)
    // step = 2s at 38px/s → 0,2,…,20
    expect(screen.getByTestId("tl-ruler").childElementCount).toBe(11)
  })

  it("draws only the ticks inside the window, and keeps them on the step grid", () => {
    render(
      <TimelineRuler
        durationSec={600}
        pxPerSec={38}
        viewStartSec={101}
        viewEndSec={110}
        onScrub={() => {}}
      />,
    )
    // 101 snaps DOWN to 100 so labels sit at stable absolute seconds: 100…110.
    expect(screen.getByTestId("tl-ruler").childElementCount).toBe(6)
    expect(screen.getByText("1:40")).toBeInTheDocument() // 100s
    expect(screen.getByText("1:50")).toBeInTheDocument() // 110s
    expect(screen.queryByText("0:00")).not.toBeInTheDocument()
  })

  it("keeps the full-track width even when windowed", () => {
    render(
      <TimelineRuler
        durationSec={600}
        pxPerSec={38}
        viewStartSec={100}
        viewEndSec={110}
        onScrub={() => {}}
      />,
    )
    expect(screen.getByTestId("tl-ruler").style.width).toBe(`${600 * 38}px`)
  })

  it("clamps a window that runs past the end of the track", () => {
    render(
      <TimelineRuler durationSec={10} pxPerSec={38} viewStartSec={0} viewEndSec={9999} onScrub={() => {}} />,
    )
    expect(screen.getByTestId("tl-ruler").childElementCount).toBe(6) // 0,2,4,6,8,10
  })
})

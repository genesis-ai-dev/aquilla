// AQU-2654: the liveness mark ticks once a second to keep "synced 12s ago"
// current. The tick must redraw the mark, not the page that shows it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, screen } from "@testing-library/react"
import { LivenessDot } from "./LivenessDot"

describe("LivenessDot", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("keeps its label current without re-rendering the page around it", () => {
    let pageRenders = 0
    function Page() {
      pageRenders += 1
      return (
        <main>
          <LivenessDot bumpedAt={1} />
        </main>
      )
    }
    render(<Page />)
    act(() => {
      vi.advanceTimersByTime(1_000)
    })
    expect(screen.getByRole("button", { name: "Live · synced just now" })).toBeInTheDocument()
    const rendersBefore = pageRenders

    act(() => {
      vi.advanceTimersByTime(12_000)
    })
    // Twelve ticks later the mark has moved on…
    expect(screen.getByRole("button", { name: "Live · synced 13s ago" })).toBeInTheDocument()
    // …and the page was not asked to render once.
    expect(pageRenders).toBe(rendersBefore)
  })

  it("says Live when nothing has been received yet", () => {
    render(<LivenessDot bumpedAt={0} />)
    expect(screen.getByRole("button", { name: "Live" })).toBeInTheDocument()
  })
})

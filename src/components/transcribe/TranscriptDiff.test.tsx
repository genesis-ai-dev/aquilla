import { act, render, screen } from "@testing-library/react"
import { Profiler } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { TypedText } from "./TranscriptDiff"

const LINE = "nilikuwa nikienda sokoni na mama yangu jana asubuhi"

describe("TypedText", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  // AQU-2655: a "transcribe all" pass types a line on every row. A React
  // commit per 30 ms tick made the typing most of the pass's commits, so the
  // letters go straight into the DOM: the line still visibly types out, and
  // React commits only when the typing starts and when it ends.
  it("types the line out without a React commit per tick", () => {
    let commits = 0
    render(
      <Profiler id="typed" onRender={() => { commits++ }}>
        <TypedText text={LINE} />
      </Profiler>,
    )
    const typed = screen.getByTestId("transcribe-typed")
    const mountCommits = commits
    expect(typed.getAttribute("data-typing")).toBe("true")

    act(() => { vi.advanceTimersByTime(150) })
    const midway = typed.textContent ?? ""
    expect(midway.length).toBeGreaterThan(0)
    expect(midway.length).toBeLessThan(LINE.length)
    expect(LINE.startsWith(midway)).toBe(true)
    expect(commits).toBe(mountCommits)

    act(() => { vi.advanceTimersByTime(1_000) })
    expect(typed.textContent).toBe(LINE)
    expect(typed.getAttribute("data-typing")).toBe("false")
    // The one commit that takes the cursor away.
    expect(commits - mountCommits).toBe(1)
  })

  it("starts again from nothing when the line changes", () => {
    const view = render(<TypedText text="eema akasema" />)
    act(() => { vi.advanceTimersByTime(1_000) })
    expect(screen.getByTestId("transcribe-typed").textContent).toBe("eema akasema")

    view.rerender(<TypedText text={LINE} />)
    const typed = screen.getByTestId("transcribe-typed")
    expect(typed.getAttribute("data-typing")).toBe("true")
    act(() => { vi.advanceTimersByTime(60) })
    expect((typed.textContent ?? "").length).toBeLessThan(LINE.length)
    act(() => { vi.advanceTimersByTime(1_000) })
    expect(typed.textContent).toBe(LINE)
  })
})

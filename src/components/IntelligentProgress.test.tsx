import { act, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { IntelligentProgress } from "./IntelligentProgress"
import { FADE_MS, FINISH_MS, FIRST_MS, nextFrame, SECOND_HOLD, SECOND_MS } from "./intelligent-progress-timeline"

describe("nextFrame — the two-stage timeline", () => {
  it("runs a second, bolder fill when the first fills before the answer", () => {
    expect(nextFrame("first", true)).toMatchObject({ phase: "second", second: SECOND_HOLD })
  })

  it("plays whichever bar is running through to full when the answer lands — never a snap", () => {
    expect(nextFrame("first", false)).toEqual({ phase: "finishing", first: 1, second: 0, ms: FINISH_MS })
    expect(nextFrame("second", false)).toEqual({ phase: "finishing", first: 1, second: 1, ms: FINISH_MS })
    expect(nextFrame("finishing", false).phase).toBe("done")
  })
})

describe("IntelligentProgress", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const flushFrame = () => act(() => { vi.advanceTimersByTime(20) })
  /** Effects schedule each stage's timer after React flushes, so advance in
   *  small steps the way real time passes. */
  const elapse = (ms: number) => {
    for (let t = 0; t < ms; t += 10) act(() => { vi.advanceTimersByTime(Math.min(10, ms - t)) })
  }

  it("reveals a fast answer only after a short finish, not instantly and not after the full curve", () => {
    const onSettled = vi.fn()
    const { rerender } = render(<IntelligentProgress pending label="x" onSettled={onSettled} />)
    flushFrame()
    elapse(100)
    rerender(<IntelligentProgress pending={false} label="x" onSettled={onSettled} />)
    elapse(FINISH_MS - 1)
    expect(onSettled).not.toHaveBeenCalled()
    elapse(1 + FADE_MS + FADE_MS)
    expect(onSettled).toHaveBeenCalledTimes(1)
  })

  it("moves to the second bar on a slow answer and holds there until it lands", () => {
    const onSettled = vi.fn()
    const { container, rerender } = render(<IntelligentProgress pending label="x" onSettled={onSettled} />)
    flushFrame()
    elapse(FIRST_MS + 10)
    const bar = container.querySelector("[role=progressbar]")!
    expect(bar.getAttribute("data-phase")).toBe("second")
    elapse(SECOND_MS * 3)
    expect(bar.getAttribute("data-phase")).toBe("second")
    expect(onSettled).not.toHaveBeenCalled()
    rerender(<IntelligentProgress pending={false} label="x" onSettled={onSettled} />)
    elapse(FINISH_MS + FADE_MS * 2 + 10)
    expect(onSettled).toHaveBeenCalledTimes(1)
  })

  it("still finishes and reveals when animation frames never fire (background tab)", () => {
    const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 0)
    const onSettled = vi.fn()
    const { rerender } = render(<IntelligentProgress pending label="x" onSettled={onSettled} />)
    rerender(<IntelligentProgress pending={false} label="x" onSettled={onSettled} />)
    elapse(FINISH_MS + FADE_MS * 2 + 50)
    expect(onSettled).toHaveBeenCalledTimes(1)
    raf.mockRestore()
  })
})

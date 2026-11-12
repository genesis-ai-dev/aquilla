import { act, cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  FILLS_TWICE_FINISH_MS,
  FILLS_TWICE_FIRST_MS,
  FillsTwiceIndicator,
} from "./fills-twice-indicator"

function stubReducedMotion(reduced: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: reduced && query.includes("prefers-reduced-motion"),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
  }))
}

beforeEach(() => {
  stubReducedMotion(false)
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] })
})

afterEach(() => {
  cleanup()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("FillsTwiceIndicator", () => {
  it("shows the first fill while the call is still pending", () => {
    render(<FillsTwiceIndicator pending label="Working" />)

    const bar = screen.getByRole("progressbar", { name: "Working" })
    expect(bar).toHaveAttribute("data-pass", "1")
    expect(bar).toHaveAttribute("data-state", "filling")
    expect(bar.querySelector("[data-fill='first']")).not.toBeNull()
    expect(bar.querySelector("[data-fill='second']")).toBeNull()
    expect(bar).toHaveClass("pointer-events-none")
  })

  it("shows the second pass when the call is still pending after the first fill", () => {
    render(<FillsTwiceIndicator pending label="Working" />)

    act(() => {
      vi.advanceTimersByTime(FILLS_TWICE_FIRST_MS)
    })

    const bar = screen.getByRole("progressbar", { name: "Working" })
    expect(bar).toHaveAttribute("data-pass", "2")
    expect(bar).toHaveAttribute("data-state", "filling")
    expect(bar.querySelector("[data-fill='second']")).not.toBeNull()
  })

  it("reaches a completed state when the response arrives, without waiting out the fill", () => {
    const view = render(<FillsTwiceIndicator pending label="Working" />)
    view.rerender(<FillsTwiceIndicator pending={false} label="Working" />)

    const finishing = screen.getByRole("progressbar", { name: "Working" })
    expect(finishing).toHaveAttribute("data-state", "finishing")

    act(() => {
      vi.advanceTimersByTime(FILLS_TWICE_FINISH_MS)
    })

    expect(screen.getByRole("progressbar", { name: "Working" })).toHaveAttribute("data-state", "complete")
  })

  it("draws nothing and waits on no timer when the response is already back", () => {
    render(<FillsTwiceIndicator pending={false} label="Working" />)

    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument()
    act(() => {
      vi.advanceTimersByTime(FILLS_TWICE_FIRST_MS)
    })
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument()
  })

  it("does not fill when the user prefers reduced motion", () => {
    stubReducedMotion(true)
    const view = render(<FillsTwiceIndicator pending label="Working" />)

    const status = screen.getByRole("status", { name: "Working" })
    expect(status).toHaveAttribute("data-motion", "reduced")
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument()
    expect(status.querySelector("[data-fill]")).toBeNull()
    expect(status.querySelector(".fills-twice-grow")).toBeNull()

    act(() => {
      vi.advanceTimersByTime(FILLS_TWICE_FIRST_MS + FILLS_TWICE_FINISH_MS)
    })

    expect(screen.getByRole("status", { name: "Working" })).toHaveAttribute("data-motion", "reduced")
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument()

    view.rerender(<FillsTwiceIndicator pending={false} label="Working" />)
    expect(screen.queryByRole("status", { name: "Working" })).not.toBeInTheDocument()
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument()
  })
})

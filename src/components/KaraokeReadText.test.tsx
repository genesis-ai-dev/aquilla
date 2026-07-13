import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup } from "@testing-library/react"
import { KaraokeReadText } from "./KaraokeReadText"

afterEach(cleanup)

describe("KaraokeReadText", () => {
  it("paints the active word span and preserves the surrounding text", () => {
    const { container } = render(<KaraokeReadText text="hello world" range={{ start: 0, end: 5 }} />)
    const active = container.querySelector(".karaoke-active")
    expect(active?.textContent).toBe("hello")
    // The full text is still present (before + active + after).
    expect(container.textContent).toBe("hello world")
  })

  it("moves the highlight to a later word", () => {
    const { container } = render(<KaraokeReadText text="hello world" range={{ start: 6, end: 11 }} />)
    expect(container.querySelector(".karaoke-active")?.textContent).toBe("world")
    expect(container.textContent).toBe("hello world")
  })

  it("clamps an out-of-bounds range to the text and never drops characters", () => {
    const { container } = render(<KaraokeReadText text="hi" range={{ start: 0, end: 99 }} />)
    expect(container.querySelector(".karaoke-active")?.textContent).toBe("hi")
    expect(container.textContent).toBe("hi")
  })

  it("renders plain text with no highlight for a degenerate range", () => {
    const { container } = render(<KaraokeReadText text="hello" range={{ start: 3, end: 3 }} />)
    expect(container.querySelector(".karaoke-active")).toBeNull()
    expect(container.textContent).toBe("hello")
  })
})

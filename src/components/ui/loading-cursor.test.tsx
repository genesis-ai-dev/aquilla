import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { LoadingCursor, LoadingLine, LoadingLines } from "./loading-cursor"

describe("LoadingCursor", () => {
  it("is decorative and hidden from assistive technology", () => {
    const { container } = render(<LoadingCursor />)
    const cursor = container.querySelector('[data-slot="loading-cursor"]')
    expect(cursor).toHaveAttribute("aria-hidden", "true")
    expect(cursor).toHaveClass("animate-cursor-blink")
  })

  it("keeps a known label visible ahead of the cursor", () => {
    render(<LoadingLine label="Owner" />)
    expect(screen.getByText("Owner")).toBeInTheDocument()
    expect(document.querySelector('[data-slot="loading-cursor"]')).toBeInTheDocument()
  })

  it("renders one cursor per requested line", () => {
    const { container } = render(<LoadingLines count={4} />)
    expect(container.querySelectorAll('[data-slot="loading-cursor"]')).toHaveLength(4)
  })
})

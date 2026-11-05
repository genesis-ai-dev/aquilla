import { render } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { LoadingCursor } from "./loading-cursor"

describe("LoadingCursor", () => {
  it("is decorative and hidden from assistive technology", () => {
    const { container } = render(<LoadingCursor />)
    const cursor = container.querySelector('[data-slot="loading-cursor"]')
    expect(cursor).toHaveAttribute("aria-hidden", "true")
    expect(cursor).toHaveClass("animate-cursor-blink")
  })
})

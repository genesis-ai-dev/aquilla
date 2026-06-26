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
})

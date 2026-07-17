// Verifies the target-duration bar's numeric overage readout (AQU-614): once
// elapsed passes the cue target, the bar footer surfaces a concrete "+X.Xs over"
// figure (live count-up while recording, final figure on the preview screen),
// and shows nothing when still inside the window. Free-form cells never render
// this component, so the guard here is "no target overrun => no readout".

import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { DurationBar } from "./DurationBar"

describe("DurationBar overage readout", () => {
  it("shows the numeric overage once elapsed passes the target", () => {
    // target 3.0s, elapsed 5.3s => 2.3s over
    render(<DurationBar elapsedMs={5300} targetSec={3} />)
    expect(screen.getByText("+2.3s over")).toBeTruthy()
  })

  it("counts the overage up as elapsed grows (live recording)", () => {
    const { rerender } = render(<DurationBar elapsedMs={3500} targetSec={3} />)
    expect(screen.getByText("+0.5s over")).toBeTruthy()
    rerender(<DurationBar elapsedMs={4200} targetSec={3} />)
    expect(screen.queryByText("+0.5s over")).toBeNull()
    expect(screen.getByText("+1.2s over")).toBeTruthy()
  })

  it("shows no overage readout while still inside the target window", () => {
    render(<DurationBar elapsedMs={2000} targetSec={3} />)
    expect(screen.queryByText(/over/)).toBeNull()
  })

  it("shows no overage readout exactly at the target boundary", () => {
    render(<DurationBar elapsedMs={3000} targetSec={3} />)
    expect(screen.queryByText(/over/)).toBeNull()
  })
})

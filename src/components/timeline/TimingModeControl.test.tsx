import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { TimingModeControl } from "./TimingModeControl"

// In the media view's top bar the Timing control sits between the Film button
// and the icon buttons (canvas board 23), so it takes their 28 px height.
describe("TimingModeControl sizes", () => {
  it("matches the top bar's buttons when sized for the bar", () => {
    render(<TimingModeControl size="bar" mode="dubbing" onChange={() => {}} />)
    expect(screen.getByTestId("tl-timing-mode-trigger")).toHaveClass("h-7")
    expect(screen.getByTestId("tl-timing-mode")).toHaveClass("text-[0.8rem]")
  })

  it("keeps the read-only label at the same height in the bar", () => {
    render(<TimingModeControl size="bar" mode="dubbing" filmTimed />)
    expect(screen.getByTestId("tl-timing-mode-dubbing")).toHaveClass("h-7")
  })

  it("stays compact elsewhere", () => {
    render(<TimingModeControl mode="dubbing" onChange={() => {}} />)
    expect(screen.getByTestId("tl-timing-mode-trigger")).toHaveClass("h-6")
  })
})

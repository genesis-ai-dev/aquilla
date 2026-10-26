// Media redesign, layout: the Panels menu is how a folded panel comes back.

import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MediaPanelsMenu } from "./MediaPanelsMenu"
import type { MediaSectionId } from "./media-section-layout"

const setup = (over: Partial<Parameters<typeof MediaPanelsMenu>[0]> = {}) => {
  const props = {
    present: ["timeline", "video", "text"] as MediaSectionId[],
    isVisible: (id: MediaSectionId) => id !== "video",
    canCollapse: () => true,
    collapse: vi.fn(),
    expand: vi.fn(),
    resetLayout: vi.fn(),
    ...over,
  }
  render(<MediaPanelsMenu {...props} />)
  return props
}

describe("MediaPanelsMenu", () => {
  it("is a labelled menu that ticks the panels on screen", async () => {
    setup()
    await userEvent.click(screen.getByRole("button", { name: "Panels" }))
    expect(screen.getByTestId("media-panels-timeline")).toHaveAttribute("aria-checked", "true")
    expect(screen.getByTestId("media-panels-video")).toHaveAttribute("aria-checked", "false")
    expect(screen.getByTestId("media-panels-text")).toHaveAttribute("aria-checked", "true")
  })

  it("brings a hidden panel back, and hides a shown one", async () => {
    const props = setup()
    await userEvent.click(screen.getByRole("button", { name: "Panels" }))
    await userEvent.click(screen.getByTestId("media-panels-video"))
    expect(props.expand).toHaveBeenCalledWith("video")
    // A tick item keeps the menu open, so the next one is right there.
    await userEvent.click(screen.getByTestId("media-panels-timeline"))
    expect(props.collapse).toHaveBeenCalledWith("timeline")
  })

  it("greys out a panel that cannot be hidden, with the reason", async () => {
    setup({
      present: ["timeline", "text"],
      isVisible: () => true,
      canCollapse: (id) => id !== "text",
    })
    await userEvent.click(screen.getByRole("button", { name: "Panels" }))
    expect(screen.getByTestId("media-panels-text")).toHaveAttribute("aria-disabled", "true")
    expect(screen.getByTestId("media-panels-text-reason")).toBeInTheDocument()
  })

  it("offers Reset layout", async () => {
    const props = setup()
    await userEvent.click(screen.getByRole("button", { name: "Panels" }))
    await userEvent.click(screen.getByTestId("media-panels-reset"))
    expect(props.resetLayout).toHaveBeenCalledTimes(1)
  })
})

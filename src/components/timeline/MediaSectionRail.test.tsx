// AQU-1119, and the media redesign's layout: a folded section takes no room,
// so what is left to pin here is the pair of controls beside each heading —
// fold it, or give it the lens.

import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MediaSectionCollapseButton, MediaSectionFullscreenButton } from "./MediaSectionRail"

describe("MediaSectionCollapseButton", () => {
  it("is the same control reading the other way round", () => {
    render(<MediaSectionCollapseButton section="timeline" onCollapse={() => {}} />)
    const button = screen.getByRole("button", { name: "Hide the timeline" })
    expect(button).toHaveAttribute("aria-expanded", "true")
  })

  it("collapses on click", () => {
    const onCollapse = vi.fn()
    render(<MediaSectionCollapseButton section="video" onCollapse={onCollapse} />)
    return userEvent.click(screen.getByTestId("media-collapse-video")).then(() => {
      expect(onCollapse).toHaveBeenCalledTimes(1)
    })
  })

  it("carries no text of its own", () => {
    // The video header's textContent is asserted elsewhere ("Video" plus the
    // file name and nothing else), and both headers are kept in height
    // lockstep, so this button has to stay wordless.
    render(<MediaSectionCollapseButton section="video" onCollapse={() => {}} />)
    expect(screen.getByTestId("media-collapse-video")).toHaveTextContent("")
  })
})

describe("MediaSectionFullscreenButton", () => {
  it("offers to fill the lens, and to undo that once it has", () => {
    // One button in two states, named for what pressing it will DO — the
    // glyph and the name swap together.
    const { rerender } = render(
      <MediaSectionFullscreenButton section="video" isFullscreen={false} onToggle={() => {}} />,
    )
    const button = screen.getByTestId("media-fullscreen-video")
    expect(button).toHaveAccessibleName("Fill the lens with the video")
    expect(button).toHaveAttribute("aria-pressed", "false")

    rerender(
      <MediaSectionFullscreenButton section="video" isFullscreen onToggle={() => {}} />,
    )
    expect(button).toHaveAccessibleName("Put the video back in its column")
    expect(button).toHaveAttribute("aria-pressed", "true")
  })

  it("lets the timeline take the lens too, and names the way back", () => {
    const { rerender } = render(
      <MediaSectionFullscreenButton section="timeline" isFullscreen={false} onToggle={() => {}} />,
    )
    const button = screen.getByTestId("media-fullscreen-timeline")
    expect(button).toHaveAccessibleName("Fill the lens with the timeline")
    rerender(<MediaSectionFullscreenButton section="timeline" isFullscreen onToggle={() => {}} />)
    expect(button).toHaveAccessibleName("Restore the other panels")
  })

  it("names the text section for itself", () => {
    render(<MediaSectionFullscreenButton section="text" isFullscreen={false} onToggle={() => {}} />)
    expect(screen.getByTestId("media-fullscreen-text")).toHaveAccessibleName(
      "Fill the lens with the text",
    )
  })

  it("toggles on a single click", () => {
    const onToggle = vi.fn()
    render(<MediaSectionFullscreenButton section="video" isFullscreen={false} onToggle={onToggle} />)
    return userEvent.click(screen.getByTestId("media-fullscreen-video")).then(() => {
      expect(onToggle).toHaveBeenCalledTimes(1)
    })
  })

  it("carries no text of its own", () => {
    // It sits in the video header, whose textContent is asserted to be "Video"
    // plus the file name and nothing else.
    render(<MediaSectionFullscreenButton section="video" isFullscreen={false} onToggle={() => {}} />)
    expect(screen.getByTestId("media-fullscreen-video")).toHaveTextContent("")
  })
})

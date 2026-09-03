// AQU-1119. The rail is the whole reason the round exists: a collapsed
// section used to leave nothing to click but the divider's grip, and dragging
// that open did nothing for the first 110px. So what this file pins is that
// the rail is a real, named, one-click control.

import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MediaSectionCollapseButton, MediaSectionRail } from "./MediaSectionRail"

describe("MediaSectionRail", () => {
  it("is one button per section, named for what it will do", () => {
    // Icon-only, so the accessible name IS the label — there is no visible
    // text to fall back on and the tooltip carries the same string.
    for (const [section, name] of [
      ["video", "Show the video"],
      ["timeline", "Show the timeline"],
      ["text", "Show the text"],
    ] as const) {
      const { unmount } = render(
        <MediaSectionRail section={section} orientation="vertical" onExpand={() => {}} />,
      )
      expect(screen.getByRole("button", { name })).toBeVisible()
      unmount()
    }
  })

  it("announces the state it is in, not just the action", () => {
    render(<MediaSectionRail section="video" orientation="vertical" onExpand={() => {}} />)
    expect(screen.getByTestId("media-rail-video")).toHaveAttribute("aria-expanded", "false")
  })

  it("expands on a single click", () => {
    const onExpand = vi.fn()
    render(<MediaSectionRail section="text" orientation="vertical" onExpand={onExpand} />)
    return userEvent.click(screen.getByTestId("media-rail-text")).then(() => {
      expect(onExpand).toHaveBeenCalledTimes(1)
    })
  })
})

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

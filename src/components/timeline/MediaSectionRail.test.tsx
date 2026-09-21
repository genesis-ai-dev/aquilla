// AQU-1119. The rail is the whole reason the round exists: a collapsed
// section used to leave nothing to click but the divider's grip, and dragging
// that open did nothing for the first 110px. So what this file pins is that
// the rail is a real, named, one-click control.

import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import {
  MediaSectionCollapseButton,
  MediaSectionFullscreenButton,
  MediaSectionRail,
} from "./MediaSectionRail"

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

  it("keeps a section's name on the rail when the strip has room for it", () => {
    // The timeline folds to a strip the full width of the lens, so its name
    // survives the fold and the rail reads as the toolbar with the tools
    // taken away. The accessible name is still the aria-label, which is the
    // action rather than the section.
    render(
      <MediaSectionRail
        section="timeline"
        orientation="horizontal"
        label="Timeline"
        onExpand={() => {}}
      />,
    )
    const rail = screen.getByTestId("media-rail-timeline")
    expect(rail).toHaveTextContent("Timeline")
    expect(screen.getByRole("button", { name: "Show the timeline" })).toBe(rail)
  })

  it("runs the section's name down a side rail, like the Bibles edge tab", () => {
    render(
      <MediaSectionRail section="video" orientation="vertical" label="Video" onExpand={() => {}} />,
    )
    const rail = screen.getByTestId("media-rail-video")
    expect(rail).toHaveTextContent("Video")
    // Still named for the action, not the section — the name is scenery.
    expect(screen.getByRole("button", { name: "Show the video" })).toBe(rail)
  })

  it("shows only the glyph when no name is passed", () => {
    render(<MediaSectionRail section="video" orientation="vertical" onExpand={() => {}} />)
    expect(screen.getByTestId("media-rail-video")).toHaveTextContent("")
  })

  it("is scenery, not a control, while a drag is still holding the divider", () => {
    // Mid-drag the fold is not committed — the pointer can still come back —
    // so the preview must not be clickable, focusable, or announced.
    const onExpand = vi.fn()
    render(
      <MediaSectionRail section="text" orientation="vertical" preview onExpand={onExpand} />,
    )
    expect(screen.queryByTestId("media-rail-text")).toBeNull()
    expect(screen.queryByRole("button", { name: "Show the text" })).toBeNull()
    const preview = screen.getByTestId("media-rail-preview-text")
    expect(preview).toHaveAttribute("aria-hidden", "true")
    expect(preview.tagName).toBe("DIV")
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

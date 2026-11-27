// D#13 (import map, Nov 2): this card's address field and Link a film's both
// said "https://example.com/episode.mp4", though they take different links and
// store them differently. Each now says what it takes.
import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { TimelineAddMedia } from "./TimelineAddMedia"
import { LinkVideoUrlDialog } from "./timeline/LinkVideoUrlDialog"

describe("TimelineAddMedia's address field", () => {
  it("says it takes a direct link to an audio or video file, not YouTube", () => {
    render(<TimelineAddMedia onAttachFile={vi.fn()} onAttachUrl={vi.fn()} />)
    expect(screen.getByRole("textbox")).toHaveAttribute(
      "placeholder", "A direct link to an audio or video file (not YouTube)",
    )
  })

  it("does not share Link a film's placeholder", () => {
    render(<TimelineAddMedia onAttachFile={vi.fn()} onAttachUrl={vi.fn()} />)
    const card = screen.getByRole("textbox").getAttribute("placeholder")
    render(<LinkVideoUrlDialog open currentUrl={null} onSave={vi.fn()} onCancel={vi.fn()} />)
    const film = screen.getByTestId("link-video-url-input").getAttribute("placeholder")
    expect(card).not.toBe(film)
  })
})

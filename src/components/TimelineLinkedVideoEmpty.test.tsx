// Import map D#28 (Nov 2): on a linked film's card, a project lead with no
// captions action was offered "Back to captions" from the recording step,
// though the first step offers them no captions to go back to.
import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { TimelineLinkedVideoEmpty } from "./TimelineLinkedVideoEmpty"

function openRecordingStep() {
  // The first step's link into the recording step, whichever wording it has.
  const link = screen.getAllByRole("button").find((b) => /rows from an audio or video file/i.test(b.textContent ?? ""))
  if (!link) throw new Error("no recording link on the first step")
  fireEvent.click(link)
}

describe("TimelineLinkedVideoEmpty's recording step", () => {
  it("offers a plain Back to someone the first step offers no captions to", () => {
    render(<TimelineLinkedVideoEmpty isYouTube={false} captionTracks={[]} onAttachFile={vi.fn()} onOpenMediaView={vi.fn()} />)
    openRecordingStep()
    expect(screen.getByTestId("linked-video-recording-back")).toHaveTextContent(/^Back$/)
    expect(screen.queryByText("Back to captions")).toBeNull()
  })

  it("keeps Back to captions for someone who can attach captions", () => {
    render(<TimelineLinkedVideoEmpty isYouTube={false} captionTracks={[]} onAttachFile={vi.fn()} onAttachCaptions={vi.fn()} />)
    openRecordingStep()
    expect(screen.getByTestId("linked-video-recording-back")).toHaveTextContent("Back to captions")
  })
})

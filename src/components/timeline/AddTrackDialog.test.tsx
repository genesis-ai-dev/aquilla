// AQU-646 stage 6J: the add-track dialog's first tests.
//
// It shipped in stage 2 with none — `tl-add-track-name`, `-align` and
// `-confirm` had zero references anywhere — so the candidate rule, the reseed
// and the default name were all unprotected. Sam's 2026-08-27 round changed two
// of the three, which is the moment to pin all of them.

import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent, within } from "@testing-library/react"

import { AddTrackDialog } from "./AddTrackDialog"
import type { TimelineTrack } from "@/lib/timeline/tracks"

const track = (id: string, name: string, kind: TimelineTrack["kind"]): TimelineTrack =>
  ({ id, name, kind, order: 0 }) as TimelineTrack

const SOURCE_TEXT = track("source-subtitles", "Source text", "source-subtitles")
const SOURCE_AUDIO = track("source-audio", "Source audio", "source-audio")

function open(candidates: TimelineTrack[], defaultName = "Track") {
  const onConfirm = vi.fn()
  render(
    <AddTrackDialog
      open
      candidates={candidates}
      defaultName={defaultName}
      onCancel={() => {}}
      onConfirm={onConfirm}
    />,
  )
  return { onConfirm }
}

describe("AddTrackDialog — what the new track lines up with", () => {
  // Sam, 2026-08-27: "if there's only one option, the modal shouldn't present a
  // dropdown. It should just list that one option as what it's going to be
  // aligned with."
  it("states the single option instead of asking about it", () => {
    open([SOURCE_AUDIO])
    expect(screen.getByTestId("tl-add-track-align-fixed")).toHaveTextContent("Source audio")
    expect(screen.queryByTestId("tl-add-track-align")).toBeNull()
  })

  it("still asks when there is a real choice", () => {
    open([SOURCE_TEXT, SOURCE_AUDIO])
    const select = screen.getByTestId("tl-add-track-align")
    expect(select).toBeInTheDocument()
    expect(within(select).getAllByRole("option").map((o) => o.textContent))
      .toEqual(["Source text", "Source audio"])
    expect(screen.queryByTestId("tl-add-track-align-fixed")).toBeNull()
  })

  // The stated option is not decoration: it is what gets saved.
  it("confirms with the single option even though nothing was picked", () => {
    const { onConfirm } = open([SOURCE_AUDIO])
    fireEvent.click(screen.getByTestId("tl-add-track-confirm"))
    expect(onConfirm).toHaveBeenCalledWith({ name: "Track", sourceTrackId: "source-audio" })
  })

  it("confirms with whichever option was chosen", () => {
    const { onConfirm } = open([SOURCE_TEXT, SOURCE_AUDIO])
    fireEvent.change(screen.getByTestId("tl-add-track-align"), { target: { value: "source-audio" } })
    fireEvent.click(screen.getByTestId("tl-add-track-confirm"))
    expect(onConfirm).toHaveBeenCalledWith({ name: "Track", sourceTrackId: "source-audio" })
  })
})

describe("AddTrackDialog — the name", () => {
  it("offers the name the caller computed, and confirms with it untouched", () => {
    const { onConfirm } = open([SOURCE_AUDIO], "Track 2")
    expect(screen.getByTestId("tl-add-track-name")).toHaveValue("Track 2")
    fireEvent.click(screen.getByTestId("tl-add-track-confirm"))
    expect(onConfirm).toHaveBeenCalledWith({ name: "Track 2", sourceTrackId: "source-audio" })
  })

  it("takes a name typed over it, trimmed", () => {
    const { onConfirm } = open([SOURCE_AUDIO])
    fireEvent.change(screen.getByTestId("tl-add-track-name"), { target: { value: "  Spanish VO  " } })
    fireEvent.click(screen.getByTestId("tl-add-track-confirm"))
    expect(onConfirm).toHaveBeenCalledWith({ name: "Spanish VO", sourceTrackId: "source-audio" })
  })

  it("Enter in the name field confirms", () => {
    const { onConfirm } = open([SOURCE_AUDIO])
    fireEvent.keyDown(screen.getByTestId("tl-add-track-name"), { key: "Enter" })
    expect(onConfirm).toHaveBeenCalledWith({ name: "Track", sourceTrackId: "source-audio" })
  })

  it("refuses an empty name", () => {
    open([SOURCE_AUDIO])
    fireEvent.change(screen.getByTestId("tl-add-track-name"), { target: { value: "   " } })
    expect(screen.getByTestId("tl-add-track-confirm")).toBeDisabled()
  })

  // Cancelling with a half-typed name and reopening must not show that name
  // again as though it had been saved.
  // Found in review: 6J made `defaultName` a live value derived from the synced
  // track list, and the reseed effect was still keyed on it — so a track
  // arriving from anywhere while the dialog was open wiped what you were
  // typing.
  it("does not wipe a typed name when the track list changes underneath it", () => {
    const props = { candidates: [SOURCE_AUDIO], onCancel: () => {}, onConfirm: () => {} }
    const { rerender } = render(<AddTrackDialog open defaultName="Track" {...props} />)
    fireEvent.change(screen.getByTestId("tl-add-track-name"), { target: { value: "Spanish VO" } })
    // A collaborator's track lands, so the automatic name moves on.
    rerender(<AddTrackDialog open defaultName="Track 1" {...props} />)
    expect(screen.getByTestId("tl-add-track-name")).toHaveValue("Spanish VO")
  })

  it("names the alignment picker for a screen reader", () => {
    open([SOURCE_TEXT, SOURCE_AUDIO])
    expect(screen.getByRole("combobox", { name: "Line it up with" })).toBeInTheDocument()
  })

  // The server has always refused a name over 120 characters, and nothing here
  // did — while `onConfirm` mints a uuidv7, emits and closes without awaiting,
  // so an over-long name produced a track id the caller treated as real for a
  // track the server never created (2026-08-27).
  it("will not let a name past the length the server accepts", () => {
    open([SOURCE_AUDIO])
    const input = screen.getByTestId("tl-add-track-name")
    // Mirrors MAX_TRACK_NAME_LENGTH in the worker's file-track-set handler.
    expect(input).toHaveAttribute("maxLength", "120")
  })

  it("reseeds on every open", () => {
    const { rerender } = render(
      <AddTrackDialog
        open
        candidates={[SOURCE_AUDIO]}
        defaultName="Track"
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    )
    fireEvent.change(screen.getByTestId("tl-add-track-name"), { target: { value: "half-typed" } })
    const props = { candidates: [SOURCE_AUDIO], onCancel: () => {}, onConfirm: () => {} }
    rerender(<AddTrackDialog open={false} defaultName="Track" {...props} />)
    rerender(<AddTrackDialog open defaultName="Track 1" {...props} />)
    expect(screen.getByTestId("tl-add-track-name")).toHaveValue("Track 1")
  })
})

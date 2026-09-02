import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { expectTooltip, renderWithTooltips } from "@/test-utils/tooltip"
import { TranscribeSelectionControls } from "./TranscribeSelectionControls"

const props = {
  selectedCount: 1,
  eligibleCount: 1,
  recordingCount: 1,
  busy: false,
  onTranscribe: () => {},
  onClear: () => {},
}

// AQU-928 built these as the discoverability fix — the only place in the media
// view that says a section-scoped transcribe exists and how to select more than
// one. Their copy and their disabled reasons are the contract. AQU-646 stage 3e
// moved them out of a row of their own and into the text header; what they SAY
// is unchanged, and these cases are what says so.
describe("TranscribeSelectionControls", () => {
  it("offers a single-section transcribe once one section is selected", async () => {
    const onTranscribe = vi.fn()
    render(<TranscribeSelectionControls {...props} onTranscribe={onTranscribe} />)
    expect(screen.getByTestId("tl-transcribe-count")).toHaveTextContent("1 section selected")
    const button = screen.getByTestId("tl-transcribe-selection")
    expect(button).toHaveTextContent("Transcribe section")
    expect(button).toBeEnabled()
    await userEvent.click(button)
    expect(onTranscribe).toHaveBeenCalledTimes(1)
  })

  it("counts the sections in the button label when several are selected", () => {
    render(<TranscribeSelectionControls {...props} selectedCount={3} eligibleCount={3} recordingCount={3} />)
    expect(screen.getByTestId("tl-transcribe-count")).toHaveTextContent("3 sections selected")
    expect(screen.getByTestId("tl-transcribe-selection")).toHaveTextContent("Transcribe 3 sections")
  })

  // The label counts what will ACTUALLY run: including a section with no
  // recording must not promise work that cannot happen.
  it("labels the ELIGIBLE count, not the selected count", () => {
    render(<TranscribeSelectionControls {...props} selectedCount={4} eligibleCount={2} recordingCount={2} />)
    expect(screen.getByTestId("tl-transcribe-count")).toHaveTextContent("4 sections selected")
    expect(screen.getByTestId("tl-transcribe-selection")).toHaveTextContent("Transcribe 2 sections")
  })

  // Stage 3e: the multi-select gesture stopped being a line of text on the far
  // right and became a tooltip on the count — the place where "how do I select
  // more?" is the question you are already asking.
  it("keeps the multi-select gesture, as a tooltip on the count", async () => {
    renderWithTooltips(<TranscribeSelectionControls {...props} />)
    expect(screen.queryByText(/Ctrl\/⌘-click or Shift-click chips/)).toBeNull()
    await expectTooltip(
      screen.getByTestId("tl-transcribe-count"),
      /Ctrl\/⌘-click or Shift-click chips/,
    )
  })

  // …and it has to be reachable without a pointer, because the text it replaced
  // was readable by everyone.
  it("lets the keyboard reach that hint", () => {
    render(<TranscribeSelectionControls {...props} />)
    expect(screen.getByTestId("tl-transcribe-count")).toHaveAttribute("tabindex", "0")
  })

  it("disables with a why when the selection has no audio at all", async () => {
    renderWithTooltips(<TranscribeSelectionControls {...props} selectedCount={2} eligibleCount={0} recordingCount={0} />)
    expect(screen.getByTestId("tl-transcribe-selection")).toBeDisabled()
    await expectTooltip(
      screen.getByTestId("tl-transcribe-selection"),
      /None of the selected sections has audio to transcribe/i,
    )
  })

  it("disables while another audio batch owns the progress slot", async () => {
    renderWithTooltips(<TranscribeSelectionControls {...props} busy />)
    expect(screen.getByTestId("tl-transcribe-selection")).toBeDisabled()
    await expectTooltip(screen.getByTestId("tl-transcribe-selection"), /Another audio batch is running/i)
  })

  it("explains what the run will and will not touch when it is ready", async () => {
    renderWithTooltips(<TranscribeSelectionControls {...props} />)
    await expectTooltip(
      screen.getByTestId("tl-transcribe-selection"),
      /selected sections' audio only — the rest of the file is left alone/i,
    )
  })

  // Clear is unconditional now. It used to be withheld at zero, which was the
  // only state where it had nothing to do — and that state no longer renders.
  it("always offers Clear, because it only exists with a selection", async () => {
    const onClear = vi.fn()
    render(<TranscribeSelectionControls {...props} onClear={onClear} />)
    await userEvent.click(screen.getByTestId("tl-transcribe-clear"))
    expect(onClear).toHaveBeenCalledTimes(1)
  })
})

// AQU-646 stage 3g — when several sections share one heard line.
//
// One heard line can perform several subtitles, and 22.7% of them do — the most
// common of this round's collapses by some way. Three selected sections can be
// three sections' worth of ONE recording, and the run transcribes it once. The
// button used to say "Transcribe 3 sections", which is true about the sections
// and misleading about the work.
//
// The notice IS the labels: no strip was added to a header that had just been
// decluttered. What is pinned here is that the numbers stop lying.
describe("TranscribeSelectionControls — sections that share a recording", () => {
  it("counts the RECORDINGS on the button, not the sections", () => {
    render(<TranscribeSelectionControls {...props} selectedCount={3} eligibleCount={3} recordingCount={1} />)
    expect(screen.getByTestId("tl-transcribe-selection")).toHaveTextContent("Transcribe section")
    expect(screen.getByTestId("tl-transcribe-selection")).not.toHaveTextContent("3")
  })

  it("shows both numbers so the difference is visible before pressing", () => {
    render(<TranscribeSelectionControls {...props} selectedCount={3} eligibleCount={3} recordingCount={1} />)
    expect(screen.getByTestId("tl-transcribe-count")).toHaveTextContent("3 sections selected")
    expect(screen.getByTestId("tl-transcribe-recordings")).toHaveTextContent("1 recording")
  })

  it("explains WHY they differ, on hover", async () => {
    renderWithTooltips(
      <TranscribeSelectionControls {...props} selectedCount={3} eligibleCount={3} recordingCount={1} />,
    )
    await expectTooltip(
      screen.getByTestId("tl-transcribe-selection"),
      /performed by the same heard line/i,
    )
  })

  // The overwhelmingly common case: nothing is shared, and the labels read
  // exactly as they always did. A second number here would be noise on 77% of
  // heard lines.
  it("says nothing extra when the counts agree", () => {
    render(<TranscribeSelectionControls {...props} selectedCount={3} eligibleCount={3} recordingCount={3} />)
    expect(screen.queryByTestId("tl-transcribe-recordings")).toBeNull()
    expect(screen.getByTestId("tl-transcribe-selection")).toHaveTextContent("Transcribe 3 sections")
  })
})

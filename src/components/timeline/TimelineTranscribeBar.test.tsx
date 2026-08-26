import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { expectTooltip, renderWithTooltips } from "@/test-utils/tooltip"
import { TimelineTranscribeBar } from "./TimelineTranscribeBar"

const props = {
  selectedCount: 0,
  eligibleCount: 0,
  busy: false,
  onTranscribe: () => {},
  onClear: () => {},
}

// AQU-928: this row IS the discoverability fix — it is the only place in the
// media view that says a section-scoped transcribe exists and how to select
// more than one. Its copy and its disabled reasons are the contract.
describe("TimelineTranscribeBar", () => {
  it("is visible with nothing selected, and says so", () => {
    render(<TimelineTranscribeBar {...props} />)
    expect(screen.getByTestId("tl-transcribe-bar")).toBeInTheDocument()
    expect(screen.getByTestId("tl-transcribe-count")).toHaveTextContent("No section selected")
    expect(screen.getByTestId("tl-transcribe-selection")).toBeDisabled()
  })

  it("spells out the multi-select gesture rather than leaving it to be guessed", () => {
    render(<TimelineTranscribeBar {...props} />)
    expect(screen.getByText(/Ctrl\/⌘-click or Shift-click chips/)).toBeInTheDocument()
  })

  it("offers a single-section transcribe once one section is selected", async () => {
    const onTranscribe = vi.fn()
    render(
      <TimelineTranscribeBar {...props} selectedCount={1} eligibleCount={1} onTranscribe={onTranscribe} />,
    )
    expect(screen.getByTestId("tl-transcribe-count")).toHaveTextContent("1 section selected")
    const button = screen.getByTestId("tl-transcribe-selection")
    expect(button).toHaveTextContent("Transcribe section")
    expect(button).toBeEnabled()
    await userEvent.click(button)
    expect(onTranscribe).toHaveBeenCalledTimes(1)
  })

  it("counts the sections in the button label when several are selected", () => {
    render(<TimelineTranscribeBar {...props} selectedCount={3} eligibleCount={3} />)
    expect(screen.getByTestId("tl-transcribe-count")).toHaveTextContent("3 sections selected")
    expect(screen.getByTestId("tl-transcribe-selection")).toHaveTextContent("Transcribe 3 sections")
  })

  // The label counts what will ACTUALLY run: including a section with no
  // recording must not promise work that cannot happen.
  it("labels the ELIGIBLE count, not the selected count", () => {
    render(<TimelineTranscribeBar {...props} selectedCount={4} eligibleCount={2} />)
    expect(screen.getByTestId("tl-transcribe-count")).toHaveTextContent("4 sections selected")
    expect(screen.getByTestId("tl-transcribe-selection")).toHaveTextContent("Transcribe 2 sections")
  })

  it("disables with a why when the selection has no audio at all", async () => {
    renderWithTooltips(<TimelineTranscribeBar {...props} selectedCount={2} eligibleCount={0} />)
    expect(screen.getByTestId("tl-transcribe-selection")).toBeDisabled()
    await expectTooltip(
      screen.getByTestId("tl-transcribe-selection"),
      /None of the selected sections has audio to transcribe/i,
    )
  })

  it("disables while another audio batch owns the progress slot", async () => {
    renderWithTooltips(<TimelineTranscribeBar {...props} selectedCount={1} eligibleCount={1} busy />)
    expect(screen.getByTestId("tl-transcribe-selection")).toBeDisabled()
    await expectTooltip(screen.getByTestId("tl-transcribe-selection"), /Another audio batch is running/i)
  })

  it("explains what the run will and will not touch when it is ready", async () => {
    renderWithTooltips(<TimelineTranscribeBar {...props} selectedCount={1} eligibleCount={1} />)
    await expectTooltip(
      screen.getByTestId("tl-transcribe-selection"),
      /selected sections' audio only — the rest of the file is left alone/i,
    )
  })

  it("offers Clear only while something is selected", async () => {
    const onClear = vi.fn()
    const { rerender } = render(<TimelineTranscribeBar {...props} />)
    expect(screen.queryByTestId("tl-transcribe-clear")).not.toBeInTheDocument()
    rerender(<TimelineTranscribeBar {...props} selectedCount={2} eligibleCount={2} onClear={onClear} />)
    await userEvent.click(screen.getByTestId("tl-transcribe-clear"))
    expect(onClear).toHaveBeenCalledTimes(1)
  })
})

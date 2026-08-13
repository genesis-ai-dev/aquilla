import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import { CellTranscriptPreview } from "./CellTranscriptPreview"
import type { WordTiming } from "@/lib/codex-editor/types"

const timings: WordTiming[] = [
  { word: "teh", t0: 0, t1: 0.4, start: 0, end: 3 },
  { word: "house", t0: 0.4, t1: 0.9, start: 4, end: 9 },
]

describe("CellTranscriptPreview", () => {
  it("lets a contributor correct the heard words without re-transcribing", () => {
    const onCorrect = vi.fn()
    render(
      <I18nProvider>
        <CellTranscriptPreview
          timings={timings}
          cellText="the house"
          cellId="c1"
          alignedToCellText={false}
          editable
          onCorrectTranscript={onCorrect}
        />
      </I18nProvider>,
    )
    fireEvent.click(screen.getByRole("button", { name: "Correct the transcript" }))
    const area = screen.getByRole("textbox")
    fireEvent.change(area, { target: { value: "the house" } })
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }))
    expect(onCorrect).toHaveBeenCalledWith("the house")
  })

  it("locks correction for reviewers", () => {
    render(
      <I18nProvider>
        <CellTranscriptPreview
          timings={timings}
          cellText="the house"
          cellId="c1"
          alignedToCellText={false}
          editable={false}
          onCorrectTranscript={vi.fn()}
        />
      </I18nProvider>,
    )
    expect(screen.getByLabelText("Contributor+ required to edit transcripts")).toBeTruthy()
  })
})

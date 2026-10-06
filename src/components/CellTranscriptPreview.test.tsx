import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import { CellTranscriptPreview, classifyTranscriptPreview } from "./CellTranscriptPreview"
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

  it("offers the corrected wording for the cell instead of a fresh transcription", () => {
    const inserted = "des celles"
    const timings: WordTiming[] = [
      { word: "des", t0: 0, t1: 0.3, start: 0, end: 3 },
      { word: "cellules", t0: 0.3, t1: 0.9, start: 4, end: 12 },
    ]
    render(
      <I18nProvider>
        <CellTranscriptPreview
          timings={timings}
          cellText={inserted}
          cellId="c1"
          alignedToCellText
          editable
          onRetranscribe={vi.fn()}
          onUseAsCellText={vi.fn()}
        />
      </I18nProvider>,
    )
    expect(screen.queryByText("You changed the text after recording")).not.toBeInTheDocument()
    expect(screen.getByText("Your recording sounds a little different")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Use what was heard" })).toBeInTheDocument()
  })
})

describe("classifyTranscriptPreview", () => {
  const inserted = "first paragraph de section one, il y a des contenus qui seraient des celles."

  it("does not ask to retranscribe when a correction is longer than the text already in the cell", () => {
    // The heard text was inserted earlier. A later correction grew a word
    // and (older builds) reindexed offsets onto that longer string, so the
    // last offset runs past the cell even though the cell was not shortened.
    const corrected = inserted.replace(/celles\.$/, "cellules.")
    const words = corrected.split(/\s+/)
    let cursor = 0
    const timings: WordTiming[] = words.map((word, i) => {
      const start = cursor
      const end = start + word.length
      cursor = end + 1
      return { word, start, end, t0: i, t1: i + 1 }
    })
    expect(timings[timings.length - 1].end).toBeGreaterThan(inserted.length)
    expect(classifyTranscriptPreview(timings, inserted, true)).toBe("differs")
  })

  it("still asks to retranscribe when the cell itself lost the tail of the aligned text", () => {
    const timings: WordTiming[] = [
      { word: "hello", t0: 0, t1: 0.4, start: 0, end: 5 },
      { word: "world", t0: 0.4, t1: 0.9, start: 6, end: 11 },
    ]
    expect(classifyTranscriptPreview(timings, "hello worl", true)).toBe("stale")
  })
})

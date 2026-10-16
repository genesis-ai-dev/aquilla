import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { BibleSwapPanel } from "./BibleSwapPanel"
import type { BibleSwapCompatibilityReport } from "./compatibility"
import { DEFAULT_BIBLE_SWAP_SETTINGS } from "./settings"

const report: BibleSwapCompatibilityReport = {
  bibleFileName: "GEN-DEU.idml",
  booksFound: 1,
  booksExpected: 1,
  chaptersFound: 1,
  chaptersExpected: 1,
  versesMatched: 2,
  versesExpected: 2,
  hasPsalms: false,
  perBookMismatches: [],
}

describe("BibleSwapPanel compatibility loading", () => {
  it("shows the compatibility card with a spinner and percentage while analysis runs", async () => {
    let finish: (value: BibleSwapCompatibilityReport) => void = () => {}
    const onAnalyze = vi.fn(
      (_file: File, onProgress?: (progress: { stage: "loading"; percent: number; message: string }) => void) => {
        onProgress?.({ stage: "loading", percent: 12, message: "Reading" })
        return new Promise<BibleSwapCompatibilityReport>((resolve) => {
          finish = resolve
        })
      },
    )

    render(
      <BibleSwapPanel
        settings={{ ...DEFAULT_BIBLE_SWAP_SETTINGS, mode: "surgical" }}
        onChange={vi.fn()}
        onAnalyze={onAnalyze}
      />,
    )

    const input = document.querySelector('input[type="file"]')
    expect(input).toBeTruthy()
    fireEvent.change(input as HTMLInputElement, {
      target: { files: [new File(["idml"], "GEN-DEU.idml")] },
    })

    expect(await screen.findByText("Compatibility")).toBeInTheDocument()
    expect(screen.getByRole("status", { name: "Loading" })).toBeInTheDocument()
    expect(screen.getByText("Analyzing Bible file compatibility…")).toBeInTheDocument()
    expect(screen.getByText("12%")).toBeInTheDocument()
    expect(screen.queryByText("1 of 1 books")).not.toBeInTheDocument()

    finish(report)

    await waitFor(() => {
      expect(screen.getByText("1 of 1 books")).toBeInTheDocument()
    })
    expect(screen.queryByRole("status", { name: "Loading" })).not.toBeInTheDocument()
    expect(screen.queryByText("12%")).not.toBeInTheDocument()
  })
})

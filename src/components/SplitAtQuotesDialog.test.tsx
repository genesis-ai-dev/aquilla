/**
 * Tests for SplitAtQuotesDialog (AQU-1759 / AQU-2089).
 *
 * The preview is a reading surface: a piece's stored text keeps its USFM
 * markup so the split can write it back verbatim, but the dialog must show
 * the marker-free text the editor shows. These tests lock that seam — the
 * rendered preview carries no marker tokens, while the `pieces` the caller
 * passed (and hands to the split on confirm) stay byte-identical.
 */

import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { SplitAtQuotesDialog } from "./SplitAtQuotesDialog"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import type { QuoteSplitPiece } from "@/lib/cells/quote-split"

function renderDialog(pieces: QuoteSplitPiece[], onConfirm = vi.fn(), targetLaneCount = 1) {
  render(
    <I18nProvider>
      <SplitAtQuotesDialog
        pieces={pieces}
        hasRecordings={false}
        targetLaneCount={targetLaneCount}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />
    </I18nProvider>,
  )
  return { onConfirm }
}

function pieceTexts(): string[] {
  return screen.getAllByTestId("split-quotes-piece").map((li) => li.textContent ?? "")
}

describe("SplitAtQuotesDialog preview text (AQU-2089)", () => {
  it("shows no USFM marker tokens for pieces that carry them", () => {
    // Mark 1:3 shape — poetry breaks plus words-of-Jesus and a footnote.
    const pieces: QuoteSplitPiece[] = [
      { kind: "narration", text: "\\p A voice of one calling in the wilderness," },
      {
        kind: "quote",
        text: "\\q2 \\wj Prepare the way for the Lord\\wj*\\f + \\fr 1:3 \\ft Isaiah 40:3.\\f*",
      },
    ]
    renderDialog(pieces)

    for (const text of pieceTexts()) {
      expect(text).not.toContain("\\")
    }
    expect(pieceTexts().join(" ")).toContain("Prepare the way for the Lord")
    // The footnote body is a note, not preview text.
    expect(pieceTexts().join(" ")).not.toContain("Isaiah 40:3")
  })

  it("leaves a marker-free prose piece exactly as it is", () => {
    renderDialog([
      { kind: "narration", text: "And this was his message:" },
      { kind: "quote", text: "“After me comes the one more powerful than I.”" },
    ])
    expect(pieceTexts()[0]).toContain("And this was his message:")
    expect(pieceTexts()[1]).toContain("“After me comes the one more powerful than I.”")
  })

  it("does not alter the pieces handed to the split", () => {
    const raw = "\\q2 \\wj Prepare the way\\wj*"
    const pieces: QuoteSplitPiece[] = [
      { kind: "narration", text: "\\p A voice calling," },
      { kind: "quote", text: raw },
    ]
    const { onConfirm } = renderDialog(pieces)

    fireEvent.click(screen.getByTestId("split-quotes-confirm"))

    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(pieces[1].text).toBe(raw)
    expect(pieces[0].text).toBe("\\p A voice calling,")
  })

  it("warns about the other languages only when the project has two or more target lanes", () => {
    const pieces: QuoteSplitPiece[] = [
      { kind: "narration", text: "She said," },
      { kind: "quote", text: "Come here." },
    ]
    const { unmount } = render(
      <I18nProvider>
        <SplitAtQuotesDialog pieces={pieces} hasRecordings={false} targetLaneCount={1} onConfirm={vi.fn()} onCancel={vi.fn()} />
      </I18nProvider>,
    )
    expect(screen.queryByTestId("split-quotes-lane-warning")).toBeNull()
    unmount()
    renderDialog(pieces, vi.fn(), 2)
    const warning = screen.getByTestId("split-quotes-lane-warning")
    expect(warning).toHaveTextContent(/all lanes/i)
    expect(warning.textContent ?? "").not.toMatch(/\d/)
  })
})

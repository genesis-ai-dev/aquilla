import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { FootnoteInline } from "./FootnoteInline"
import { extractUsfmFootnotes } from "@/lib/footnotes/extract"

// AQU-598: bold/italic markers must render as formatting in the target preview
// (they used to leak through as literal \bd…\bd* text), and the note number
// badge must re-open the note for editing.

describe("FootnoteInline (AQU-598)", () => {
  it("renders bold/italic markers in the target footnote preview instead of raw USFM", () => {
    const targetFootnotes = extractUsfmFootnotes(
      "\\f + \\ft See \\bd Genesis\\bd* and \\it Exodus\\it*\\f*",
    )
    expect(targetFootnotes).toHaveLength(1)

    const { container } = render(
      <FootnoteInline
        sourceFootnotes={[]}
        targetFootnotes={targetFootnotes}
        editable
        isDocx={false}
        onSave={() => undefined}
      />,
    )

    // The raw character markers must not leak into the rendered preview.
    expect(container.textContent).not.toContain("\\bd")
    expect(container.textContent).not.toContain("\\it")

    // The formatted words render inside styled spans.
    const bold = screen.getByText("Genesis")
    expect(bold).toHaveClass("font-semibold")
    const italic = screen.getByText("Exodus")
    expect(italic).toHaveClass("italic")
  })

  it("re-opens a note for editing when its number badge is clicked", () => {
    const targetFootnotes = extractUsfmFootnotes("\\f + \\ft A note\\f*")

    render(
      <FootnoteInline
        sourceFootnotes={[]}
        targetFootnotes={targetFootnotes}
        editable
        isDocx={false}
        onSave={() => undefined}
      />,
    )

    // No editor open initially.
    expect(screen.queryByRole("textbox", { name: "Edit footnote" })).toBeNull()

    // Clicking the number badge opens the inline editor for that note.
    fireEvent.click(screen.getByRole("button", { name: /^Edit footnote /i }))
    expect(screen.getByRole("textbox", { name: "Edit footnote" })).toBeInTheDocument()
  })

  it("does not expose an editable number badge when the cell is read-only", () => {
    const targetFootnotes = extractUsfmFootnotes("\\f + \\ft A note\\f*")

    render(
      <FootnoteInline
        sourceFootnotes={[]}
        targetFootnotes={targetFootnotes}
        editable={false}
        isDocx={false}
        onSave={vi.fn()}
      />,
    )

    expect(screen.queryByRole("button", { name: /^Edit footnote /i })).toBeNull()
  })
})

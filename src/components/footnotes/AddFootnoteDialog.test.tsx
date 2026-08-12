// Scripture references are data, not prose — WHY: everywhere else in the editor
// a ref ('MAT 3:16') is monospaced and pulled to the foreground so a translator
// can tell at a glance which verse a control is acting on. Keying "Attached to
// {ref}." as one catalog string interpolated the ref as bare text, so the
// dialog's own help line stopped marking it while the rest of the UI kept doing so.
import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { AddFootnoteDialog } from "./AddFootnoteDialog"

describe("AddFootnoteDialog help line", () => {
  it("monospaces the scripture reference inside the translated sentence", () => {
    render(
      <AddFootnoteDialog
        open
        defaults={{ ref: "MAT 3:16" }}
        onOpenChange={vi.fn()}
        onAdd={vi.fn()}
      />,
    )

    // Assert the element and its classes: "Attached to MAT 3:16." reads the same
    // with or without the markup, so text alone cannot catch the flattening.
    const ref = screen.getByText("MAT 3:16")
    expect(ref.tagName).toBe("SPAN")
    expect(ref).toHaveClass("font-mono")
    expect(ref).toHaveClass("text-foreground")
    // The sentence around it is still one translated string, so word order stays
    // the translator's to decide.
    expect(ref.parentElement?.textContent).toContain("Attached to MAT 3:16.")
  })
})

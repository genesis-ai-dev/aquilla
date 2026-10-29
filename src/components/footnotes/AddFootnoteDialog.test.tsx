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

// The dialog body must live in the shared DialogBody scroll region — WHY: the
// dialog shell caps itself at 85dvh and clips overflow with the footer pinned
// (`shrink-0`), so a body placed directly in the popup pushes Cancel / Add
// footnote past the clipped edge as soon as the viewport is short (125% browser
// zoom on a laptop did it — AQU-2284). happy-dom lays nothing out, so this pins
// the structure that makes the CSS work instead of measuring pixels.
describe("AddFootnoteDialog layout (AQU-2284)", () => {
  it("scrolls the body inside DialogBody and keeps the footer outside it", () => {
    render(
      <AddFootnoteDialog
        open
        defaults={{
          ref: "1PE 1:6",
          anchorText: "épreuves",
          insertionPreview: { before: "Alors réjouissez-vous", after: " de cela" },
        }}
        onOpenChange={vi.fn()}
        onAdd={vi.fn()}
      />,
    )

    const body = document.querySelector('[data-slot="dialog-body"]')
    expect(body).not.toBeNull()
    // The scroll contract: a flex child that may shrink below its content and scrolls.
    expect(body).toHaveClass("overflow-y-auto")
    expect(body).toHaveClass("min-h-0")

    // Everything that can make the dialog tall sits inside the scroll region…
    expect(body).toContainElement(screen.getByRole("group", { name: "Footnote marker style" }))
    expect(body).toContainElement(screen.getByRole("textbox", { name: "Footnote text" }))
    expect(body).toContainElement(screen.getByText("Target preview"))

    // …and the actions do not, so they stay visible however short the viewport is.
    const add = screen.getByRole("button", { name: "Add footnote" })
    expect(body).not.toContainElement(add)
    expect(add.closest('[data-slot="dialog-footer"]')).not.toBeNull()
  })
})

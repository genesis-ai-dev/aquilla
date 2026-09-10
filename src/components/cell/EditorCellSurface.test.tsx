import { describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"
import { EditorTargetReadSurface } from "./EditorCellSurface"

/**
 * AQU-1077 regression guard.
 *
 * The read surface stands in for TranslatedEditor until a cell is clicked into,
 * so the two must paint the same text. TipTap hydrates the stored value through
 * an HTML parse, which collapses runs of spaces and tabs; the read surface used
 * `white-space: pre-wrap`, which does not. DOCX tab-leader gaps therefore showed
 * as ragged pseudo-columns in display and reflowed to prose on focus.
 *
 * Tailwind classes are the whole fix here — there is no computed layout in
 * happy-dom to assert against — so the class is what the guard pins.
 */
describe("EditorTargetReadSurface whitespace", () => {
  it("collapses horizontal whitespace runs like the editor's HTML parse", () => {
    // The shape that broke: a TOC line whose page number sits behind a Word tab
    // leader carried through the DOCX import.
    render(<EditorTargetReadSurface>{"1.1 Waaqayyo akkamitti of mul'isa\t8"}</EditorTargetReadSurface>)

    const surface = screen.getByRole("textbox")
    expect(surface).toHaveClass("whitespace-pre-line")
    expect(surface).not.toHaveClass("whitespace-pre-wrap")
  })

  it("keeps whitespace exact for IDML, whose editor hydrates with preserveWhitespace", () => {
    render(<EditorTargetReadSurface preserveWhitespace>slot text</EditorTargetReadSurface>)

    const surface = screen.getByRole("textbox")
    expect(surface).toHaveClass("whitespace-pre-wrap")
    expect(surface).not.toHaveClass("whitespace-pre-line")
  })
})

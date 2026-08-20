// AQU-913 regression guard: a cell's AI error messages are dismissed when focus
// leaves the cell's row, but survive while the user is still inside the row —
// including inside the error's own portaled info popover.
import { describe, it, expect, afterEach } from "vitest"
import { shouldDismissCellErrorsOnBlur } from "./cell-error-dismiss"

function makeRow(): HTMLElement {
  const row = document.createElement("div")
  const editor = document.createElement("div")
  editor.id = "editor"
  row.appendChild(editor)
  document.body.appendChild(row)
  return row
}

/** The error's info popover renders through a portal at the document root, so
 *  its DOM is a sibling of the row — not a descendant. */
function makePortaledPopover(): HTMLElement {
  const popup = document.createElement("div")
  popup.setAttribute("data-slot", "popover-content")
  const copyButton = document.createElement("button")
  popup.appendChild(copyButton)
  document.body.appendChild(popup)
  return popup
}

afterEach(() => {
  document.body.innerHTML = ""
})

describe("shouldDismissCellErrorsOnBlur", () => {
  it("dismisses when focus moves to another cell's row", () => {
    const row = makeRow()
    const otherRow = makeRow()
    expect(shouldDismissCellErrorsOnBlur(row, otherRow)).toBe(true)
  })

  it("dismisses when focus goes nowhere focusable (a click on dead space)", () => {
    expect(shouldDismissCellErrorsOnBlur(makeRow(), null)).toBe(true)
  })

  it("keeps the error while focus stays inside the row", () => {
    const row = makeRow()
    expect(shouldDismissCellErrorsOnBlur(row, row.querySelector("#editor"))).toBe(false)
  })

  it("keeps the error when focus moves into the row element itself", () => {
    const row = makeRow()
    expect(shouldDismissCellErrorsOnBlur(row, row)).toBe(false)
  })

  it("keeps the error when the info popover opens (portaled, so outside the row)", () => {
    const row = makeRow()
    expect(shouldDismissCellErrorsOnBlur(row, makePortaledPopover())).toBe(false)
  })

  it("keeps the error when focus lands on a control inside that popover", () => {
    const row = makeRow()
    const copyButton = makePortaledPopover().querySelector("button")
    expect(shouldDismissCellErrorsOnBlur(row, copyButton)).toBe(false)
  })

  it("does nothing once the row has unmounted", () => {
    expect(shouldDismissCellErrorsOnBlur(null, null)).toBe(false)
  })

  it("handles a text node relatedTarget without throwing", () => {
    const row = makeRow()
    const inRow = document.createTextNode("x")
    row.appendChild(inRow)
    expect(shouldDismissCellErrorsOnBlur(row, inRow)).toBe(false)

    const outside = document.createTextNode("y")
    document.body.appendChild(outside)
    expect(shouldDismissCellErrorsOnBlur(row, outside)).toBe(true)
  })
})

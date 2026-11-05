// AQU-1778: the smart-edit card is rendered INSIDE TranslatedEditor, and
// EditorTable mounts that editor only while the cell is active — the editor's
// blur deactivates the cell (`onDeactivateEditor`). So anything that pulls DOM
// focus out of the ProseMirror surface unmounts the card, and the underlines
// with it, in the same frame: the translator saw the caret land on the marked
// word, the markers vanish, and no suggestion opens.
//
// Guard: opening the card must not move focus, and pressing its buttons must
// not blur the editor before their click handler runs.

import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import { SmartEditPopover } from "./SmartEditPopover"
import type { SmartEditSuggestion } from "@/lib/smart-edits/client"

const suggestion: SmartEditSuggestion = {
  fileId: "JHN",
  cellId: "JHN 6:27",
  start: 0,
  end: 4,
  old: "seal",
  new: "mark",
  oldNorm: "seal",
  newNorm: "mark",
  tier: "memory",
  confidence: 0.9,
  support: { strong: 2, weak: 0, keeps: 0 },
  examples: [],
}

/** Stands in for the ProseMirror surface: focused, and blurring it is what
 *  tears the cell — and therefore this card — down. */
function mountWithFocusedEditor() {
  const editor = document.createElement("div")
  editor.tabIndex = 0
  editor.className = "ProseMirror"
  document.body.appendChild(editor)
  const anchor = document.createElement("span")
  document.body.appendChild(anchor)
  editor.focus()
  const onAccept = vi.fn()
  const onDismiss = vi.fn()
  render(
    <I18nProvider>
      <SmartEditPopover
        suggestion={suggestion}
        anchor={anchor}
        onAccept={onAccept}
        onDismiss={onDismiss}
        onClose={() => {}}
      />
    </I18nProvider>,
  )
  return { editor, onAccept, onDismiss }
}

describe("SmartEditPopover — keeps focus in the editor (AQU-1778)", () => {
  it("does not move focus into the card when it opens", async () => {
    const { editor } = mountWithFocusedEditor()
    await screen.findByTestId("smart-edit-popover")
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(document.activeElement).toBe(editor)
    expect(editor.getAttribute("aria-hidden")).toBeNull()
  })

  it("accepts without blurring the editor", async () => {
    const { editor, onAccept } = mountWithFocusedEditor()
    await screen.findByTestId("smart-edit-popover")
    await userEvent.click(screen.getByRole("button", { name: "Accept" }))
    expect(onAccept).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(editor)
  })

  it("dismisses without blurring the editor", async () => {
    const { editor, onDismiss } = mountWithFocusedEditor()
    await screen.findByTestId("smart-edit-popover")
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }))
    expect(onDismiss).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(editor)
  })
})

/**
 * AQU-271 — ConfirmActionDialog: truthful delete copy + variant.
 *
 * When the dialog is opened for file deletion it should:
 *   1. Show the truthful "permanently deletes" copy (not the old "not deleted from disk" lie).
 *   2. Show the "permanently deletes all cells and audio" checkbox label.
 *   3. Use variant="destructive" — confirm button gets the destructive class.
 *   4. Confirm button disabled until checkbox is checked.
 */

import { render, screen, fireEvent } from "@testing-library/react"
import { describe, it, expect, vi } from "vitest"
import { ConfirmActionDialog } from "./ConfirmActionDialog"

const FILE_NAME = "GEN"
const DESCRIPTION = `Delete "${FILE_NAME}"? This permanently deletes the file's cells and all recorded audio for it. This cannot be undone.`
const CHECKBOX_LABEL = "I understand this permanently deletes all cells and audio for this file."

describe("ConfirmActionDialog — AQU-271 file-delete copy", () => {
  function renderDialog(overrides: Partial<Parameters<typeof ConfirmActionDialog>[0]> = {}) {
    const onConfirm = vi.fn()
    const onOpenChange = vi.fn()
    render(
      <ConfirmActionDialog
        open={true}
        onOpenChange={onOpenChange}
        title="Delete file"
        description={DESCRIPTION}
        confirmLabel="Delete"
        checkboxLabel={CHECKBOX_LABEL}
        variant="destructive"
        onConfirm={onConfirm}
        {...overrides}
      />,
    )
    return { onConfirm, onOpenChange }
  }

  it("shows the truthful 'permanently deletes' description", () => {
    renderDialog()
    expect(screen.getByText(/permanently deletes the file's cells/i)).toBeTruthy()
  })

  it("does NOT show the old 'not deleted from disk' text", () => {
    renderDialog()
    expect(screen.queryByText(/not deleted from disk/i)).toBeNull()
  })

  it("shows the truthful checkbox label", () => {
    renderDialog()
    expect(screen.getByText(/permanently deletes all cells and audio/i)).toBeTruthy()
  })

  it("confirm button is disabled until checkbox is checked", () => {
    renderDialog()
    const confirmBtn = screen.getByRole("button", { name: /delete/i })
    expect(confirmBtn).toBeDisabled()

    const checkbox = screen.getByRole("checkbox")
    expect(checkbox).toHaveAttribute("aria-checked", "false")
    // Click the label text: happy-dom re-dispatches label-wrapped clicks back
    // onto the control, so clicking the checkbox itself double-toggles there
    // (browsers don't). Clicking the label is the same user intent.
    fireEvent.click(screen.getByText(CHECKBOX_LABEL))
    expect(checkbox).toHaveAttribute("aria-checked", "true")
    expect(confirmBtn).not.toBeDisabled()
  })

  it("calls onConfirm after checkbox is checked and confirm button is clicked", () => {
    const { onConfirm } = renderDialog()
    fireEvent.click(screen.getByText(CHECKBOX_LABEL))
    fireEvent.click(screen.getByRole("button", { name: /delete/i }))
    expect(onConfirm).toHaveBeenCalledOnce()
  })
})

// A dead-end confirmation (batch validate with nothing this reader can
// validate): the body already says so, so there is nothing to acknowledge and
// no confirm that would only fail. Walk 10-02, w1 area 6.
describe("ConfirmActionDialog — an action that can do nothing here", () => {
  it("offers only Close: no acknowledgement and no confirm button", () => {
    const onConfirm = vi.fn()
    const onOpenChange = vi.fn()
    render(
      <ConfirmActionDialog
        open={true}
        onOpenChange={onOpenChange}
        title="Batch validate text"
        description="Only the people this project names can validate text."
        confirmLabel="Validate text"
        checkboxLabel="I understand this records my name."
        canConfirm={false}
        onConfirm={onConfirm}
      />,
    )
    expect(screen.getByText("Only the people this project names can validate text.")).toBeTruthy()
    expect(screen.queryByRole("checkbox")).toBeNull()
    expect(screen.queryByRole("button", { name: "Validate text" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull()
    // The dialog's corner X is also named "Close"; the footer one has the text.
    fireEvent.click(screen.getAllByRole("button", { name: "Close" }).find((b) => b.textContent === "Close")!)
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onConfirm).not.toHaveBeenCalled()
  })
})

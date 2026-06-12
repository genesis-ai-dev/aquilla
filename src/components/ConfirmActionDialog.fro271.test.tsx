/**
 * FRO-271 — ConfirmActionDialog: truthful delete copy + variant.
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

describe("ConfirmActionDialog — FRO-271 file-delete copy", () => {
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

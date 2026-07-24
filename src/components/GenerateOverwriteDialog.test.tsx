/**
 * Tests for GenerateOverwriteDialog (AQU-278).
 *
 * Covers:
 *   - Dialog renders with standard copy for non-validated cells
 *   - Dialog renders with escalated (validated) copy when isValidated=true
 *   - Confirm calls onConfirm and NOT onCancel
 *   - Cancel calls onCancel and NOT onConfirm
 *   - Dialog is not rendered when open=false
 *
 * Cancel semantics: clicking Cancel means no completion is triggered —
 * the cell remains exactly as-is. We never start-then-discard because an
 * in-progress stream would occupy the cell's "generating" state and confuse
 * the UX on cancel.
 */

import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { GenerateOverwriteDialog } from "./GenerateOverwriteDialog"

function renderDialog(props: Partial<Parameters<typeof GenerateOverwriteDialog>[0]> = {}) {
  const defaults = {
    open: true,
    isValidated: false,
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
  }
  return render(<GenerateOverwriteDialog {...defaults} {...props} />)
}

describe("GenerateOverwriteDialog", () => {
  // ── Not rendered when closed ──────────────────────────────────────────────

  it("does not render when open=false", () => {
    renderDialog({ open: false })
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  // ── Standard (non-validated) copy ─────────────────────────────────────────

  it("shows standard replace copy for non-validated cells", () => {
    renderDialog({ isValidated: false })
    expect(screen.getByText(/replace existing translation\?/i)).toBeInTheDocument()
    expect(screen.getByText(/current text is preserved in cell history/i)).toBeInTheDocument()
    // Should NOT mention validation clearing
    expect(screen.queryByText(/clears the validation/i)).not.toBeInTheDocument()
  })

  // ── Escalated (validated) copy ────────────────────────────────────────────

  it("shows escalated copy for validated cells mentioning validation clearing", () => {
    renderDialog({ isValidated: true })
    expect(screen.getByText(/replace validated translation\?/i)).toBeInTheDocument()
    expect(screen.getByText(/clears the validation/i)).toBeInTheDocument()
    expect(screen.getByText(/current text is preserved in cell history/i)).toBeInTheDocument()
  })

  // ── Confirm path ──────────────────────────────────────────────────────────

  it("calls onConfirm(false) when Replace is clicked without opting out, and does not call onCancel", () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    renderDialog({ onConfirm, onCancel })

    fireEvent.click(screen.getByRole("button", { name: /replace/i }))

    expect(onConfirm).toHaveBeenCalledOnce()
    expect(onConfirm).toHaveBeenCalledWith(false)
    expect(onCancel).not.toHaveBeenCalled()
  })

  // ── "Don't ask again" opt-out (AQU-591) ───────────────────────────────────

  it("offers a 'Don't ask again' opt-out for non-validated cells and passes it to onConfirm", () => {
    const onConfirm = vi.fn()
    renderDialog({ isValidated: false, onConfirm })

    // Base UI checkbox toggles when its wrapping <label> is clicked.
    const optOut = screen.getByRole("checkbox", { name: /don't ask again/i })
    fireEvent.click(optOut.closest("label")!)
    fireEvent.click(screen.getByRole("button", { name: /replace/i }))

    expect(onConfirm).toHaveBeenCalledWith(true)
  })

  it("does NOT offer the opt-out for validated cells (always confirm)", () => {
    renderDialog({ isValidated: true })
    expect(screen.queryByRole("checkbox", { name: /don't ask again/i })).not.toBeInTheDocument()
  })

  // ── Cancel path ───────────────────────────────────────────────────────────

  it("calls onCancel when Cancel is clicked and does not call onConfirm", () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    renderDialog({ onConfirm, onCancel })

    fireEvent.click(screen.getByRole("button", { name: /cancel/i }))

    expect(onCancel).toHaveBeenCalledOnce()
    expect(onConfirm).not.toHaveBeenCalled()
  })
})

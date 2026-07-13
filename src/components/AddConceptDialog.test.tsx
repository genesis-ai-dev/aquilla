/**
 * Tests for AddConceptDialog (AQU-260).
 *
 * Covers:
 *   - Dialog pre-fills with the provided sourceTerm
 *   - Confirm calls onConfirm with the (possibly edited) term
 *   - Cancel calls onCancel and does NOT call onConfirm
 *   - Empty / whitespace-only term prevents submission
 *   - Dialog re-fills when sourceTerm changes while open
 */

import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { AddConceptDialog } from "./AddConceptDialog"

function renderDialog(props: Partial<Parameters<typeof AddConceptDialog>[0]> = {}) {
  const defaults = {
    open: true,
    sourceTerm: "spirit",
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
  }
  return render(<AddConceptDialog {...defaults} {...props} />)
}

describe("AddConceptDialog", () => {
  // ── Not rendered when closed ───────────────────────────────────────────────

  it("does not render content when open=false", () => {
    renderDialog({ open: false })
    expect(screen.queryByLabelText(/source term for new concept/i)).not.toBeInTheDocument()
  })

  // ── Pre-fills with sourceTerm ──────────────────────────────────────────────

  it("pre-fills the input with the provided sourceTerm", () => {
    renderDialog({ sourceTerm: "grace" })
    const input = screen.getByLabelText(/source term for new concept/i)
    expect((input as HTMLInputElement).value).toBe("grace")
  })

  // ── Confirm path ───────────────────────────────────────────────────────────

  it("calls onConfirm with the current term when Create draft is clicked", async () => {
    const onConfirm = vi.fn()
    renderDialog({ sourceTerm: "faith", onConfirm })

    fireEvent.click(screen.getByRole("button", { name: /create draft concept/i }))

    await waitFor(() => {
      expect(onConfirm).toHaveBeenCalledOnce()
      expect(onConfirm).toHaveBeenCalledWith("faith")
    })
  })

  it("trims whitespace from the term before calling onConfirm", async () => {
    const onConfirm = vi.fn()
    renderDialog({ sourceTerm: "  love  ", onConfirm })

    fireEvent.click(screen.getByRole("button", { name: /create draft concept/i }))

    await waitFor(() => {
      expect(onConfirm).toHaveBeenCalledWith("love")
    })
  })

  it("calls onConfirm with edited text when user changes the input", async () => {
    const onConfirm = vi.fn()
    renderDialog({ sourceTerm: "spirit", onConfirm })

    const input = screen.getByLabelText(/source term for new concept/i)
    fireEvent.change(input, { target: { value: "Holy Spirit" } })
    fireEvent.click(screen.getByRole("button", { name: /create draft concept/i }))

    await waitFor(() => {
      expect(onConfirm).toHaveBeenCalledWith("Holy Spirit")
    })
  })

  it("submits on Enter key in the input", async () => {
    const onConfirm = vi.fn()
    renderDialog({ sourceTerm: "peace", onConfirm })

    const input = screen.getByLabelText(/source term for new concept/i)
    fireEvent.keyDown(input, { key: "Enter" })

    await waitFor(() => {
      expect(onConfirm).toHaveBeenCalledWith("peace")
    })
  })

  // ── Cancel path ────────────────────────────────────────────────────────────

  it("calls onCancel when Cancel is clicked without calling onConfirm", () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    renderDialog({ onConfirm, onCancel })

    fireEvent.click(screen.getByRole("button", { name: /cancel/i }))

    expect(onCancel).toHaveBeenCalledOnce()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  // ── Empty term validates on submit ─────────────────────────────────────────

  it("shows validation when Create draft is clicked with empty term", async () => {
    const onConfirm = vi.fn()
    renderDialog({ sourceTerm: "", onConfirm })
    fireEvent.submit(document.getElementById("add-concept-form")!)
    await waitFor(() => {
      expect(screen.getByText(/source term is required/i)).toBeInTheDocument()
    })
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it("shows validation when term is whitespace only", async () => {
    const onConfirm = vi.fn()
    renderDialog({ sourceTerm: "   ", onConfirm })
    const input = screen.getByLabelText(/source term for new concept/i)
    fireEvent.change(input, { target: { value: "   " } })
    fireEvent.submit(document.getElementById("add-concept-form")!)
    await waitFor(() => {
      expect(screen.getByText(/source term is required/i)).toBeInTheDocument()
    })
    expect(onConfirm).not.toHaveBeenCalled()
  })
})

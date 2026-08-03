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

  // ── AQU-754: failed saves surface, dialog stays open (no silent no-op) ───────

  it("surfaces the error and keeps the input mounted when onConfirm rejects", async () => {
    // Mirrors the editor path: onConfirm persists via patchSettings and throws
    // when the write is rejected (e.g. below Maintainer). The dialog must show
    // why and stay open, not close as if the concept was saved.
    const onConfirm = vi.fn().mockRejectedValue(
      new Error("You need the Maintainer role or higher to change the term base."),
    )
    const onCancel = vi.fn()
    renderDialog({ sourceTerm: "grace", onConfirm, onCancel })

    fireEvent.click(screen.getByRole("button", { name: /create draft concept/i }))

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/maintainer role or higher/i)
    })
    // Dialog is still interactive (input present) and did not auto-cancel.
    expect(screen.getByLabelText(/source term for new concept/i)).toBeInTheDocument()
    expect(onCancel).not.toHaveBeenCalled()
  })

  it("re-enables the Create draft button after a rejected save (no stuck Saving…)", async () => {
    // Regression: the button label read form.state.isSubmitting directly in
    // render, which is not reactive — after a rejected save it stayed stuck on
    // "Saving…" forever. It must return to an enabled "Create draft".
    const onConfirm = vi.fn().mockRejectedValue(new Error("nope"))
    renderDialog({ sourceTerm: "grace", onConfirm })

    const submitBtn = screen.getByRole("button", { name: /create draft concept/i })
    fireEvent.click(submitBtn)

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument())
    await waitFor(() => {
      expect(submitBtn).toHaveTextContent("Create draft")
      expect(submitBtn).toBeEnabled()
    })
  })

  // ── Blocked below the termbase write floor ─────────────────────────────────

  it("disables the input and Create draft and shows the reason when blockedReason is set", async () => {
    const onConfirm = vi.fn()
    renderDialog({
      onConfirm,
      blockedReason: "You need the Maintainer role or higher to change the term base.",
    })

    expect(screen.getByRole("alert")).toHaveTextContent(/maintainer role or higher/i)
    expect(screen.getByLabelText(/source term for new concept/i)).toBeDisabled()
    expect(screen.getByRole("button", { name: /create draft concept/i })).toBeDisabled()

    // Even a programmatic form submit must not reach onConfirm. Flush the
    // async handleSubmit before asserting the negative.
    fireEvent.submit(document.getElementById("add-concept-form")!)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it("keeps Cancel active while blocked so the user can close the dialog", () => {
    const onCancel = vi.fn()
    renderDialog({
      onCancel,
      blockedReason: "You need the Maintainer role or higher to change the term base.",
    })

    const cancelBtn = screen.getByRole("button", { name: /cancel/i })
    expect(cancelBtn).toBeEnabled()
    fireEvent.click(cancelBtn)
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it("clears a prior error when the user re-submits successfully", async () => {
    const onConfirm = vi
      .fn()
      .mockRejectedValueOnce(new Error("You're offline — reconnect to save term base changes."))
      .mockResolvedValueOnce(undefined)
    renderDialog({ sourceTerm: "peace", onConfirm })

    fireEvent.click(screen.getByRole("button", { name: /create draft concept/i }))
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument())

    fireEvent.click(screen.getByRole("button", { name: /create draft concept/i }))
    await waitFor(() => {
      expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    })
    expect(onConfirm).toHaveBeenCalledTimes(2)
  })
})

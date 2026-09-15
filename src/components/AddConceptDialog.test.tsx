/**
 * Tests for AddConceptPopover (AQU-260 / AQU-1006).
 *
 * The control is a popover on the source-selection toolbar — not a modal.
 * Persistence (loading / success / error) is toasted by the caller; this
 * surface closes as soon as submit is accepted.
 */

import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { AddConceptPopover } from "./AddConceptDialog"

function renderPopover(props: Partial<Parameters<typeof AddConceptPopover>[0]> = {}) {
  const defaults = {
    sourceTerm: "spirit",
    onConfirm: vi.fn(),
    children: <button type="button">Add to terminology</button>,
  }
  return render(<AddConceptPopover {...defaults} {...props} />)
}

async function openPopover() {
  fireEvent.click(screen.getByRole("button", { name: /add to terminology/i }))
  return screen.findByLabelText(/source term for new concept/i)
}

describe("AddConceptPopover", () => {
  it("does not render the form until opened", () => {
    renderPopover()
    expect(screen.queryByLabelText(/source term for new concept/i)).not.toBeInTheDocument()
  })

  it("pre-fills the source term from the selection", async () => {
    renderPopover({ sourceTerm: "grace" })
    const input = await openPopover()
    expect((input as HTMLInputElement).value).toBe("grace")
  })

  it("keeps the prefilled term if the live selection clears while the popover is open", async () => {
    // Opening the popover focuses the source-term input, which collapses the
    // browser selection. The parent then passes sourceTerm="" — the field
    // must keep the term captured at open, not empty out.
    const onConfirm = vi.fn()
    const trigger = <button type="button">Add to terminology</button>
    const { rerender } = render(
      <AddConceptPopover sourceTerm="Holy Spirit" onConfirm={onConfirm}>
        {trigger}
      </AddConceptPopover>,
    )
    const input = await openPopover()
    expect((input as HTMLInputElement).value).toBe("Holy Spirit")

    rerender(
      <AddConceptPopover sourceTerm="" onConfirm={onConfirm}>
        {trigger}
      </AddConceptPopover>,
    )
    expect((screen.getByLabelText(/source term for new concept/i) as HTMLInputElement).value).toBe(
      "Holy Spirit",
    )
  })

  it("calls onConfirm with the source term and closes", async () => {
    const onConfirm = vi.fn()
    renderPopover({ sourceTerm: "faith", onConfirm })
    await openPopover()

    fireEvent.click(screen.getByRole("button", { name: /add term/i }))

    await waitFor(() => {
      expect(onConfirm).toHaveBeenCalledOnce()
      expect(onConfirm).toHaveBeenCalledWith({ sourceTerm: "faith", approve: false })
    })
    expect(screen.queryByLabelText(/source term for new concept/i)).not.toBeInTheDocument()
  })

  it("trims whitespace from the term before calling onConfirm", async () => {
    const onConfirm = vi.fn()
    renderPopover({ sourceTerm: "  love  ", onConfirm })
    await openPopover()
    fireEvent.click(screen.getByRole("button", { name: /add term/i }))
    await waitFor(() => {
      expect(onConfirm).toHaveBeenCalledWith({ sourceTerm: "love", approve: false })
    })
  })

  it("calls onConfirm with edited text when the user changes the input", async () => {
    const onConfirm = vi.fn()
    renderPopover({ sourceTerm: "spirit", onConfirm })
    const input = await openPopover()
    fireEvent.change(input, { target: { value: "Holy Spirit" } })
    fireEvent.click(screen.getByRole("button", { name: /add term/i }))
    await waitFor(() => {
      expect(onConfirm).toHaveBeenCalledWith({ sourceTerm: "Holy Spirit", approve: false })
    })
  })

  it("includes an optional rendering and a caseSensitive flag", async () => {
    const onConfirm = vi.fn()
    const user = userEvent.setup()
    renderPopover({ sourceTerm: "grace", onConfirm })
    await openPopover()
    await user.type(screen.getByLabelText(/rendering for new concept/i), "favor")
    // AQU-1271: case sensitivity now lives inside the collapsed "Matching
    // options" disclosure with the other matcher toggles, stated positively
    // ("Match case exactly") rather than as a standalone inverted checkbox.
    await user.click(screen.getByRole("button", { name: /matching options/i }))
    await user.click(screen.getByRole("checkbox", { name: /match case exactly/i }))
    await user.click(screen.getByRole("button", { name: /add term/i }))
    await waitFor(() => {
      expect(onConfirm).toHaveBeenCalledWith({
        sourceTerm: "grace",
        rendering: "favor",
        caseSensitive: true,
        approve: false,
      })
    })
  })

  // ── AQU-1006 follow-up: suggest vs. approve ──────────────────────────────
  // Terminology has two authority levels. A DRAFT compiles to no rules, so it
  // binds nobody and any contributor may write one; APPROVING puts the term
  // into force and takes the org's termbase floor. These pin that the client
  // never asks for more than the user actually has.

  it("defaults to suggesting, so a caller that omits canApprove cannot enforce", async () => {
    // `canApprove` defaults to the RESTRICTIVE answer on purpose: a caller
    // that forgets to pass it produces suggestions rather than silently
    // writing enforced terminology on behalf of someone with no authority.
    const onConfirm = vi.fn()
    renderPopover({ sourceTerm: "mercy", onConfirm })
    await openPopover()
    await userEvent.setup().click(screen.getByRole("button", { name: /add term/i }))
    await waitFor(() => {
      expect(onConfirm).toHaveBeenCalledWith({ sourceTerm: "mercy", approve: false })
    })
  })

  it("approves when the user may approve and leaves the toggle on", async () => {
    const onConfirm = vi.fn()
    renderPopover({ sourceTerm: "mercy", onConfirm, canApprove: true })
    await openPopover()
    await userEvent.setup().click(screen.getByRole("button", { name: /add term/i }))
    await waitFor(() => {
      expect(onConfirm).toHaveBeenCalledWith({ sourceTerm: "mercy", approve: true })
    })
  })

  it("lets an approver choose to suggest instead", async () => {
    const onConfirm = vi.fn()
    const user = userEvent.setup()
    renderPopover({ sourceTerm: "mercy", onConfirm, canApprove: true })
    await openPopover()
    await user.click(screen.getByRole("checkbox", { name: /approve now/i }))
    await user.click(screen.getByRole("button", { name: /add term/i }))
    await waitFor(() => {
      expect(onConfirm).toHaveBeenCalledWith({ sourceTerm: "mercy", approve: false })
    })
  })

  it("disables the approve toggle for a user who cannot approve", async () => {
    renderPopover({ sourceTerm: "mercy", canApprove: false })
    await openPopover()
    // The base-ui Checkbox renders a span with aria-disabled rather than a
    // native `disabled` attribute, so toBeDisabled() does not apply.
    expect(screen.getByRole("checkbox", { name: /approve now/i }))
      .toHaveAttribute("aria-disabled", "true")
    expect(screen.getByText(/approving terms needs a higher role/i)).toBeInTheDocument()
  })

  it("submits on Enter in the rendering field", async () => {
    const onConfirm = vi.fn()
    renderPopover({ sourceTerm: "peace", onConfirm })
    await openPopover()
    fireEvent.keyDown(screen.getByLabelText(/rendering for new concept/i), { key: "Enter" })
    await waitFor(() => {
      expect(onConfirm).toHaveBeenCalledWith({ sourceTerm: "peace", approve: false })
    })
  })

  // WHY: the preview count and chips are how a user learns what the matcher
  // will do BEFORE saving; an option toggle must re-count live, and a chip
  // click must land in the submitted draft as an exclusion.
  it("previews matches, toggles options live, and submits exclusions", async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    const cells = [
      { id: "a", original: "וְהָאָ֗רֶץ הָיְתָה" },
      { id: "b", original: "אֵת הָאָֽרֶץ׃" },
      { id: "c", original: "nothing here" },
    ]
    renderPopover({
      sourceTerm: "הָאָ֗רֶץ",
      cells,
      termMatching: { prefixes: ["ו"], suffixes: [] },
      canApprove: true,
      onConfirm,
    })
    await openPopover()
    expect(await screen.findByText(/Matches 2 places/)).toBeTruthy()
    await user.click(screen.getByRole("button", { name: /Exclude וְהָאָ֗רֶץ/ }))
    expect(await screen.findByText(/Matches 1 place\b/)).toBeTruthy()
    await user.click(screen.getByRole("button", { name: /add term/i }))
    await waitFor(() => {
      expect(onConfirm).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceTerm: "הָאָ֗רֶץ",
          match: expect.objectContaining({ excludedForms: ["וְהָאָ֗רֶץ"] }),
        }),
      )
    })
  })

  it("closes on Cancel without calling onConfirm", async () => {
    const onConfirm = vi.fn()
    const onOpenChange = vi.fn()
    renderPopover({ onConfirm, onOpenChange })
    await openPopover()
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }))
    expect(onConfirm).not.toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(screen.queryByLabelText(/source term for new concept/i)).not.toBeInTheDocument()
  })

  it("shows validation when Add term is clicked with an empty term", async () => {
    const onConfirm = vi.fn()
    renderPopover({ sourceTerm: "", onConfirm })
    await openPopover()
    fireEvent.click(screen.getByRole("button", { name: /add term/i }))
    await waitFor(() => {
      expect(screen.getByText(/source term is required/i)).toBeInTheDocument()
    })
    expect(onConfirm).not.toHaveBeenCalled()
    expect(screen.getByLabelText(/source term for new concept/i)).toBeInTheDocument()
  })

  it("shows validation when term is whitespace only", async () => {
    const onConfirm = vi.fn()
    renderPopover({ sourceTerm: "   ", onConfirm })
    const input = await openPopover()
    fireEvent.change(input, { target: { value: "   " } })
    fireEvent.click(screen.getByRole("button", { name: /add term/i }))
    await waitFor(() => {
      expect(screen.getByText(/source term is required/i)).toBeInTheDocument()
    })
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it("disables the inputs and Add term when blockedReason is set", async () => {
    const onConfirm = vi.fn()
    renderPopover({
      onConfirm,
      blockedReason: "You need the Maintainer role or higher to change the term base.",
    })
    await openPopover()

    expect(screen.getByRole("alert")).toHaveTextContent(/maintainer role or higher/i)
    expect(screen.getByLabelText(/source term for new concept/i)).toBeDisabled()
    expect(screen.getByRole("button", { name: /add term/i })).toBeDisabled()

    fireEvent.click(screen.getByRole("button", { name: /add term/i }))
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it("keeps Cancel active while blocked so the user can close the popover", async () => {
    const onOpenChange = vi.fn()
    renderPopover({
      onOpenChange,
      blockedReason: "You need the Maintainer role or higher to change the term base.",
    })
    await openPopover()

    const cancelBtn = screen.getByRole("button", { name: /cancel/i })
    expect(cancelBtn).toBeEnabled()
    fireEvent.click(cancelBtn)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})

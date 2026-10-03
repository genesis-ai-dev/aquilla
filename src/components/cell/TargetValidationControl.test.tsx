import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { TargetValidationControl } from "./TargetValidationControl"

function renderControl(activeValidators: string[], onValidationChange = vi.fn()) {
  return render(
    <TargetValidationControl
      cellRef="Mark 1:1"
      hasContent
      validationStatus={activeValidators.includes("alice") ? "full-self" : "none"}
      activeValidators={activeValidators}
      validationHistory={[]}
      currentUsername="alice"
      validationRequirement={1}
      canValidate
      canValidateThisCell
      onValidationChange={onValidationChange}
    />,
  )
}

describe("TargetValidationControl", () => {
  it("does not reactivate a completed optimistic unvalidation after a later validation", async () => {
    const onValidationChange = vi.fn()
    const { rerender } = renderControl(["alice"], onValidationChange)

    fireEvent.click(screen.getByRole("button", { name: /Validated/ }))
    fireEvent.click(await screen.findByRole("button", { name: "Remove your validation" }))
    expect(screen.getByRole("button", { name: /Not validated/ })).toHaveAttribute("aria-pressed", "false")

    rerender(
      <TargetValidationControl
        cellRef="Mark 1:1"
        hasContent
        validationStatus="none"
        activeValidators={[]}
        validationHistory={[]}
        currentUsername="alice"
        validationRequirement={1}
        canValidate
        canValidateThisCell
        onValidationChange={onValidationChange}
      />,
    )
    rerender(
      <TargetValidationControl
        cellRef="Mark 1:1"
        hasContent
        validationStatus="full-self"
        activeValidators={["alice"]}
        validationHistory={[]}
        currentUsername="alice"
        validationRequirement={1}
        canValidate
        canValidateThisCell
        onValidationChange={onValidationChange}
      />,
    )

    expect(screen.getByRole("button", { name: /Validated/ })).toHaveAttribute("aria-pressed", "true")
  })

  // Sam, 2026-09-23: a line with no text draws a FADED circle that does
  // nothing, instead of an empty slot, so the gutter is full on every row.
  it("draws a faded, unclickable circle when there is no text", () => {
    const onValidationChange = vi.fn()
    render(
      <TargetValidationControl
        cellRef="Mark 1:1"
        hasContent={false}
        validationStatus="none"
        activeValidators={[]}
        validationHistory={[]}
        currentUsername="alice"
        validationRequirement={1}
        canValidate
        canValidateThisCell
        onValidationChange={onValidationChange}
      />,
    )
    expect(screen.queryByRole("button")).toBeNull()
    const faded = screen.getByTestId("validation-unavailable")
    expect(faded).toHaveAccessibleName(/no text to validate/i)
    fireEvent.click(faded)
    expect(onValidationChange).not.toHaveBeenCalled()
  })

  // Sam, 2026-09-23: the same hover rule as audio. The tooltip names which
  // half it is about, and a why-not survives somebody else voting first.
  it("names the text half in its tooltip", async () => {
    render(
      <TargetValidationControl
        cellRef="Mark 1:1" hasContent validationStatus="none" activeValidators={[]}
        validationHistory={[]} currentUsername="alice" validationRequirement={1}
        canValidate canValidateThisCell onValidationChange={vi.fn()}
      />,
    )
    fireEvent.mouseEnter(screen.getByRole("button"))
    fireEvent.pointerEnter(screen.getByRole("button"))
    fireEvent.focus(screen.getByRole("button"))
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Text not validated — click to validate")
  })

  it("puts the why-not at the foot of the Validated by list", async () => {
    render(
      <TargetValidationControl
        cellRef="Mark 1:1" hasContent validationStatus="others" activeValidators={["bo"]}
        validationHistory={[]} currentUsername="alice" validationRequirement={2}
        canValidate canValidateThisCell={false} onValidationChange={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole("button"))
    expect(await screen.findByText("Text validated by")).toBeInTheDocument()
    expect(screen.getByTestId("validation-blocked-note")).toHaveTextContent("Outside your assigned files or lanes")
  })

  // AQU-1571: the project's own text rules, mirrored so a vote the server is
  // about to refuse is never sent — and the reader is told why.
  describe("when the project's text rules refuse the vote", () => {
    const hover = async () => {
      const button = screen.getByRole("button")
      fireEvent.mouseEnter(button)
      fireEvent.pointerEnter(button)
      fireEvent.focus(button)
      return screen.findByRole("tooltip")
    }

    it("says the reader made the latest change, and a click sends nothing", async () => {
      const onValidationChange = vi.fn()
      render(
        <TargetValidationControl
          cellRef="Mark 1:1" hasContent validationStatus="none" activeValidators={[]}
          validationHistory={[]} currentUsername="alice" validationRequirement={1}
          canValidate canValidateThisCell={false} blockedReason="self"
          onValidationChange={onValidationChange}
        />,
      )
      expect(screen.getByRole("button")).toHaveAttribute("aria-disabled", "true")
      expect(await hover()).toHaveTextContent(
        "You made the latest change to this text, so someone else must validate it",
      )
      fireEvent.click(screen.getByRole("button"))
      expect(onValidationChange).not.toHaveBeenCalled()
    })

    it("puts the same sentence under somebody else's vote", async () => {
      const onValidationChange = vi.fn()
      render(
        <TargetValidationControl
          cellRef="Mark 1:1" hasContent validationStatus="others" activeValidators={["bo"]}
          validationHistory={[]} currentUsername="alice" validationRequirement={2}
          canValidate canValidateThisCell={false} blockedReason="self"
          onValidationChange={onValidationChange}
        />,
      )
      fireEvent.click(screen.getByRole("button"))
      expect(await screen.findByText("Text validated by")).toBeInTheDocument()
      expect(screen.getByTestId("validation-blocked-note")).toHaveTextContent(
        "You made the latest change to this text, so someone else must validate it",
      )
      expect(onValidationChange).not.toHaveBeenCalled()
    })

    // The named-validator list is deliberately not named, as audio does not.
    it("reads as unavailable when the minimum role or validator list excludes the reader", async () => {
      render(
        <TargetValidationControl
          cellRef="Mark 1:1" hasContent validationStatus="none" activeValidators={[]}
          validationHistory={[]} currentUsername="alice" validationRequirement={1}
          canValidate canValidateThisCell={false} blockedReason="policy" onValidationChange={vi.fn()}
        />,
      )
      expect(await hover()).toHaveTextContent("Text validation unavailable")
    })

    // The server never gates taking your own vote back.
    it("still offers to remove a vote the reader cast before the rule applied", async () => {
      const onValidationChange = vi.fn()
      render(
        <TargetValidationControl
          cellRef="Mark 1:1" hasContent validationStatus="full-self" activeValidators={["alice"]}
          validationHistory={[]} currentUsername="alice" validationRequirement={1}
          canValidate canValidateThisCell={false} blockedReason="self"
          onValidationChange={onValidationChange}
        />,
      )
      fireEvent.click(screen.getByRole("button", { name: /Validated/ }))
      expect(screen.queryByTestId("validation-blocked-note")).not.toBeInTheDocument()
      fireEvent.click(await screen.findByRole("button", { name: "Remove your validation" }))
      expect(onValidationChange).toHaveBeenCalledWith(false)
    })
  })

  // PR 1 browser pass, 2026-10-02: after hover opened the "Text validated by"
  // list, a click on the check closed it. Base UI reads a click that comes
  // more than 500 ms after a hover open as "close". A click now pins it.
  describe("the Text validated by list", () => {
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

    // Walk 10-02: the check still announced "Click to remove your validation"
    // after a press stopped removing anything. It names what a press does now.
    it("names your own validation for what a press does: open the list, not remove the vote", () => {
      const onValidationChange = vi.fn()
      const { rerender } = render(
        <TargetValidationControl
          cellRef="row 4" hasContent validationStatus="self" activeValidators={["alice"]}
          validationHistory={[]} currentUsername="alice" validationRequirement={2}
          canValidate canValidateThisCell onValidationChange={onValidationChange}
        />,
      )
      const button = screen.getByRole("button", {
        name: "Validated by you, row 4. Click to see the list, where you can remove your validation.",
      })
      fireEvent.click(button)
      expect(onValidationChange).not.toHaveBeenCalled()
      expect(screen.getByRole("button", { name: "Remove your validation" })).toBeInTheDocument()

      // Without the right to validate here, there is no Remove button to point at.
      rerender(
        <TargetValidationControl
          cellRef="row 4" hasContent validationStatus="self" activeValidators={["alice"]}
          validationHistory={[]} currentUsername="alice" validationRequirement={2}
          canValidate={false} canValidateThisCell={false} onValidationChange={onValidationChange}
        />,
      )
      expect(screen.getByRole("button", { name: "Validated by you, row 4." })).toBeInTheDocument()
    })

    it("stays open after a click on a hover-opened list, and after the pointer leaves", async () => {
      render(
        <TargetValidationControl
          cellRef="Mark 1:1" hasContent validationStatus="full-self" activeValidators={["alice", "bo"]}
          validationHistory={[]} currentUsername="alice" validationRequirement={2}
          canValidate canValidateThisCell onValidationChange={vi.fn()}
        />,
      )
      const button = screen.getByRole("button", { name: /Validated/ })
      fireEvent.pointerEnter(button, { pointerType: "mouse" })
      fireEvent.mouseEnter(button)
      fireEvent.mouseMove(button, { movementX: 5, movementY: 5 })
      expect(await screen.findByText("Text validated by", {}, { timeout: 2000 })).toBeInTheDocument()

      // Past Base UI's 500 ms "patient click" window, where the click used to close it.
      await wait(650)
      fireEvent.pointerDown(button, { pointerType: "mouse" })
      fireEvent.click(button)
      await wait(50)
      expect(screen.getByText("Text validated by")).toBeInTheDocument()

      fireEvent.mouseLeave(button, { relatedTarget: document.body })
      await wait(300)
      expect(screen.getByText("Text validated by")).toBeInTheDocument()

      fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" })
      await vi.waitFor(() => expect(screen.queryByText("Text validated by")).not.toBeInTheDocument())

      // Closed lists open again on the next click.
      fireEvent.pointerDown(button, { pointerType: "mouse" })
      fireEvent.click(button)
      expect(await screen.findByText("Text validated by")).toBeInTheDocument()
    })

    it("closes after Remove your validation", async () => {
      const onValidationChange = vi.fn()
      render(
        <TargetValidationControl
          cellRef="Mark 1:1" hasContent validationStatus="full-self" activeValidators={["alice", "bo"]}
          validationHistory={[]} currentUsername="alice" validationRequirement={2}
          canValidate canValidateThisCell onValidationChange={onValidationChange}
        />,
      )
      fireEvent.click(screen.getByRole("button", { name: /Validated/ }))
      fireEvent.click(await screen.findByRole("button", { name: "Remove your validation" }))
      expect(onValidationChange).toHaveBeenCalledWith(false)
      await vi.waitFor(() => expect(screen.queryByText("Text validated by")).not.toBeInTheDocument())
    })
  })
})

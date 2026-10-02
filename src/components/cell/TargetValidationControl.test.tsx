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
})

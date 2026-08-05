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
})

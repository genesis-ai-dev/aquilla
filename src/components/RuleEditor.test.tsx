import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { RuleEditor } from "./RuleEditor"

function renderEditor() {
  return render(
    <RuleEditor
      cells={[]}
      onSave={vi.fn()}
      onCancel={vi.fn()}
    />,
  )
}

describe("RuleEditor toggles", () => {
  it("toggles the Enabled switch aria-checked", async () => {
    const user = userEvent.setup()
    renderEditor()

    // Label wraps Switch + "Enabled" text (same locator pattern as the smoke).
    const enabledSwitch = screen
      .getByText("Enabled", { exact: true })
      .closest("label")!
      .querySelector('[role="switch"]') as HTMLElement
    expect(enabledSwitch).toBeTruthy()
    expect(enabledSwitch).toHaveAttribute("aria-checked", "true")

    await user.click(enabledSwitch)
    expect(enabledSwitch).toHaveAttribute("aria-checked", "false")

    await user.click(enabledSwitch)
    expect(enabledSwitch).toHaveAttribute("aria-checked", "true")
  })

  it("toggles severity between Minor and Major", () => {
    renderEditor()

    const minorBtn = screen.getByRole("button", { name: /^Minor$/i })
    const majorBtn = screen.getByRole("button", { name: /^Major$/i })

    expect(minorBtn).toHaveClass(/bg-amber-500/)

    fireEvent.click(majorBtn)
    expect(majorBtn).toHaveClass(/bg-red-500/)
    expect(minorBtn).not.toHaveClass(/bg-amber-500/)

    fireEvent.click(minorBtn)
    expect(minorBtn).toHaveClass(/bg-amber-500/)
    expect(majorBtn).not.toHaveClass(/bg-red-500/)
  })

  it("toggles mode Forbidden / Required / Must match and source-pattern visibility", () => {
    renderEditor()

    expect(document.getElementById("re-src-pat")).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: /^Required$/i }))
    expect(document.getElementById("re-src-pat")).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: /^Must match$/i }))
    expect(document.getElementById("re-src-pat")).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: /^Forbidden$/i }))
    expect(document.getElementById("re-src-pat")).toBeNull()
  })

  it("toggles regex vs literal pattern mode", () => {
    renderEditor()

    expect(screen.getByText(/Switch to literal text/i)).toBeInTheDocument()

    fireEvent.click(screen.getByText(/Switch to literal text/i))
    expect(screen.getByText(/Switch to regex/i)).toBeInTheDocument()
    expect(screen.queryByText(/Switch to literal text/i)).not.toBeInTheDocument()

    fireEvent.click(screen.getByText(/Switch to regex/i))
    expect(screen.getByText(/Switch to literal text/i)).toBeInTheDocument()
  })

  it("shows and hides the autofix section", () => {
    renderEditor()

    expect(screen.getByText(/Add autofix \(optional\)/i)).toBeInTheDocument()
    expect(screen.queryByText(/Autofix — regex replace/i)).not.toBeInTheDocument()

    fireEvent.click(screen.getByText(/Add autofix \(optional\)/i))
    expect(screen.getByText(/Autofix — regex replace/i)).toBeInTheDocument()

    fireEvent.click(screen.getByText(/Hide autofix/i))
    expect(screen.queryByText(/Autofix — regex replace/i)).not.toBeInTheDocument()
  })
})

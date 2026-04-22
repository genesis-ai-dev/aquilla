import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { HealthSettingsSection } from "./HealthSettingsSection"
import { HEALTH_DEFAULTS } from "@/lib/health/defaults"

describe("HealthSettingsSection", () => {
  it("shows defaults when followDefaults is true", () => {
    render(
      <HealthSettingsSection
        settings={{ followDefaults: true }}
        onChange={vi.fn()}
        onReset={vi.fn()}
      />
    )
    expect(screen.getByLabelText(/Follow defaults/i)).toBeChecked()
    expect(screen.getByLabelText(/Validation gap cap/i)).toHaveValue(HEALTH_DEFAULTS.caps.validationGap)
  })

  it("invokes onChange with the updated field when cap slider moves", () => {
    const onChange = vi.fn()
    render(
      <HealthSettingsSection
        settings={{ followDefaults: false, overrides: {} }}
        onChange={onChange}
        onReset={vi.fn()}
      />
    )
    const input = screen.getByLabelText(/Validation gap cap/i) as HTMLInputElement
    fireEvent.change(input, { target: { value: "50" } })
    expect(onChange).toHaveBeenCalled()
    const call = onChange.mock.calls.at(-1)?.[0]
    expect(call.overrides.caps.validationGap).toBe(50)
    expect(call.followDefaults).toBe(false)
  })

  it("flips followDefaults to false automatically when a field is edited", () => {
    const onChange = vi.fn()
    render(
      <HealthSettingsSection
        settings={{ followDefaults: true }}
        onChange={onChange}
        onReset={vi.fn()}
      />
    )
    const input = screen.getByLabelText(/Rules cap/i) as HTMLInputElement
    fireEvent.change(input, { target: { value: "30" } })
    const call = onChange.mock.calls.at(-1)?.[0]
    expect(call.followDefaults).toBe(false)
    expect(call.overrides.caps.rulePenalty).toBe(30)
  })

  it("invokes onReset when the reset button is clicked (after confirm)", () => {
    const onReset = vi.fn()
    // Stub window.confirm to auto-accept
    const origConfirm = window.confirm
    window.confirm = () => true
    try {
      render(
        <HealthSettingsSection
          settings={{ followDefaults: false, overrides: { caps: { rulePenalty: 30 } as never } }}
          onChange={vi.fn()}
          onReset={onReset}
        />
      )
      fireEvent.click(screen.getByRole("button", { name: /Reset overrides/i }))
      expect(onReset).toHaveBeenCalled()
    } finally {
      window.confirm = origConfirm
    }
  })
})

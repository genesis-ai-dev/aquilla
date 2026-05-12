import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { HealthSettingsSection } from "./HealthSettingsSection"
import { HEALTH_DEFAULTS } from "@/lib/health/defaults"

const DEFAULT_PENALTIES = HEALTH_DEFAULTS.rulePenalties

describe("HealthSettingsSection", () => {
  it("shows defaults when followDefaults is true", () => {
    render(
      <HealthSettingsSection
        settings={{ followDefaults: true }}
        rulePenalties={DEFAULT_PENALTIES}
        onChange={vi.fn()}
        onRulePenaltiesChange={vi.fn()}
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
        rulePenalties={DEFAULT_PENALTIES}
        onChange={onChange}
        onRulePenaltiesChange={vi.fn()}
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
        rulePenalties={DEFAULT_PENALTIES}
        onChange={onChange}
        onRulePenaltiesChange={vi.fn()}
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
          rulePenalties={DEFAULT_PENALTIES}
          onChange={vi.fn()}
          onRulePenaltiesChange={vi.fn()}
          onReset={onReset}
        />
      )
      fireEvent.click(screen.getByRole("button", { name: /Reset overrides/i }))
      expect(onReset).toHaveBeenCalled()
    } finally {
      window.confirm = origConfirm
    }
  })

  it("major/minor penalty inputs write to project.rulePenalties (not to healthSettings.overrides)", () => {
    const onRulePenaltiesChange = vi.fn()
    const onChange = vi.fn()
    render(
      <HealthSettingsSection
        settings={{ followDefaults: false, overrides: {} }}
        rulePenalties={{ major: 15, minor: 5 }}
        onChange={onChange}
        onRulePenaltiesChange={onRulePenaltiesChange}
        onReset={vi.fn()}
      />
    )
    const major = screen.getByLabelText(/Major rule penalty/i) as HTMLInputElement
    fireEvent.change(major, { target: { value: "25" } })
    expect(onRulePenaltiesChange).toHaveBeenCalledWith({ major: 25, minor: 5 })
    // Crucially, the healthSettings.overrides path must NOT have been written.
    expect(onChange).not.toHaveBeenCalled()
  })

  it("clamps penalty inputs at 100", () => {
    const onRulePenaltiesChange = vi.fn()
    render(
      <HealthSettingsSection
        settings={{ followDefaults: false, overrides: {} }}
        rulePenalties={{ major: 15, minor: 5 }}
        onChange={vi.fn()}
        onRulePenaltiesChange={onRulePenaltiesChange}
        onReset={vi.fn()}
      />
    )
    const minor = screen.getByLabelText(/Minor rule penalty/i) as HTMLInputElement
    fireEvent.change(minor, { target: { value: "250" } })
    expect(onRulePenaltiesChange).toHaveBeenCalledWith({ major: 15, minor: 100 })
  })

  it("clamps cap inputs at 100", () => {
    const onChange = vi.fn()
    render(
      <HealthSettingsSection
        settings={{ followDefaults: false, overrides: {} }}
        rulePenalties={DEFAULT_PENALTIES}
        onChange={onChange}
        onRulePenaltiesChange={vi.fn()}
        onReset={vi.fn()}
      />
    )
    const input = screen.getByLabelText(/Validation gap cap/i) as HTMLInputElement
    fireEvent.change(input, { target: { value: "500" } })
    const call = onChange.mock.calls.at(-1)?.[0]
    expect(call.overrides.caps.validationGap).toBe(100)
  })
})

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

  it("clamps penalty inputs at the current rule-penalty cap", () => {
    // Default rulePenalty cap is HEALTH_DEFAULTS.caps.rulePenalty. The penalty
    // input should never store a value above the cap — rule-penalty.ts clamps
    // the sum anyway, so allowing per-severity values above the cap would be
    // misleading.
    const onChange = vi.fn()
    render(
      <HealthSettingsSection
        settings={{ followDefaults: false, overrides: {} }}
        onChange={onChange}
        onReset={vi.fn()}
      />
    )
    const minor = screen.getByLabelText(/Minor rule penalty/i) as HTMLInputElement
    fireEvent.change(minor, { target: { value: "250" } })
    const call = onChange.mock.calls.at(-1)?.[0]
    expect(call.overrides.rulePenalties.minor).toBe(HEALTH_DEFAULTS.caps.rulePenalty)
  })

  it("penalty input cap tracks the current Rules cap override (not the default)", () => {
    const onChange = vi.fn()
    render(
      <HealthSettingsSection
        settings={{ followDefaults: false, overrides: { caps: { rulePenalty: 25 } as never } }}
        onChange={onChange}
        onReset={vi.fn()}
      />
    )
    const major = screen.getByLabelText(/Major rule penalty/i) as HTMLInputElement
    fireEvent.change(major, { target: { value: "999" } })
    const call = onChange.mock.calls.at(-1)?.[0]
    expect(call.overrides.rulePenalties.major).toBe(25)
  })

  it("clamps negative penalty input at zero", () => {
    const onChange = vi.fn()
    render(
      <HealthSettingsSection
        settings={{ followDefaults: false, overrides: {} }}
        onChange={onChange}
        onReset={vi.fn()}
      />
    )
    const minor = screen.getByLabelText(/Minor rule penalty/i) as HTMLInputElement
    fireEvent.change(minor, { target: { value: "-5" } })
    const call = onChange.mock.calls.at(-1)?.[0]
    expect(call.overrides.rulePenalties.minor).toBe(0)
  })

  it("renders the /N fraction suffix next to major and minor penalty inputs", () => {
    render(
      <HealthSettingsSection
        settings={{ followDefaults: true }}
        onChange={vi.fn()}
        onReset={vi.fn()}
      />
    )
    // Two rows (major, minor) both reference the same cap.
    const suffix = `/ ${HEALTH_DEFAULTS.caps.rulePenalty}`
    expect(screen.getAllByText(suffix).length).toBeGreaterThanOrEqual(2)
    // And the HTML `max` attribute reflects the cap so spinner buttons stop there.
    expect(screen.getByLabelText(/Major rule penalty/i)).toHaveAttribute(
      "max",
      String(HEALTH_DEFAULTS.caps.rulePenalty),
    )
  })

  it("reducing the Rules cap shrinks the /N suffix on penalty inputs", () => {
    render(
      <HealthSettingsSection
        settings={{ followDefaults: false, overrides: { caps: { rulePenalty: 25 } as never } }}
        onChange={vi.fn()}
        onReset={vi.fn()}
      />
    )
    expect(screen.getAllByText("/ 25").length).toBeGreaterThanOrEqual(2)
    expect(screen.getByLabelText(/Major rule penalty/i)).toHaveAttribute("max", "25")
  })
})

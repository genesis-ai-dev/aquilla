// AQU-1768: the two audio permission settings can follow the organization's
// default ("Organization default (…)") or be set for this project. While the
// project follows, the control shows the organization's value and is disabled.
import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ValidationSettingsSection } from "./ValidationSettingsSection"

vi.mock("@/hooks/useProjectMembers", () => ({
  useProjectMembers: () => ({
    members: [], isLoading: false, error: null, rosterHidden: false,
    refresh: async () => {}, add: async () => null, addMany: async () => [],
    remove: async () => {}, changeRole: async () => null,
  }),
}))

function draw(over: Record<string, unknown> = {}) {
  const onChange = vi.fn()
  render(
    <ValidationSettingsSection
      projectId="p1"
      validationCount={1}
      validationCountAudio={1}
      allowSelfValidationAudio={null}
      validationRoleFloorAudio={null}
      orgAllowSelfValidationAudio={false}
      orgValidationRoleFloorAudio="project_lead"
      onChange={onChange}
      {...over}
    />,
  )
  return { onChange }
}

const selfSwitch = () => screen.getByRole("switch", { name: /Allow validating your own recordings/i })
const selfSource = () => screen.getByTestId("allow-self-validation-audio-source")
const floorSource = () => screen.getByTestId("validation-role-floor-audio-source")
/** The switch and select primitives mark "disabled" in different ways. */
const isDisabled = (el: HTMLElement) =>
  el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true" || el.hasAttribute("data-disabled")

describe("ValidationSettingsSection — audio settings follow the organization", () => {
  it("shows the organization's values while the project sets none, and they can be changed right there", () => {
    draw()
    expect(selfSource().textContent).toContain("Organization default (off)")
    expect(selfSwitch().getAttribute("aria-checked") === "true" || selfSwitch().hasAttribute("data-checked")).toBe(false)
    expect(isDisabled(selfSwitch())).toBe(false)
    expect(floorSource().textContent).toContain("Organization default (Project lead)")
    expect(isDisabled(screen.getByRole("combobox", { name: "Minimum role to validate recordings" }))).toBe(false)
  })

  it("flipping a switch that follows the organization sets it for this project in one step (Sam, Oct 28)", async () => {
    const { onChange } = draw()
    await userEvent.click(selfSwitch())
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ allowSelfValidationAudio: true })
  })

  it("'Set for this project' starts from the organization's value", async () => {
    const { onChange } = draw()
    await userEvent.click(selfSource())
    await userEvent.click(await screen.findByRole("option", { name: "Set for this project" }))
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ allowSelfValidationAudio: false })
  })

  it("choosing the organization's default clears the project's own value", async () => {
    const { onChange } = draw({ validationRoleFloorAudio: "maintainer" })
    await userEvent.click(floorSource())
    await userEvent.click(await screen.findByRole("option", { name: "Organization default (Project lead)" }))
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ validationRoleFloorAudio: null })
  })

  it("with no organization default either, shows the built-in values", () => {
    draw({ orgAllowSelfValidationAudio: null, orgValidationRoleFloorAudio: null })
    expect(selfSource().textContent).toContain("Organization default (on)")
    expect(floorSource().textContent).toContain("Organization default (Reviewer)")
  })
})

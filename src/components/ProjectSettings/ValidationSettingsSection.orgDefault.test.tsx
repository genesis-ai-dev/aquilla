// AQU-1771: a project's required-validator counts can follow the
// organization's default ("Organization default (N)") or be its own number.
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
      validationCount={null}
      validationCountAudio={null}
      orgValidationCount={2}
      orgValidationCountAudio={null}
      onChange={onChange}
      {...over}
    />,
  )
  return { onChange }
}

const textSource = () => screen.getByRole("combobox", { name: /Text validators: use the organization default/i })

describe("ValidationSettingsSection — organization default", () => {
  it("shows the org's number and no project box while inheriting", () => {
    draw()
    expect(textSource().textContent).toContain("Organization default (2)")
    expect(screen.queryByRole("spinbutton", { name: /Required validators \(text\)/i })).toBeNull()
    // The audio org default is unset, which reads as 1.
    expect(
      screen.getByRole("combobox", { name: /Audio validators: use the organization default/i }).textContent,
    ).toContain("Organization default (1)")
  })

  it("choosing 'Set for this project' starts from the number in force", async () => {
    const { onChange } = draw()
    await userEvent.click(textSource())
    await userEvent.click(await screen.findByRole("option", { name: "Set for this project" }))
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ validationCount: 2 })
  })

  it("choosing the default clears the project's own number", async () => {
    const { onChange } = draw({ validationCount: 3 })
    expect(screen.getByRole("spinbutton", { name: /Required validators \(text\)/i })).toHaveValue(3)
    await userEvent.click(textSource())
    await userEvent.click(await screen.findByRole("option", { name: "Organization default (2)" }))
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ validationCount: null })
  })
})

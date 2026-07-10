// AQU-352 — "Minimum validator role" dropdown must use the canonical role
// taxonomy, not a per-surface renamed variant.
//
// Before the fix this dropdown hardcoded its own labels ("Reviewer (default)",
// "Project Lead", "Maintainer") while the member / invite / share surfaces
// render the canonical `roleName` ("reviewer", "project_lead", "maintainer").
// A settings owner therefore couldn't tell which real role a floor mapped to.
// These tests pin the rendered floor value to the canonical name so the drift
// can't silently return.

import { describe, it, expect, vi } from "vitest"
import { render } from "@testing-library/react"
import { ValidationSettingsSection } from "./ValidationSettingsSection"
import { roleDisplayText, roleName } from "@/lib/frontier/roles"

function renderFloor(validationRoleFloor: "reviewer" | "project_lead" | "maintainer") {
  return render(
    <ValidationSettingsSection
      validationCount={2}
      validationCountAudio={2}
      hasAnyAudioData={false}
      validationRoleFloor={validationRoleFloor}
      onChange={vi.fn()}
    />,
  )
}

function floorValueText(container: HTMLElement): string {
  // The floor <Select> is the only one in this section; its displayed value
  // lives on the [data-slot="select-value"] node.
  const value = container.querySelector('[data-slot="select-value"]')
  return value?.textContent ?? ""
}

describe("ValidationSettingsSection — validator-role taxonomy (AQU-352)", () => {
  it("shows the capitalized canonical role name for project_lead", () => {
    const { container } = renderFloor("project_lead")
    const text = floorValueText(container)
    expect(text).toContain(roleDisplayText(roleName(500))) // "Project Lead"
  })

  it("shows 'Reviewer' without a '(default)' suffix baked into the label", () => {
    const { container } = renderFloor("reviewer")
    const text = floorValueText(container)
    expect(text).toContain(roleDisplayText(roleName(300))) // "Reviewer"
    expect(text).not.toMatch(/\(default\)/)
  })

  it("shows the capitalized canonical name for maintainer", () => {
    const { container } = renderFloor("maintainer")
    expect(floorValueText(container)).toContain(roleDisplayText(roleName(600))) // "Maintainer"
  })
})

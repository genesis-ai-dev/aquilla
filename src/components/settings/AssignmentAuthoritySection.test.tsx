// AQU-2261: role names carry no level numbers in the interface.
import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { AssignmentAuthoritySection } from "./AssignmentAuthoritySection"
import type { UseOrgSettings } from "@/hooks/useOrgSettings"
import { ROLE } from "@/lib/frontier/roles"

function orgSettings(): UseOrgSettings {
  return {
    patch: vi.fn().mockResolvedValue({ kind: "ok" }),
    allowSelfAssignment: false,
    allowScopedLaneAssignment: false,
    assignmentMinRole: ROLE.PROJECT_LEAD,
  } as unknown as UseOrgSettings
}

describe("AssignmentAuthoritySection", () => {
  it("names each role in the minimum-role list without its level number", async () => {
    render(<AssignmentAuthoritySection orgSettings={orgSettings()} canEdit />)
    const picker = screen.getAllByRole("combobox")[0]
    expect(picker.textContent).toContain("Project lead")
    expect(picker.textContent).not.toMatch(/\(\d00\)/)
    await userEvent.click(picker)
    expect(await screen.findByRole("option", { name: "Maintainer" })).toBeInTheDocument()
    expect(screen.queryByRole("option", { name: /\(\d00\)/ })).toBeNull()
  })
})

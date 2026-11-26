import { render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { describe, expect, it, vi } from "vitest"
import { useOrgMembers } from "@/hooks/useOrg"
import { OrgSetupChecklist } from "./OrgSetupChecklist"

vi.mock("@/hooks/useOrg", () => ({ useOrgMembers: vi.fn() }))

describe("Overview organization setup", () => {
  it("waits for readable members before offering to invite a teammate", () => {
    const members = [{ userId: 1 }, { userId: 2 }]
    const roster = (hasReadableRoster: boolean, count: number) =>
      vi.mocked(useOrgMembers).mockReturnValue({
        hasReadableRoster, members: members.slice(0, count),
      } as ReturnType<typeof useOrgMembers>)
    const checklist = () => <MemoryRouter><OrgSetupChecklist orgId={1} projectCount={1} onProjectCreated={vi.fn()} /></MemoryRouter>
    roster(false, 0)
    const view = render(checklist())
    expect(screen.queryByTestId("org-setup-checklist")).toBeNull()
    roster(true, 2)
    view.rerender(checklist())
    expect(screen.queryByTestId("org-setup-checklist")).toBeNull()
    roster(true, 1)
    view.rerender(checklist())
    expect(screen.getByRole("button", { name: "Invite" })).toBeVisible()
  })
})

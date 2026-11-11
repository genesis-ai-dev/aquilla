import { describe, expect, it, vi, beforeEach } from "vitest"
import { render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"

import { ProjectNoAccess } from "./ProjectNoAccess"
import { en } from "@/lib/i18n/messages/en"

const navigate = vi.fn()
vi.mock("react-router-dom", async (importActual) => {
  const actual = await importActual<typeof import("react-router-dom")>()
  return { ...actual, useNavigate: () => navigate }
})

let activeOrg: { activeOrgId: number | null; isAllOrgs: boolean } = {
  activeOrgId: 7,
  isAllOrgs: false,
}
vi.mock("@/context/OrgContext", () => ({
  useActiveOrg: () => activeOrg,
}))

function renderScreen() {
  return render(
    <MemoryRouter>
      <ProjectNoAccess />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  navigate.mockClear()
  activeOrg = { activeOrgId: 7, isAllOrgs: false }
})

// AQU-2452: every project access rejection — no such project, an org member
// with no grant, a non-member, a removed member — lands on this one screen
// with this one message, so the interface never reveals whether a project
// exists. The screens it replaced carried two different messages (one of them
// "You no longer have access", which was wrong for someone who never had any)
// and, on the project overview, no message at all.
describe("ProjectNoAccess (AQU-2452)", () => {
  it("offers a way out and nothing else — no retry, no reason", () => {
    renderScreen()

    expect(screen.getByTestId("project-no-access")).toBeInTheDocument()
    expect(screen.getAllByRole("button")).toHaveLength(1)
    expect(screen.getByRole("button", { name: "Back to dashboard" })).toBeInTheDocument()
  })

  it("sends Back to dashboard to the org selected in the switcher", () => {
    renderScreen()

    screen.getByRole("button", { name: "Back to dashboard" }).click()

    expect(navigate).toHaveBeenCalledWith("/orgs/7")
  })

  it.each([
    ["the all-orgs portfolio is selected", { activeOrgId: 1, isAllOrgs: true }],
    ["the caller belongs to no org at all", { activeOrgId: null, isAllOrgs: false }],
  ])("sends Back to dashboard to the portfolio when %s", (_case, org) => {
    activeOrg = org

    renderScreen()
    screen.getByRole("button", { name: "Back to dashboard" }).click()

    expect(navigate).toHaveBeenCalledWith("/orgs/all")
  })

  // The guard that keeps the two cases from drifting apart again: there is one
  // refusal message in the catalog, not one per status. A second key is how
  // the old pair started.
  it("leaves exactly one project-refusal message in the catalog", () => {
    expect("workspace.status.noAccess" in en).toBe(true)
    expect("workspace.status.forbidden" in en).toBe(false)
    expect("workspace.status.notFound" in en).toBe(false)
  })
})

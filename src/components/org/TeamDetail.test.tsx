import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, screen, waitFor, act, fireEvent } from "@testing-library/react"
import { MemoryRouter, Routes, Route } from "react-router-dom"
import { OrgProvider } from "@/context/OrgContext"
import { TeamDetail } from "./TeamDetail"

vi.mock("@/hooks/useFrontierSession", () => ({ useFrontierSession: () => ({ session: { jwt: "jwt", username: "wendi", createdAt: "x" }, loading: false }) }))
const listMyOrgs = vi.fn()
const listOrgMembers = vi.fn()
vi.mock("@/lib/frontier/orgs", () => ({ listMyOrgs: (...a: unknown[]) => listMyOrgs(...a), listOrgMembers: (...a: unknown[]) => listOrgMembers(...a) }))
const getTeam = vi.fn()
const addTeamMember = vi.fn()
const removeTeamMember = vi.fn()
const deleteTeam = vi.fn()
const updateTeam = vi.fn()
const attachProject = vi.fn()
const changeProjectRole = vi.fn()
const detachProject = vi.fn()
vi.mock("@/lib/frontier/teams", () => ({
  getTeam: (...a: unknown[]) => getTeam(...a),
  addTeamMember: (...a: unknown[]) => addTeamMember(...a),
  removeTeamMember: (...a: unknown[]) => removeTeamMember(...a),
  deleteTeam: (...a: unknown[]) => deleteTeam(...a),
  updateTeam: (...a: unknown[]) => updateTeam(...a),
  attachProject: (...a: unknown[]) => attachProject(...a),
  changeProjectRole: (...a: unknown[]) => changeProjectRole(...a),
  detachProject: (...a: unknown[]) => detachProject(...a),
}))
vi.mock("@/lib/sync/cloud-projects", () => ({ fetchAccessibleProjects: vi.fn(async () => []) }))

function renderDetail() {
  return render(
    <MemoryRouter initialEntries={["/teams/10"]}>
      <OrgProvider>
        <Routes><Route path="/teams/:groupId" element={<TeamDetail />} /></Routes>
      </OrgProvider>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  localStorage.clear()
  listMyOrgs.mockResolvedValue([{ id: 1, name: "CAS", role: { level: 700, name: "owner" } }])
  listOrgMembers.mockResolvedValue([{ userId: 2, username: "anna", role: { level: 100, name: "viewer" } }])
  getTeam.mockResolvedValue({ id: 10, name: "WA", members: [{ userId: 2, username: "anna", roleLevel: 100 }], projects: [] })
  addTeamMember.mockResolvedValue({ userId: 2, username: "anna" })
  removeTeamMember.mockResolvedValue(undefined)
  deleteTeam.mockResolvedValue(undefined)
  updateTeam.mockResolvedValue({ id: 10, name: "WA2", description: null })
})
afterEach(() => vi.restoreAllMocks())

describe("TeamDetail admin management", () => {
  it("adds a member via the org-member picker", async () => {
    renderDetail()
    await waitFor(() => expect(screen.getByText("anna")).toBeInTheDocument())
    await act(async () => { (await screen.findByRole("button", { name: /add member/i })).click() })
    const select = screen.getByRole("combobox")
    await act(async () => { fireEvent.change(select, { target: { value: "anna" } }) })
    await act(async () => { screen.getByRole("button", { name: /^add$/i }).click() })
    await waitFor(() => expect(addTeamMember).toHaveBeenCalledWith("jwt", 1, 10, "anna"))
  })

  it("removes a member", async () => {
    renderDetail()
    await waitFor(() => expect(screen.getByText("anna")).toBeInTheDocument())
    await act(async () => { screen.getByRole("button", { name: /remove anna/i }).click() })
    await waitFor(() => expect(removeTeamMember).toHaveBeenCalledWith("jwt", 1, 10, 2))
  })

  it("deletes the team after confirm", async () => {
    renderDetail()
    await waitFor(() => expect(screen.getByText(/members/i)).toBeInTheDocument())
    await act(async () => { screen.getByRole("button", { name: /delete team/i }).click() })
    await act(async () => { screen.getByRole("button", { name: /confirm/i }).click() })
    await waitFor(() => expect(deleteTeam).toHaveBeenCalledWith("jwt", 1, 10))
  })
})

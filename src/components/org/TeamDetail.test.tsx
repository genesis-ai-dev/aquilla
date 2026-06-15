import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, screen, waitFor, act, fireEvent } from "@testing-library/react"
import { MemoryRouter, Routes, Route } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { OrgProvider } from "@/context/OrgContext"
import { TeamDetail } from "./TeamDetail"

vi.mock("@/hooks/useFrontierSession", () => ({ useFrontierSession: () => ({ session: { jwt: "jwt", username: "wendi", createdAt: "x" }, loading: false }) }))
const listMyOrgs = vi.fn()
const listOrgMembers = vi.fn()
const addOrgMember = vi.fn()
vi.mock("@/lib/frontier/orgs", () => ({
  listMyOrgs: (...a: unknown[]) => listMyOrgs(...a),
  listOrgMembers: (...a: unknown[]) => listOrgMembers(...a),
  addOrgMember: (...a: unknown[]) => addOrgMember(...a),
}))
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

// Drive the shadcn (Base UI) Select: open the trigger, hover-highlight the
// option, commit with Enter fired on the option itself. Under happy-dom
// clicking an option does not reliably commit a selection, but the keyboard
// path does (recipe adapted from AssignModal.test.tsx; Enter targets the
// option because outside a Dialog focus may never enter the popup).
// Callers assert the resulting effect themselves.
async function pickSelectOption(triggerName: RegExp, optionName: RegExp) {
  const trigger = screen.getByRole("combobox", { name: triggerName })
  fireEvent.click(trigger)
  const option = await screen.findByRole("option", { name: optionName })
  fireEvent.pointerMove(option)
  fireEvent.mouseMove(option)
  fireEvent.keyDown(option, { key: "Enter" })
}

function renderDetail() {
  // QueryClientProvider: the org shell's AccountSwitcher reaches useAccounts,
  // which clears the React Query cache on account switch (FRO-212).
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={["/teams/10"]}>
        <OrgProvider>
          <Routes><Route path="/teams/:groupId" element={<TeamDetail />} /></Routes>
        </OrgProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  localStorage.clear()
  listMyOrgs.mockResolvedValue([{ id: 1, name: "CAS", role: { level: 700, name: "owner" } }])
  listOrgMembers.mockResolvedValue([
    { userId: 4, username: "zara", role: { level: 100, name: "viewer" } },
    { userId: 2, username: "anna", role: { level: 100, name: "viewer" } },
    { userId: 3, username: "Ben", role: { level: 100, name: "viewer" } },
  ])
  getTeam.mockResolvedValue({ id: 10, name: "WA", members: [{ userId: 2, username: "anna", roleLevel: 100 }], projects: [] })
  addTeamMember.mockResolvedValue({ userId: 2, username: "anna" })
  removeTeamMember.mockResolvedValue(undefined)
  deleteTeam.mockResolvedValue(undefined)
  updateTeam.mockResolvedValue({ id: 10, name: "WA2", description: null })
})
afterEach(() => {
  vi.restoreAllMocks()
  attachProject.mockReset()
  detachProject.mockReset()
  changeProjectRole.mockReset()
})

describe("TeamDetail project management", () => {
  it("attaches a project at a role", async () => {
    const cp = await import("@/lib/sync/cloud-projects")
    ;(cp.fetchAccessibleProjects as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: "pa", name: "Bambara", orgId: 1, role: { level: 700, name: "owner", source: "creator" }, files: [] }])
    getTeam.mockResolvedValue({ id: 10, name: "WA", members: [], projects: [] })
    renderDetail()
    await waitFor(() => expect(screen.getByText(/projects/i)).toBeInTheDocument())
    await act(async () => { (await screen.findByRole("button", { name: /attach project/i })).click() })
    await pickSelectOption(/project to attach/i, /bambara/i)
    await pickSelectOption(/granted role/i, /contributor/i)
    await act(async () => { screen.getByRole("button", { name: /^attach$/i }).click() })
    await waitFor(() => expect(attachProject).toHaveBeenCalledWith("jwt", 1, 10, "pa", 400))
  })

  it("detaches a project", async () => {
    getTeam.mockResolvedValue({ id: 10, name: "WA", members: [], projects: [{ id: "pa", name: "Bambara", grantedRoleLevel: 400 }] })
    renderDetail()
    await waitFor(() => expect(screen.getByText("Bambara")).toBeInTheDocument())
    await act(async () => { screen.getByRole("button", { name: /detach bambara/i }).click() })
    await waitFor(() => expect(detachProject).toHaveBeenCalledWith("jwt", 1, 10, "pa"))
  })
})

describe("TeamDetail admin management", () => {
  it("adds a member via the org-member picker", async () => {
    renderDetail()
    await waitFor(() => expect(screen.getByText("anna")).toBeInTheDocument())
    await act(async () => { (await screen.findByRole("button", { name: /add member/i })).click() })
    const picker = screen.getByRole("combobox", { name: /member to add/i })
    expect(picker).toHaveTextContent("Search members...")
    fireEvent.click(picker)
    expect(screen.queryByRole("option", { name: /^anna$/ })).toBeNull()
    const options = await screen.findAllByRole("option")
    expect(options.map((option) => option.textContent)).toEqual(["Ben", "zara"])
    fireEvent.change(screen.getByRole("textbox", { name: /search org members/i }), {
      target: { value: "be" },
    })
    expect(screen.queryByRole("option", { name: /^zara$/ })).toBeNull()
    const benOption = screen.getByRole("option", { name: /^Ben$/ })
    fireEvent.click(benOption)
    await act(async () => { screen.getByRole("button", { name: /^add$/i }).click() })
    await waitFor(() => expect(addTeamMember).toHaveBeenCalledWith("jwt", 1, 10, "Ben"))
  })

  it("removes a member", async () => {
    renderDetail()
    await waitFor(() => expect(screen.getByText("anna")).toBeInTheDocument())
    await act(async () => { (await screen.findByRole("button", { name: /remove anna/i })).click() })
    await waitFor(() => expect(removeTeamMember).toHaveBeenCalledWith("jwt", 1, 10, 2))
  })

  it("deletes the team after confirm", async () => {
    renderDetail()
    // Wait for the team heading to confirm both org and team data are loaded.
    // Using role="heading" is unambiguous — unlike /members/i which also
    // matches the sidebar nav link (visible before team data arrives) and
    // causes a race when the full suite runs with concurrent file execution.
    await waitFor(() => expect(screen.getByRole("heading", { name: "WA" })).toBeInTheDocument())
    await act(async () => { screen.getByRole("button", { name: /delete team/i }).click() })
    await act(async () => { screen.getByRole("button", { name: /confirm/i }).click() })
    await waitFor(() => expect(deleteTeam).toHaveBeenCalledWith("jwt", 1, 10))
  })
})

describe("TeamDetail non-admin gating", () => {
  it("hides project + member management for a non-admin", async () => {
    listMyOrgs.mockResolvedValue([{ id: 1, name: "CAS", role: { level: 100, name: "viewer" } }])
    getTeam.mockResolvedValue({ id: 10, name: "WA", members: [{ userId: 2, username: "anna", roleLevel: 100 }], projects: [{ id: "pa", name: "Bambara", grantedRoleLevel: 400 }] })
    renderDetail()
    await waitFor(() => expect(screen.getByText("Bambara")).toBeInTheDocument())
    expect(screen.queryByRole("button", { name: /attach project/i })).toBeNull()
    expect(screen.queryByRole("button", { name: /detach bambara/i })).toBeNull()
    expect(screen.queryByRole("button", { name: /add member/i })).toBeNull()
    expect(screen.queryByRole("button", { name: /delete team/i })).toBeNull()
  })
})

describe("TeamDetail member role editing (FRO-139)", () => {
  beforeEach(() => {
    addOrgMember.mockResolvedValue({ userId: 2, username: "anna", role: { level: 400, name: "contributor" } })
  })

  it("owner sees a role selector for each member", async () => {
    // Owner (700) must see a combobox to change org-level role — this is what makes permission editing possible.
    listMyOrgs.mockResolvedValue([{ id: 1, name: "CAS", role: { level: 700, name: "owner" } }])
    getTeam.mockResolvedValue({ id: 10, name: "WA", members: [{ userId: 2, username: "anna", roleLevel: 100 }], projects: [] })
    renderDetail()
    await waitFor(() => expect(screen.getByText("anna")).toBeInTheDocument())
    // The role selector for "anna" must be rendered (owner can change roles)
    expect(screen.getByRole("combobox", { name: /role for anna/i })).toBeInTheDocument()
  })

  it("owner changing a member role calls addOrgMember (upsert) with correct args", async () => {
    // Calling addOrgMember on an existing user updates their org role — this is the only role-change API.
    listMyOrgs.mockResolvedValue([{ id: 1, name: "CAS", role: { level: 700, name: "owner" } }])
    getTeam.mockResolvedValue({ id: 10, name: "WA", members: [{ userId: 2, username: "anna", roleLevel: 100 }], projects: [] })
    renderDetail()
    await waitFor(() => expect(screen.getByText("anna")).toBeInTheDocument())
    await pickSelectOption(/role for anna/i, /^contributor$/)
    await waitFor(() => expect(addOrgMember).toHaveBeenCalledWith("jwt", 1, "anna", 400))
  })

  it("maintainer (600) cannot see the role selector — only read-only label with tooltip", async () => {
    // Maintainers can manage teams but only owners can change org-level roles (POST /orgs/:id/members requires 700).
    listMyOrgs.mockResolvedValue([{ id: 1, name: "CAS", role: { level: 600, name: "maintainer" } }])
    getTeam.mockResolvedValue({ id: 10, name: "WA", members: [{ userId: 2, username: "anna", roleLevel: 100 }], projects: [] })
    renderDetail()
    await waitFor(() => expect(screen.getByText("anna")).toBeInTheDocument())
    // No role-change combobox for maintainer
    expect(screen.queryByRole("combobox", { name: /role for anna/i })).toBeNull()
    // Read-only org-level role label with shadcn tooltip is present
    expect(screen.getByLabelText(/org-level role: viewer/i)).toBeInTheDocument()
  })

  it("access level definitions tooltip is present on the Members heading", async () => {
    // The "?" help affordance next to Members heading explains what each level grants — regression guard.
    renderDetail()
    await waitFor(() => expect(screen.getByRole("heading", { name: "WA" })).toBeInTheDocument())
    expect(screen.getByLabelText(/access level definitions/i)).toBeInTheDocument()
  })
})

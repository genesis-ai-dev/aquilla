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
const addTeamMembers = vi.fn()
const removeTeamMember = vi.fn()
const attachProject = vi.fn()
const changeProjectRole = vi.fn()
const detachProject = vi.fn()
vi.mock("@/lib/frontier/teams", () => ({
  getTeam: (...a: unknown[]) => getTeam(...a),
  addTeamMembers: (...a: unknown[]) => addTeamMembers(...a),
  removeTeamMember: (...a: unknown[]) => removeTeamMember(...a),
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
  // which clears the React Query cache on account switch (AQU-212).
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={["/orgs/1/teams/10"]}>
        <OrgProvider>
          <Routes><Route path="/orgs/:orgId/teams/:groupId" element={<TeamDetail />} /></Routes>
        </OrgProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

async function openTeamTab(name: RegExp) {
  // Tabs are only rendered once the team has loaded.
  await waitFor(() => expect(screen.getByRole("tablist", { name: /team sections/i })).toBeInTheDocument())
  await act(async () => {
    screen.getByRole("tab", { name }).click()
  })
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
  addTeamMembers.mockReset()
  addTeamMembers.mockResolvedValue([])
  removeTeamMember.mockResolvedValue(undefined)
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
    await openTeamTab(/^projects$/i)
    await act(async () => { (await screen.findByRole("button", { name: /attach project/i })).click() })
    await pickSelectOption(/project to attach/i, /bambara/i)
    await pickSelectOption(/granted role/i, /contributor/i)
    await act(async () => { screen.getByRole("button", { name: /^attach$/i }).click() })
    await waitFor(() => expect(attachProject).toHaveBeenCalledWith("jwt", 1, 10, "pa", 400))
  })

  it("detaches a project", async () => {
    getTeam.mockResolvedValue({ id: 10, name: "WA", members: [], projects: [{ id: "pa", name: "Bambara", grantedRoleLevel: 400 }] })
    renderDetail()
    await openTeamTab(/^projects$/i)
    await waitFor(() => expect(screen.getByText("Bambara")).toBeInTheDocument())
    await act(async () => { screen.getByRole("button", { name: /actions for bambara/i }).click() })
    await act(async () => { screen.getByRole("menuitem", { name: /detach bambara/i }).click() })
    await waitFor(() => expect(detachProject).toHaveBeenCalledWith("jwt", 1, 10, "pa"))
  })

  it("changes a project grant role via the actions menu dialog", async () => {
    getTeam.mockResolvedValue({ id: 10, name: "WA", members: [], projects: [{ id: "pa", name: "Bambara", grantedRoleLevel: 400 }] })
    changeProjectRole.mockResolvedValue(undefined)
    renderDetail()
    await openTeamTab(/^projects$/i)
    await waitFor(() => expect(screen.getByText("Bambara")).toBeInTheDocument())
    // Role is display-only text — not an inline select.
    expect(screen.queryByRole("combobox", { name: /role for bambara/i })).toBeNull()
    expect(screen.getByText("Contributor")).toBeInTheDocument()
    await act(async () => { screen.getByRole("button", { name: /actions for bambara/i }).click() })
    await act(async () => { screen.getByRole("menuitem", { name: /^change role$/i }).click() })
    await pickSelectOption(/role for bambara/i, /^viewer\b/i)
    await act(async () => { screen.getByRole("button", { name: /^save$/i }).click() })
    await waitFor(() => expect(changeProjectRole).toHaveBeenCalledWith("jwt", 1, 10, "pa", 100))
  })
})

describe("TeamDetail admin management", () => {
  it("multi-selects several org members and adds them in ONE batch request (AQU-735)", async () => {
    addTeamMembers.mockResolvedValue([
      { username: "Ben", ok: true },
      { username: "zara", ok: true },
    ])
    renderDetail()
    await openTeamTab(/^members$/i)
    await waitFor(() => expect(screen.getByText("anna")).toBeInTheDocument())
    await act(async () => { (await screen.findByRole("button", { name: /add (a )?member/i })).click() })
    const picker = screen.getByRole("combobox", { name: /members to add/i })
    expect(picker).toHaveTextContent("Select members…")
    fireEvent.click(picker)
    // anna is already in the team — never offered as an option.
    expect(screen.queryByRole("option", { name: /^anna$/ })).toBeNull()
    // Select Ben, then narrow the search to zara — Ben must stay staged on the trigger.
    fireEvent.click(await screen.findByRole("option", { name: /^Ben$/ }))
    expect(picker).toHaveTextContent("Ben")
    fireEvent.change(screen.getByRole("combobox", { name: /search members/i }), {
      target: { value: "za" },
    })
    expect(screen.queryByRole("option", { name: /^Ben$/ })).toBeNull()
    expect(picker).toHaveTextContent("Ben")
    fireEvent.click(await screen.findByRole("option", { name: /^zara$/ }))
    await act(async () => { screen.getByRole("button", { name: /^add$/i }).click() })
    // ONE batch call carrying both usernames — no client-side fan-out.
    await waitFor(() => expect(addTeamMembers).toHaveBeenCalledTimes(1))
    expect(addTeamMembers).toHaveBeenCalledWith("jwt", 1, 10, ["Ben", "zara"])
  })

  it("Add is disabled until someone is staged, and deselecting the last member re-disables it", async () => {
    renderDetail()
    await openTeamTab(/^members$/i)
    await waitFor(() => expect(screen.getByText("anna")).toBeInTheDocument())
    await act(async () => { (await screen.findByRole("button", { name: /add (a )?member/i })).click() })
    expect(screen.getByRole("button", { name: /^add$/i })).toBeDisabled()
    fireEvent.click(screen.getByRole("combobox", { name: /members to add/i }))
    fireEvent.click(await screen.findByRole("option", { name: /^Ben$/ }))
    expect(screen.getByRole("button", { name: /^add$/i })).toBeEnabled()
    // Toggle Ben off again (same checkbox option).
    fireEvent.click(screen.getByRole("option", { name: /^Ben$/ }))
    expect(screen.getByRole("button", { name: /^add$/i })).toBeDisabled()
    expect(addTeamMembers).not.toHaveBeenCalled()
  })

  it("reports partial failure per person: valid grants land, the failure is named and kept staged", async () => {
    addTeamMembers.mockResolvedValue([
      { username: "Ben", ok: true },
      { username: "zara", ok: false, error: { code: "not_org_member", message: "not an org member" } },
    ])
    renderDetail()
    await openTeamTab(/^members$/i)
    await waitFor(() => expect(screen.getByText("anna")).toBeInTheDocument())
    await act(async () => { (await screen.findByRole("button", { name: /add (a )?member/i })).click() })
    const picker = screen.getByRole("combobox", { name: /members to add/i })
    fireEvent.click(picker)
    fireEvent.click(await screen.findByRole("option", { name: /^Ben$/ }))
    fireEvent.click(await screen.findByRole("option", { name: /^zara$/ }))
    await act(async () => { screen.getByRole("button", { name: /^add$/i }).click() })
    await waitFor(() =>
      expect(screen.getByText(/zara \(not an org member\)/)).toBeInTheDocument(),
    )
    // zara (failed) stays staged for a retry; Ben (succeeded) is dropped.
    expect(picker).toHaveTextContent("zara")
    expect(picker).not.toHaveTextContent("Ben")
  })

  it("removes a member", async () => {
    renderDetail()
    await openTeamTab(/^members$/i)
    await waitFor(() => expect(screen.getByText("anna")).toBeInTheDocument())
    await act(async () => { (await screen.findByRole("button", { name: /actions for anna/i })).click() })
    await act(async () => { (await screen.findByRole("menuitem", { name: /remove from team/i })).click() })
    await waitFor(() => expect(removeTeamMember).toHaveBeenCalledWith("jwt", 1, 10, 2))
  })

  it("links admins to team settings", async () => {
    renderDetail()
    await waitFor(() => expect(screen.getByRole("heading", { name: "WA" })).toBeInTheDocument())
    const settings = screen.getByRole("link", { name: /team settings/i })
    expect(settings).toHaveAttribute("href", "/orgs/1/teams/10/settings")
  })

  it("omits the description element when the team has none", async () => {
    getTeam.mockResolvedValue({
      id: 10,
      name: "WA",
      description: "   ",
      members: [],
      projects: [],
    })
    renderDetail()
    await waitFor(() => expect(screen.getByRole("heading", { name: "WA" })).toBeInTheDocument())
    const title = screen.getByRole("heading", { name: "WA" })
    expect(title.nextElementSibling).toBeNull()
  })

  it("renders the description under the title when present", async () => {
    getTeam.mockResolvedValue({
      id: 10,
      name: "WA",
      description: "West Africa translation",
      members: [],
      projects: [],
    })
    renderDetail()
    await waitFor(() => expect(screen.getByRole("heading", { name: "WA" })).toBeInTheDocument())
    expect(screen.getByText("West Africa translation")).toBeInTheDocument()
  })
})

describe("TeamDetail non-admin gating", () => {
  it("hides project + member management for a non-admin", async () => {
    listMyOrgs.mockResolvedValue([{ id: 1, name: "CAS", role: { level: 100, name: "viewer" } }])
    getTeam.mockResolvedValue({ id: 10, name: "WA", members: [{ userId: 2, username: "anna", roleLevel: 100 }], projects: [{ id: "pa", name: "Bambara", grantedRoleLevel: 400 }] })
    renderDetail()
    await openTeamTab(/^projects$/i)
    await waitFor(() => expect(screen.getByText("Bambara")).toBeInTheDocument())
    expect(screen.queryByRole("button", { name: /attach project/i })).toBeNull()
    expect(screen.queryByRole("button", { name: /actions for bambara/i })).toBeNull()
    expect(screen.queryByRole("combobox", { name: /role for bambara/i })).toBeNull()
    expect(screen.getByText("Contributor")).toBeInTheDocument()
    await openTeamTab(/^members$/i)
    expect(screen.queryByRole("button", { name: /add (a )?member/i })).toBeNull()
    expect(screen.queryByRole("link", { name: /team settings/i })).toBeNull()
  })

  // AQU-789: a non-maintainer who can view a team (they're a member) must see a
  // DISABLED Remove affordance explaining who may remove, not a missing control.
  it("shows a disabled Remove control with an explanation for a non-admin", async () => {
    listMyOrgs.mockResolvedValue([{ id: 1, name: "CAS", role: { level: 100, name: "viewer" } }])
    getTeam.mockResolvedValue({ id: 10, name: "WA", members: [{ userId: 2, username: "anna", roleLevel: 100 }], projects: [] })
    renderDetail()
    await openTeamTab(/^members$/i)
    await waitFor(() => expect(screen.getByText("anna")).toBeInTheDocument())
    // No actionable (enabled) remove button for a non-admin…
    expect(screen.queryByRole("button", { name: /remove anna/i })).toBeNull()
    // …but the control is present, disabled, and labelled with the reason.
    const disabled = screen.getByLabelText(/remove anna — maintainers only/i)
    expect(disabled).toHaveAttribute("aria-disabled", "true")
    // It's an inert affordance, not an actionable button.
    expect(disabled.tagName).toBe("SPAN")
  })
})

describe("TeamDetail member role editing (AQU-139)", () => {
  beforeEach(() => {
    addOrgMember.mockResolvedValue({ userId: 2, username: "anna", role: { level: 400, name: "contributor" } })
  })

  it("owner sees a Change role action that opens a role dialog", async () => {
    // Owner (700) changes org-level roles via the row menu → dialog — not an inline select.
    listMyOrgs.mockResolvedValue([{ id: 1, name: "CAS", role: { level: 700, name: "owner" } }])
    getTeam.mockResolvedValue({ id: 10, name: "WA", members: [{ userId: 2, username: "anna", roleLevel: 100 }], projects: [] })
    renderDetail()
    await openTeamTab(/^members$/i)
    await waitFor(() => expect(screen.getByText("anna")).toBeInTheDocument())
    // Role column shows the current role as plain text, not a combobox.
    expect(screen.queryByRole("combobox", { name: /role for anna/i })).toBeNull()
    expect(screen.getByText("Viewer")).toBeInTheDocument()
    await act(async () => { (await screen.findByRole("button", { name: /actions for anna/i })).click() })
    await act(async () => { (await screen.findByRole("menuitem", { name: /change role/i })).click() })
    expect(screen.getByRole("dialog", { name: /change role for anna/i })).toBeInTheDocument()
    expect(screen.getByRole("combobox", { name: /role for anna/i })).toBeInTheDocument()
  })

  it("owner changing a member role via the dialog calls addOrgMember (upsert) with correct args", async () => {
    // Calling addOrgMember on an existing user updates their org role — this is the only role-change API.
    listMyOrgs.mockResolvedValue([{ id: 1, name: "CAS", role: { level: 700, name: "owner" } }])
    getTeam.mockResolvedValue({ id: 10, name: "WA", members: [{ userId: 2, username: "anna", roleLevel: 100 }], projects: [] })
    renderDetail()
    await openTeamTab(/^members$/i)
    await waitFor(() => expect(screen.getByText("anna")).toBeInTheDocument())
    await act(async () => { (await screen.findByRole("button", { name: /actions for anna/i })).click() })
    await act(async () => { (await screen.findByRole("menuitem", { name: /change role/i })).click() })
    await pickSelectOption(/role for anna/i, /contributor/i)
    await act(async () => { screen.getByRole("button", { name: /^save$/i }).click() })
    await waitFor(() => expect(addOrgMember).toHaveBeenCalledWith("jwt", 1, "anna", 400))
  })

  it("maintainer (600) cannot see Change role — only read-only role text with tooltip", async () => {
    // Maintainers can manage teams but only owners can change org-level roles (POST /orgs/:id/members requires 700).
    listMyOrgs.mockResolvedValue([{ id: 1, name: "CAS", role: { level: 600, name: "maintainer" } }])
    getTeam.mockResolvedValue({ id: 10, name: "WA", members: [{ userId: 2, username: "anna", roleLevel: 100 }], projects: [] })
    renderDetail()
    await openTeamTab(/^members$/i)
    await waitFor(() => expect(screen.getByText("anna")).toBeInTheDocument())
    // No role-change combobox for maintainer
    expect(screen.queryByRole("combobox", { name: /role for anna/i })).toBeNull()
    // Read-only org-level role label with shadcn tooltip is present
    expect(screen.getByLabelText(/org-level role: viewer/i)).toBeInTheDocument()
    await act(async () => { (await screen.findByRole("button", { name: /actions for anna/i })).click() })
    expect(screen.queryByRole("menuitem", { name: /change role/i })).toBeNull()
  })
})

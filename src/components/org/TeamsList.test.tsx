import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { OrgProvider } from "@/context/OrgContext"
import { TeamsList } from "./TeamsList"

vi.mock("@/hooks/useFrontierSession", () => ({ useFrontierSession: () => ({ session: { jwt: "jwt", username: "anna", createdAt: "x" }, loading: false }) }))
const listMyOrgs = vi.fn()
vi.mock("@/lib/frontier/orgs", () => ({ listMyOrgs: (...a: unknown[]) => listMyOrgs(...a) }))
vi.mock("@/components/AccountSwitcher", () => ({ AccountSwitcher: () => null }))
const listTeams = vi.fn()
const createTeam = vi.fn()
vi.mock("@/lib/frontier/teams", () => ({
  listTeams: (...a: unknown[]) => listTeams(...a),
  getTeam: vi.fn(),
  createTeam: (...a: unknown[]) => createTeam(...a),
}))

const makeTeam = (overrides: Partial<{ id: number; name: string; memberCount: number; projectCount: number; viewerIsMember: boolean; isInternal: boolean }> = {}) => ({
  id: 10,
  name: "West Africa",
  memberCount: 2,
  projectCount: 1,
  viewerIsMember: true,
  isInternal: true,
  ...overrides,
})

beforeEach(() => {
  localStorage.clear()
  listTeams.mockReset()
  createTeam.mockReset()
  listMyOrgs.mockResolvedValue([{ id: 7, name: "Come and See", role: { level: 700, name: "owner" } }])
})
afterEach(() => vi.restoreAllMocks())

describe("TeamsList", () => {
  it("lists the active org's teams", async () => {
    listTeams.mockResolvedValue([makeTeam()])
    render(<MemoryRouter><OrgProvider><TeamsList /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByText("West Africa")).toBeInTheDocument())
    expect(listTeams).toHaveBeenCalledWith("jwt", 7)
  })
  it("shows an empty state when there are no teams", async () => {
    listTeams.mockResolvedValue([])
    render(<MemoryRouter><OrgProvider><TeamsList /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByText(/no teams/i)).toBeInTheDocument())
  })
})

describe("TeamsList admin create", () => {
  it("shows New team for an org admin and creates a team", async () => {
    listMyOrgs.mockResolvedValue([{ id: 1, name: "CAS", role: { level: 700, name: "owner" } }])
    listTeams.mockResolvedValue([])
    createTeam.mockResolvedValue({ id: 99, name: "West Africa", description: null })
    render(<MemoryRouter><OrgProvider><TeamsList /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByText(/no teams/i)).toBeInTheDocument())
    await act(async () => { screen.getByRole("button", { name: /new team/i }).click() })
    await act(async () => { fireEvent.change(screen.getByPlaceholderText(/team name/i), { target: { value: "West Africa" } }) })
    await act(async () => { screen.getByRole("button", { name: /^create$/i }).click() })
    await waitFor(() => expect(createTeam).toHaveBeenCalledWith("jwt", 1, "West Africa", undefined))
  })

  it("hides New team for a non-admin", async () => {
    listMyOrgs.mockResolvedValue([{ id: 1, name: "CAS", role: { level: 100, name: "viewer" } }])
    listTeams.mockResolvedValue([])
    render(<MemoryRouter><OrgProvider><TeamsList /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByText(/no teams/i)).toBeInTheDocument())
    expect(screen.queryByRole("button", { name: /new team/i })).toBeNull()
  })
})

describe("TeamsList group filter toggle — regression guards", () => {
  /**
   * WHY: The toggle exists so managers can see org-private (internal) groups
   * separately from publicly-visible groups. Mixing them in one list makes it
   * hard to audit who has access to what. Each position must correctly restrict
   * the list — a bug that lets a public group appear in "internal only" (or
   * vice versa) would break the access audit flow.
   */
  const internalTeam = makeTeam({ id: 1, name: "Internal Team", isInternal: true })
  const publicTeam = makeTeam({ id: 2, name: "Public Team", isInternal: false })

  it("defaults to 'Internal only' — shows internal groups, hides public groups", async () => {
    listTeams.mockResolvedValue([internalTeam, publicTeam])
    render(<MemoryRouter><OrgProvider><TeamsList /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByText("Internal Team")).toBeInTheDocument())
    expect(screen.queryByText("Public Team")).toBeNull()
  })

  it("'All' position shows both internal and public groups", async () => {
    listTeams.mockResolvedValue([internalTeam, publicTeam])
    render(<MemoryRouter><OrgProvider><TeamsList /></OrgProvider></MemoryRouter>)
    await waitFor(() => screen.getByRole("button", { name: /^all$/i }))
    await act(async () => { screen.getByRole("button", { name: /^all$/i }).click() })
    expect(screen.getByText("Internal Team")).toBeInTheDocument()
    expect(screen.getByText("Public Team")).toBeInTheDocument()
  })

  it("'Public only' position shows public groups, hides internal groups", async () => {
    listTeams.mockResolvedValue([internalTeam, publicTeam])
    render(<MemoryRouter><OrgProvider><TeamsList /></OrgProvider></MemoryRouter>)
    await waitFor(() => screen.getByRole("button", { name: /^public only$/i }))
    await act(async () => { screen.getByRole("button", { name: /^public only$/i }).click() })
    expect(screen.getByText("Public Team")).toBeInTheDocument()
    expect(screen.queryByText("Internal Team")).toBeNull()
  })

  it("'Internal only' position (explicit click) shows internal, hides public", async () => {
    listTeams.mockResolvedValue([internalTeam, publicTeam])
    render(<MemoryRouter><OrgProvider><TeamsList /></OrgProvider></MemoryRouter>)
    await waitFor(() => screen.getByRole("button", { name: /^all$/i }))
    // Navigate to "All" first, then back to "Internal only" to confirm the toggle works bidirectionally
    await act(async () => { screen.getByRole("button", { name: /^all$/i }).click() })
    await act(async () => { screen.getByRole("button", { name: /^internal only$/i }).click() })
    expect(screen.getByText("Internal Team")).toBeInTheDocument()
    expect(screen.queryByText("Public Team")).toBeNull()
  })
})

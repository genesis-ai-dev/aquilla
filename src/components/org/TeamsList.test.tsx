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

beforeEach(() => {
  localStorage.clear()
  listTeams.mockReset()
  createTeam.mockReset()
  listMyOrgs.mockResolvedValue([{ id: 7, name: "Come and See", role: { level: 700, name: "owner" } }])
})
afterEach(() => vi.restoreAllMocks())

describe("TeamsList", () => {
  it("lists the active org's teams", async () => {
    listTeams.mockResolvedValue([{ id: 10, name: "West Africa", memberCount: 2, projectCount: 1, viewerIsMember: true }])
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

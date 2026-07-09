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

// Drive the shadcn (Base UI) Select: open the trigger, hover-highlight the
// option, commit with Enter fired on the option itself. Under happy-dom
// clicking an option does not reliably commit a selection, but the keyboard
// path does (recipe adapted from AssignModal.test.tsx; Enter targets the
// option because outside a Dialog focus may never enter the popup).
// Waits for the trigger to render the chosen option's label.
async function pickSelectOption(triggerName: RegExp, optionName: RegExp) {
  const trigger = screen.getByRole("combobox", { name: triggerName })
  fireEvent.click(trigger)
  const option = await screen.findByRole("option", { name: optionName })
  const label = option.textContent ?? ""
  fireEvent.pointerMove(option)
  fireEvent.mouseMove(option)
  fireEvent.keyDown(option, { key: "Enter" })
  await waitFor(() => expect(trigger.textContent).toContain(label))
}

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

describe("TeamsList — AQU-333: internal/public visibility toggle", () => {
  /**
   * WHY: AQU-333 (re-scoping FRO-142) reintroduces a three-position
   * All / Internal only / Public only filter, defaulting to "Internal only"
   * to preserve the historical "shows internal groups only" default render.
   *
   * The FRO-158/FRO-165 regression guarantee — public teams (isInternal ===
   * false) must NOT be silently dropped — is preserved and re-expressed here
   * *through the toggle*: public teams are always reachable via "All" and
   * "Public only". The earlier unconditional "show all by default" assertion
   * is intentionally replaced (not deleted) because the default now filters.
   */
  const internalTeam = makeTeam({ id: 1, name: "Internal Team", isInternal: true })
  const publicTeam = makeTeam({ id: 2, name: "Public Team", isInternal: false })

  it("renders the three-position toggle and defaults to Internal only", async () => {
    listTeams.mockResolvedValue([internalTeam, publicTeam])
    render(<MemoryRouter><OrgProvider><TeamsList /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByText("Internal Team")).toBeInTheDocument())
    // Toggle controls exist alongside search + sort.
    expect(screen.getByRole("button", { name: /^all$/i })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /internal only/i })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /public only/i })).toBeInTheDocument()
    // Default is Internal only (pressed), so the public team is hidden.
    expect(screen.getByRole("button", { name: /internal only/i })).toHaveAttribute("aria-pressed", "true")
    expect(screen.queryByText("Public Team")).toBeNull()
  })

  it("FRO-158 guard: public teams stay reachable via All and Public only", async () => {
    listTeams.mockResolvedValue([internalTeam, publicTeam])
    render(<MemoryRouter><OrgProvider><TeamsList /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByText("Internal Team")).toBeInTheDocument())
    // All → both internal and public appear.
    fireEvent.click(screen.getByRole("button", { name: /^all$/i }))
    await waitFor(() => expect(screen.getByText("Public Team")).toBeInTheDocument())
    expect(screen.getByText("Internal Team")).toBeInTheDocument()
    // Public only → just the public team.
    fireEvent.click(screen.getByRole("button", { name: /public only/i }))
    await waitFor(() => expect(screen.queryByText("Internal Team")).toBeNull())
    expect(screen.getByText("Public Team")).toBeInTheDocument()
  })

  it("empty state when a filter excludes everything, with Clear to reset", async () => {
    listTeams.mockResolvedValue([internalTeam])
    render(<MemoryRouter><OrgProvider><TeamsList /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByText("Internal Team")).toBeInTheDocument())
    fireEvent.click(screen.getByRole("button", { name: /public only/i }))
    await waitFor(() => expect(screen.queryByText("Internal Team")).toBeNull())
    expect(screen.getByText(/no public teams/i)).toBeInTheDocument()
    // Clear resets the filter (to All) and the team reappears — no crash/stale list.
    fireEvent.click(screen.getByRole("button", { name: /clear/i }))
    await waitFor(() => expect(screen.getByText("Internal Team")).toBeInTheDocument())
  })

  it("filter composes with search (Public only + a search term)", async () => {
    const publicAlpha = makeTeam({ id: 3, name: "Public Alpha", isInternal: false })
    const publicBeta = makeTeam({ id: 4, name: "Public Beta", isInternal: false })
    listTeams.mockResolvedValue([internalTeam, publicAlpha, publicBeta])
    render(<MemoryRouter><OrgProvider><TeamsList /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByText("Internal Team")).toBeInTheDocument())
    fireEvent.click(screen.getByRole("button", { name: /public only/i }))
    await waitFor(() => expect(screen.queryByText("Internal Team")).toBeNull())
    fireEvent.change(screen.getByPlaceholderText("Search teams…"), { target: { value: "Alpha" } })
    await waitFor(() => expect(screen.getByText("Public Alpha")).toBeInTheDocument())
    expect(screen.queryByText("Public Beta")).toBeNull()
    expect(screen.queryByText("Internal Team")).toBeNull()
  })
})

describe("TeamsList — FRO-166: search + sort", () => {
  const teams = [
    makeTeam({ id: 1, name: "Alpha", memberCount: 5, projectCount: 2 }),
    makeTeam({ id: 2, name: "beta", memberCount: 10, projectCount: 1 }),
    makeTeam({ id: 3, name: "Gamma", memberCount: 3, projectCount: 8 }),
  ]

  it("default sort is Name A–Z (case-insensitive)", async () => {
    listTeams.mockResolvedValue(teams)
    render(<MemoryRouter><OrgProvider><TeamsList /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByText("Alpha")).toBeInTheDocument())
    const names = screen.getAllByText(/alpha|beta|gamma/i).map((el) => el.textContent)
    expect(names).toEqual(["Alpha", "beta", "Gamma"])
  })

  it("search narrows list by name (case-insensitive substring)", async () => {
    listTeams.mockResolvedValue(teams)
    render(<MemoryRouter><OrgProvider><TeamsList /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByPlaceholderText("Search teams…")).toBeInTheDocument())
    // "lph" matches "Alpha" only
    fireEvent.change(screen.getByPlaceholderText("Search teams…"), { target: { value: "lph" } })
    await waitFor(() => expect(screen.getByText("Alpha")).toBeInTheDocument())
    expect(screen.queryByText("beta")).toBeNull()
    expect(screen.queryByText("Gamma")).toBeNull()
  })

  it("sort by Members (most first) reorders correctly", async () => {
    listTeams.mockResolvedValue(teams)
    render(<MemoryRouter><OrgProvider><TeamsList /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByRole("combobox", { name: /sort teams by/i })).toBeInTheDocument())
    await pickSelectOption(/sort teams by/i, /members \(most first\)/i)
    const cards = screen.getAllByRole("button").filter((b) => ["Alpha", "beta", "Gamma"].includes(b.querySelector("span")?.textContent ?? ""))
    expect(cards[0].querySelector("span")?.textContent).toBe("beta")   // 10
    expect(cards[1].querySelector("span")?.textContent).toBe("Alpha")  // 5
    expect(cards[2].querySelector("span")?.textContent).toBe("Gamma")  // 3
  })

  it("sort by Projects (most first) reorders correctly", async () => {
    listTeams.mockResolvedValue(teams)
    render(<MemoryRouter><OrgProvider><TeamsList /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByRole("combobox", { name: /sort teams by/i })).toBeInTheDocument())
    await pickSelectOption(/sort teams by/i, /projects \(most first\)/i)
    const cards = screen.getAllByRole("button").filter((b) => ["Alpha", "beta", "Gamma"].includes(b.querySelector("span")?.textContent ?? ""))
    expect(cards[0].querySelector("span")?.textContent).toBe("Gamma")  // 8
    expect(cards[1].querySelector("span")?.textContent).toBe("Alpha")  // 2
    expect(cards[2].querySelector("span")?.textContent).toBe("beta")   // 1
  })

  it("no-results state shows message and Clear resets search", async () => {
    listTeams.mockResolvedValue(teams)
    render(<MemoryRouter><OrgProvider><TeamsList /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByPlaceholderText("Search teams…")).toBeInTheDocument())
    fireEvent.change(screen.getByPlaceholderText("Search teams…"), { target: { value: "zzz" } })
    await waitFor(() => expect(screen.getByText(/no teams match/i)).toBeInTheDocument())
    expect(screen.getByRole("button", { name: /clear/i })).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: /clear/i }))
    await waitFor(() => expect(screen.getByText("Alpha")).toBeInTheDocument())
    expect(screen.queryByText(/no teams match/i)).toBeNull()
  })

  it("empty-org state shows 'No teams in this org yet.' (no search bar)", async () => {
    listTeams.mockResolvedValue([])
    render(<MemoryRouter><OrgProvider><TeamsList /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByText(/no teams in this org yet/i)).toBeInTheDocument())
    expect(screen.queryByPlaceholderText("Search teams…")).toBeNull()
  })
})

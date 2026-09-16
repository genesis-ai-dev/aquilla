import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { OrgProvider } from "@/context/OrgContext"
import { TeamsList } from "./TeamsList"

// AQU-1277: OrgSidebar's useOrgSettings fetches /api/v2/orgs/:id/settings.
// fetchOrgSettings swallows its own failures and returns null, so unmocked it
// silently hit production identity while the tests still passed. null is what
// these tests already observed, so behaviour here is unchanged.
vi.mock("@/lib/sync/org-settings", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/sync/org-settings")>()),
  fetchOrgSettings: vi.fn(async () => null),
}))

vi.mock("@/hooks/useFrontierSession", () => ({ useFrontierSession: () => ({ session: { jwt: "jwt", username: "anna", createdAt: "x" }, loading: false }) }))
const listMyOrgs = vi.fn()
vi.mock("@/lib/frontier/orgs", () => ({ listMyOrgs: (...a: unknown[]) => listMyOrgs(...a) }))
vi.mock("@/components/AccountSwitcher", () => ({ AccountSwitcher: () => null }))
vi.mock("@/lib/sync/cloud-projects", () => ({
  fetchAccessibleProjectsResult: vi.fn(async () => ({ ok: true as const, projects: [] })),
}))
const listTeamsPage = vi.fn()
const createTeam = vi.fn()
vi.mock("@/lib/frontier/teams", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/frontier/teams")>()
  return {
    ...actual,
    listTeamsPage: (...a: unknown[]) => listTeamsPage(...a),
    getTeam: vi.fn(),
    createTeam: (...a: unknown[]) => createTeam(...a),
  }
})

const makeTeam = (overrides: Partial<{ id: number; name: string; memberCount: number; projectCount: number; viewerIsMember: boolean; isInternal: boolean }> = {}) => ({
  id: 10,
  name: "West Africa",
  memberCount: 2,
  projectCount: 1,
  viewerIsMember: true,
  isInternal: true,
  ...overrides,
})

function mockDirectory(allTeams: ReturnType<typeof makeTeam>[]) {
  listTeamsPage.mockImplementation(async (
    _jwt: string,
    _orgId: number,
    opts: { q?: string; visibility?: string } = {},
  ) => {
    let groups = allTeams
    if (opts.visibility === "internal") groups = groups.filter((t) => t.isInternal)
    if (opts.visibility === "public") groups = groups.filter((t) => !t.isInternal)
    const q = (opts.q ?? "").trim().toLowerCase()
    if (q) groups = groups.filter((t) => t.name.toLowerCase().includes(q))
    return { groups, nextCursor: null }
  })
}

beforeEach(() => {
  localStorage.clear()
  listTeamsPage.mockReset()
  createTeam.mockReset()
  mockDirectory([])
  listMyOrgs.mockResolvedValue([{ id: 7, name: "Come and See", role: { level: 700, name: "owner" } }])
})
afterEach(() => {
  // Keep promise-returning defaults alive until Testing Library has unmounted
  // effects from the rendered tree. beforeEach performs the full reset.
  listTeamsPage.mockClear()
  createTeam.mockClear()
})

describe("TeamsList", () => {
  it("lists the active org's teams", async () => {
    mockDirectory([makeTeam()])
    render(<MemoryRouter><OrgProvider><TeamsList /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByText("West Africa")).toBeInTheDocument())
    expect(listTeamsPage).toHaveBeenCalledWith(
      "jwt",
      7,
      expect.objectContaining({ visibility: "internal" }),
    )
  })
  it("shows an empty state when there are no teams", async () => {
    mockDirectory([])
    render(<MemoryRouter><OrgProvider><TeamsList /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByText(/no internal teams/i)).toBeInTheDocument())
  })
  it("keeps rows visible and shows an in-field spinner while search is in flight", async () => {
    mockDirectory([makeTeam()])
    render(<MemoryRouter><OrgProvider><TeamsList /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByText("West Africa")).toBeInTheDocument())
    fireEvent.change(screen.getByPlaceholderText("Search teams…"), { target: { value: "zzz" } })
    expect(screen.getByText("West Africa")).toBeInTheDocument()
    expect(screen.getByRole("status", { name: /searching/i })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText(/no teams match/i)).toBeInTheDocument())
  })
  it("renders the load-more sentinel when another page remains", async () => {
    listTeamsPage.mockResolvedValue({
      groups: [makeTeam()],
      nextCursor: "10:West%20Africa",
    })
    render(<MemoryRouter><OrgProvider><TeamsList /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByText("West Africa")).toBeInTheDocument())
    expect(screen.getByTestId("team-directory-load-more")).toBeInTheDocument()
  })
})

describe("TeamsList admin create", () => {
  it("shows New team for an org admin and creates a team", async () => {
    listMyOrgs.mockResolvedValue([{ id: 1, name: "CAS", role: { level: 700, name: "owner" } }])
    mockDirectory([])
    createTeam.mockResolvedValue({ id: 99, name: "West Africa", description: null })
    render(<MemoryRouter><OrgProvider><TeamsList /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByText(/no internal teams/i)).toBeInTheDocument())
    await waitFor(() => expect(screen.getByRole("button", { name: /new team/i })).toBeInTheDocument())
    await act(async () => { screen.getByRole("button", { name: /new team/i }).click() })
    await act(async () => { fireEvent.change(screen.getByPlaceholderText(/team name/i), { target: { value: "West Africa" } }) })
    await act(async () => { screen.getByRole("button", { name: /^create$/i }).click() })
    await waitFor(() => expect(createTeam).toHaveBeenCalledWith("jwt", 1, "West Africa", undefined))
  })

  it("hides New team for a non-admin", async () => {
    listMyOrgs.mockResolvedValue([{ id: 1, name: "CAS", role: { level: 100, name: "viewer" } }])
    mockDirectory([])
    render(<MemoryRouter><OrgProvider><TeamsList /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByText(/no internal teams/i)).toBeInTheDocument())
    expect(screen.queryByRole("button", { name: /new team/i })).toBeNull()
  })
})

describe("TeamsList — AQU-333: internal/public visibility select", () => {
  /**
   * WHY: AQU-333 (re-scoping AQU-142) reintroduces a three-position
   * All / Internal only / Public only filter, defaulting to "Internal only"
   * to preserve the historical "shows internal groups only" default render.
   *
   * The AQU-158/AQU-165 regression guarantee — public teams (isInternal ===
   * false) must NOT be silently dropped — is preserved and re-expressed here
   * *through the select*: public teams are always reachable via "All" and
   * "Public only". The earlier unconditional "show all by default" assertion
   * is intentionally replaced (not deleted) because the default now filters.
   */
  const internalTeam = makeTeam({ id: 1, name: "Internal Team", isInternal: true })
  const publicTeam = makeTeam({ id: 2, name: "Public Team", isInternal: false })

  /** Base UI Select: options live in a portaled listbox. */
  async function pickVisibility(optionName: RegExp) {
    fireEvent.click(screen.getByRole("combobox", { name: /filter teams by visibility/i }))
    const option = await screen.findByRole("option", { name: optionName })
    fireEvent.pointerMove(option)
    fireEvent.mouseMove(option)
    fireEvent.keyDown(document.activeElement ?? option, { key: "Enter" })
    await waitFor(() => {
      expect(screen.queryByRole("listbox")).toBeNull()
    })
  }

  it("renders the visibility select and defaults to Internal only", async () => {
    mockDirectory([internalTeam, publicTeam])
    render(<MemoryRouter><OrgProvider><TeamsList /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByText("Internal Team")).toBeInTheDocument())
    const trigger = screen.getByRole("combobox", { name: /filter teams by visibility/i })
    expect(trigger).toBeInTheDocument()
    expect(trigger).toHaveTextContent(/internal only/i)
    // Default is Internal only, so the public team is hidden.
    expect(screen.queryByText("Public Team")).toBeNull()
  })

  it("AQU-158 guard: public teams stay reachable via All and Public only", async () => {
    mockDirectory([internalTeam, publicTeam])
    render(<MemoryRouter><OrgProvider><TeamsList /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByText("Internal Team")).toBeInTheDocument())
    // All → both internal and public appear.
    await pickVisibility(/^all$/i)
    await waitFor(() => expect(screen.getByText("Public Team")).toBeInTheDocument())
    expect(screen.getByText("Internal Team")).toBeInTheDocument()
    // Public only → just the public team.
    await pickVisibility(/public only/i)
    await waitFor(() => expect(screen.queryByText("Internal Team")).toBeNull())
    expect(screen.getByText("Public Team")).toBeInTheDocument()
  })

  it("empty state when a filter excludes everything, with Clear to reset", async () => {
    mockDirectory([internalTeam])
    render(<MemoryRouter><OrgProvider><TeamsList /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByText("Internal Team")).toBeInTheDocument())
    await pickVisibility(/public only/i)
    await waitFor(() => expect(screen.queryByText("Internal Team")).toBeNull())
    expect(screen.getByText(/no public teams/i)).toBeInTheDocument()
    // Search + visibility controls stay mounted even when the filter empties the list.
    expect(screen.getByPlaceholderText("Search teams…")).toBeInTheDocument()
    // Clear resets the filter (to All) and the team reappears — no crash/stale list.
    fireEvent.click(screen.getByRole("button", { name: /clear/i }))
    await waitFor(() => expect(screen.getByText("Internal Team")).toBeInTheDocument())
  })

  it("filter composes with search (Public only + a search term)", async () => {
    const publicAlpha = makeTeam({ id: 3, name: "Public Alpha", isInternal: false })
    const publicBeta = makeTeam({ id: 4, name: "Public Beta", isInternal: false })
    mockDirectory([internalTeam, publicAlpha, publicBeta])
    render(<MemoryRouter><OrgProvider><TeamsList /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByText("Internal Team")).toBeInTheDocument())
    await pickVisibility(/public only/i)
    await waitFor(() => expect(screen.queryByText("Internal Team")).toBeNull())
    fireEvent.change(screen.getByPlaceholderText("Search teams…"), { target: { value: "Alpha" } })
    await waitFor(() => expect(screen.getByText("Public Alpha")).toBeInTheDocument())
    await waitFor(() => {
      expect(screen.queryByText("Public Beta")).toBeNull()
      expect(screen.queryByText("Internal Team")).toBeNull()
    })
  })
})

describe("TeamsList — AQU-166: search + sort", () => {
  const teams = [
    makeTeam({ id: 1, name: "Alpha", memberCount: 5, projectCount: 2 }),
    makeTeam({ id: 2, name: "beta", memberCount: 10, projectCount: 1 }),
    makeTeam({ id: 3, name: "Gamma", memberCount: 3, projectCount: 8 }),
  ]

  function teamNamesInOrder(): string[] {
    const table = screen.getByTestId("org-teams-table")
    return Array.from(table.querySelectorAll('[data-slot="team-name"]'))
      .map((el) => el.textContent ?? "")
      .filter(Boolean)
  }

  async function sortByColumn(title: RegExp, ariaSort: "ascending" | "descending") {
    const header = screen.getByRole("button", { name: title })
    // Text columns: asc ↔ desc. Numeric: desc ↔ asc. Sorting never clears.
    for (let i = 0; i < 3; i++) {
      if (header.getAttribute("aria-sort") === ariaSort) return
      await act(async () => { fireEvent.click(header) })
    }
    expect(header).toHaveAttribute("aria-sort", ariaSort)
  }

  it("default sort is Name A–Z (case-insensitive)", async () => {
    mockDirectory(teams)
    render(<MemoryRouter><OrgProvider><TeamsList /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByText("Alpha")).toBeInTheDocument())
    expect(teamNamesInOrder()).toEqual(["Alpha", "beta", "Gamma"])
  })

  it("search narrows list by name (case-insensitive substring)", async () => {
    mockDirectory(teams)
    render(<MemoryRouter><OrgProvider><TeamsList /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByText("Alpha")).toBeInTheDocument())
    // "lph" matches "Alpha" only
    fireEvent.change(screen.getByPlaceholderText("Search teams…"), { target: { value: "lph" } })
    await waitFor(() => {
      expect(screen.getByText("Alpha")).toBeInTheDocument()
      expect(screen.queryByText("beta")).toBeNull()
      expect(screen.queryByText("Gamma")).toBeNull()
    })
  })

  it("sort by Members (most first) reorders correctly", async () => {
    mockDirectory(teams)
    render(<MemoryRouter><OrgProvider><TeamsList /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByText("Alpha")).toBeInTheDocument())
    await sortByColumn(/^Members$/i, "descending")
    expect(teamNamesInOrder()).toEqual(["beta", "Alpha", "Gamma"])
  })

  it("sort by Projects (most first) reorders correctly", async () => {
    mockDirectory(teams)
    render(<MemoryRouter><OrgProvider><TeamsList /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByText("Alpha")).toBeInTheDocument())
    await sortByColumn(/^Projects$/i, "descending")
    expect(teamNamesInOrder()).toEqual(["Gamma", "Alpha", "beta"])
  })

  it("no-results state shows message and Clear resets search", async () => {
    mockDirectory(teams)
    render(<MemoryRouter><OrgProvider><TeamsList /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByText("Alpha")).toBeInTheDocument())
    fireEvent.change(screen.getByPlaceholderText("Search teams…"), { target: { value: "zzz" } })
    await waitFor(() => expect(screen.getByText(/no teams match/i)).toBeInTheDocument())
    expect(screen.getByRole("button", { name: /clear/i })).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: /clear/i }))
    await waitFor(() => expect(screen.getByText("Alpha")).toBeInTheDocument())
    expect(screen.queryByText(/no teams match/i)).toBeNull()
  })

  it("empty-org state shows 'No teams in this org yet.' with search still available", async () => {
    mockDirectory([])
    render(<MemoryRouter><OrgProvider><TeamsList /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByText(/no internal teams/i)).toBeInTheDocument())
    fireEvent.click(screen.getByRole("button", { name: /clear/i }))
    await waitFor(
      () => {
        expect(screen.getByText(/no teams in this org yet/i)).toBeInTheDocument()
        expect(screen.getByPlaceholderText("Search teams…")).toBeInTheDocument()
        expect(screen.getByRole("combobox", { name: /filter teams by visibility/i })).toBeInTheDocument()
      },
      { timeout: 3000 },
    )
  })
})

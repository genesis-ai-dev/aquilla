// AQU-1042 — viewer-role filter in the org Projects toolbar: data-derived
// options (ladder-ordered), exact-match narrowing, roleless ("—") rows only
// under the all-roles default, and AND-composition with the status filter,
// the PM filter, and the search box. Since AQU-1044 the control lives as the
// Role submenu of the combined Sort by menu (ProjectSortMenu).

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { OrgProvider } from "@/context/OrgContext"
import { OrgProjectsPage } from "./OrgProjectsPage"

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({
    session: { jwt: "jwt", username: "anna", createdAt: "x" },
    loading: false,
  }),
}))
vi.mock("./OrgSidebar", () => ({ OrgSidebar: () => null }))
vi.mock("./OrgSwitcher", () => ({ OrgSwitcher: () => null }))
vi.mock("@/components/AccountSwitcher", () => ({ AccountSwitcher: () => null }))
vi.mock("@/components/HelpMenu", () => ({ HelpMenu: () => null }))
vi.mock("@/components/ProjectCreateDialog", () => ({ ProjectCreateDialog: () => null }))
vi.mock("@/hooks/usePlatformAdmin", () => ({
  usePlatformAdmin: () => ({ isAdmin: false, loading: false }),
}))
vi.mock("@/hooks/useOrgSettings", () => ({
  useOrgSettings: () => ({ allowSelfAssignment: false }),
}))

const listMyOrgs = vi.fn()
vi.mock("@/lib/frontier/orgs", () => ({
  listMyOrgs: (...a: unknown[]) => listMyOrgs(...a),
}))

const fetchAccessibleProjects = vi.fn()
// AQU-1357: partial mock — see src/lib/sync/cloud-projects-mock-guard.test.ts.
vi.mock("@/lib/sync/cloud-projects", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/sync/cloud-projects")>()),
  fetchAccessibleProjectsResult: async (...a: unknown[]) => ({
    ok: true as const,
    projects: await fetchAccessibleProjects(...a),
  }),
  projectsResultError: () => new Error("project load failed"),
}))

const getPortfolio = vi.fn()
vi.mock("@/lib/frontier/portfolio", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/frontier/portfolio")>()
  return {
    ...actual,
    getPortfolio: (...a: unknown[]) => getPortfolio(...a),
    getPortfolioPage: async (_jwt: string, _orgId: number, opts?: { q?: string }) => {
      const projects = (await getPortfolio()) as Array<{ name: string }>
      const q = opts?.q?.trim().toLowerCase() ?? ""
      return {
        projects: q ? projects.filter((p) => p.name.toLowerCase().includes(q)) : projects,
        nextCursor: null,
      }
    },
  }
})

const now = Date.now()
const DAY = 24 * 60 * 60 * 1000

/** Portfolio rows: Gospels (fresh), Ruth (fresh), Acts (fresh), Psalms
 * (30 days stale → Stalled). */
function portfolioRows() {
  return [
    { id: "gospels", name: "Gospels", ...metrics(), lastEditAt: now - DAY },
    { id: "ruth", name: "Ruth", ...metrics(), lastEditAt: now - DAY },
    { id: "acts", name: "Acts", ...metrics(), lastEditAt: now - DAY },
    { id: "psalms", name: "Psalms", ...metrics(), lastEditAt: now - 30 * DAY },
  ]
}

function metrics() {
  return {
    totalCells: 100,
    validatedCells: 0,
    filledCells: 10,
    aiDraftedCells: 0,
    audioCells: 0,
    validatedAudioCells: 0,
    recordedMs: 0,
    deadlineAt: null,
  }
}

const owner = { level: 700, name: "owner", source: "creator" }
const contributor = { level: 400, name: "contributor", source: "member" }

/** Viewer's roles: Gospels + Psalms owner, Ruth contributor, Acts none ("—").
 * PMs: anna on Gospels + Acts, mark on Ruth + Psalms (for composition tests). */
function accessibleRows() {
  return [
    { id: "gospels", name: "Gospels", orgId: 1, role: owner, pm: { id: 5, username: "anna" } },
    { id: "ruth", name: "Ruth", orgId: 1, role: contributor, pm: { id: 6, username: "mark" } },
    { id: "acts", name: "Acts", orgId: 1, role: undefined, pm: { id: 5, username: "anna" } },
    { id: "psalms", name: "Psalms", orgId: 1, role: owner, pm: { id: 6, username: "mark" } },
  ]
}

function renderProjectsPage(entry = "/orgs/1/projects") {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <OrgProvider>
        <Routes>
          <Route path="/orgs/:orgId/projects" element={<OrgProjectsPage />} />
          <Route path="/projects/:id" element={<div>PROJECT OVERVIEW</div>} />
        </Routes>
      </OrgProvider>
    </MemoryRouter>,
  )
}

/**
 * AQU-1044 Sort by menu: open the trigger, open the dimension's submenu,
 * pick the radio option, then dismiss the menu tree so the next
 * interaction starts from a closed menu.
 */
async function pickFilter(category: RegExp, optionName: string | RegExp) {
  fireEvent.click(screen.getByTestId("project-sort-menu"))
  fireEvent.click(await screen.findByRole("menuitem", { name: category }))
  const option = await screen.findByRole("menuitemradio", { name: optionName })
  fireEvent.click(option)
  // An outside pointerdown dismisses the whole menu tree at once (an Escape
  // only closes the innermost submenu), so the next pick starts closed.
  fireEvent.pointerDown(document.body, { button: 0 })
  await waitFor(() => expect(screen.queryAllByRole("menu")).toHaveLength(0))
}

/** Open the Sort by menu and one dimension's submenu, returning its options. */
async function submenuOptions(category: RegExp) {
  fireEvent.click(screen.getByTestId("project-sort-menu"))
  fireEvent.click(await screen.findByRole("menuitem", { name: category }))
  return (await screen.findAllByRole("menuitemradio")).map((el) => el.textContent)
}

function rowNames() {
  return screen
    .getAllByTestId("project-table-name")
    .map((el) => el.textContent)
    .filter((name): name is string => name != null)
}

beforeEach(() => {
  localStorage.clear()
  listMyOrgs.mockReset()
  fetchAccessibleProjects.mockReset()
  getPortfolio.mockReset()
  listMyOrgs.mockResolvedValue([{ id: 1, name: "Come and See", role: owner }])
  fetchAccessibleProjects.mockResolvedValue(accessibleRows())
  getPortfolio.mockResolvedValue(portfolioRows())
})
afterEach(() => vi.clearAllMocks())

describe("org Projects Role filter (AQU-1042)", () => {
  it("offers exactly the roles present, ladder-ordered, plus an all-roles default", async () => {
    renderProjectsPage()
    await screen.findByText("Gospels")

    // Contributor (400) before Owner (700); no option for Acts's missing role.
    expect(await submenuOptions(/^role/i)).toEqual(["All roles", "Contributor", "Owner"])
  })

  it("narrows to the picked role and restores every row when reset to all", async () => {
    renderProjectsPage()
    await screen.findByText("Gospels")

    await pickFilter(/^role/i, "Owner")
    expect(rowNames().sort()).toEqual(["Gospels", "Psalms"])
    expect(screen.queryByText("Ruth")).not.toBeInTheDocument()

    await pickFilter(/^role/i, "All roles")
    expect(rowNames().sort()).toEqual(["Acts", "Gospels", "Psalms", "Ruth"])
  })

  it("keeps roleless ('—') rows under the all default and out of every specific role", async () => {
    renderProjectsPage()
    await screen.findByText("Gospels")

    expect(rowNames().sort()).toEqual(["Acts", "Gospels", "Psalms", "Ruth"])

    await pickFilter(/^role/i, "Contributor")
    expect(rowNames()).toEqual(["Ruth"])
    expect(screen.queryByText("Acts")).not.toBeInTheDocument()
  })

  it("composes with the status filter: only that role's stalled projects remain", async () => {
    renderProjectsPage()
    await screen.findByText("Gospels")

    await pickFilter(/^role/i, "Owner")
    await pickFilter(/^status/i, "Stalled")
    expect(rowNames()).toEqual(["Psalms"])
  })

  // AQU-1027: anna is the mocked viewer, so her PM slice is reached through
  // the pinned "Managed by me" option rather than by name.
  it("composes with the PM filter: role Owner + the viewer's own projects leaves only Gospels", async () => {
    renderProjectsPage()
    await screen.findByText("Gospels")

    await pickFilter(/^role/i, "Owner")
    await pickFilter(/^pm/i, "Managed by me")
    expect(rowNames()).toEqual(["Gospels"])
  })

  it("composes with the search box", async () => {
    renderProjectsPage()
    await screen.findByText("Gospels")

    await pickFilter(/^role/i, "Owner")
    fireEvent.change(screen.getByRole("textbox", { name: /search projects/i }), {
      target: { value: "psal" },
    })
    await waitFor(() => expect(rowNames()).toEqual(["Psalms"]))
  })

  it("shows the table's empty state, not a blank table, when nothing matches", async () => {
    renderProjectsPage()
    await screen.findByText("Gospels")

    await pickFilter(/^role/i, "Contributor")
    await pickFilter(/^status/i, "Stalled")

    expect(screen.queryAllByTestId("project-table-name")).toHaveLength(0)
    const table = screen.getByTestId("org-projects-table")
    expect(within(table).getByText("No matching projects.")).toBeInTheDocument()

    await pickFilter(/^role/i, "All roles")
    expect(rowNames()).toEqual(["Psalms"])
  })

  it("still renders and filters on a guest org, which reuses this table", async () => {
    // Guest rows come from the accessible-project directory, not the member
    // portfolio (which 403s for guests).
    getPortfolio.mockRejectedValue(new Error("guest orgs must not hit the member portfolio"))
    fetchAccessibleProjects.mockResolvedValue([
      {
        id: "guest-a",
        name: "Guest Gospel",
        orgId: 2,
        orgName: "Sunset Bible",
        role: { level: 100, name: "viewer", source: "override" },
        pm: null,
      },
      {
        id: "guest-b",
        name: "Guest Ruth",
        orgId: 2,
        orgName: "Sunset Bible",
        role: { level: 300, name: "reviewer", source: "override" },
        pm: null,
      },
    ])

    renderProjectsPage("/orgs/2/projects")
    await screen.findByText("Guest Gospel")

    await pickFilter(/^role/i, "Reviewer")
    expect(rowNames()).toEqual(["Guest Ruth"])
  })
})

// AQU-1043 — last-edit recency filter in the org Projects toolbar: fixed
// windows with an "any time" default, never-edited ("—") rows only under that
// default, and AND-composition with the status filter, the PM filter, the Role
// filter, and the search box. Since AQU-1044 the control lives as the Updated
// submenu of the combined Sort by menu (ProjectSortMenu).

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
vi.mock("@/lib/sync/cloud-projects", () => ({
  fetchAccessibleProjectsResult: async (...a: unknown[]) => ({
    ok: true as const,
    projects: await fetchAccessibleProjects(...a),
  }),
  projectsResultError: () => new Error("project load failed"),
}))

const getPortfolio = vi.fn()
vi.mock("@/lib/frontier/portfolio", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/frontier/portfolio")>()
  return { ...actual, getPortfolio: (...a: unknown[]) => getPortfolio(...a) }
})

const now = Date.now()
const DAY = 24 * 60 * 60 * 1000

/**
 * The spread the ticket's repro calls for: edited this week (Gospels), a few
 * weeks ago (Ruth — also past the 14-day Stalled threshold), long ago (Acts),
 * and never edited at all (Psalms, whose Updated column reads "—").
 */
function portfolioRows() {
  return [
    { id: "gospels", name: "Gospels", ...metrics(), lastEditAt: now - DAY },
    { id: "ruth", name: "Ruth", ...metrics(), lastEditAt: now - 20 * DAY },
    { id: "acts", name: "Acts", ...metrics(), lastEditAt: now - 200 * DAY },
    { id: "psalms", name: "Psalms", ...metrics(), lastEditAt: null },
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

/** PMs: anna on Gospels + Acts, mark on Ruth + Psalms. Viewer is owner
 * everywhere except Ruth (contributor) — both for the composition tests. */
function accessibleRows() {
  return [
    { id: "gospels", name: "Gospels", orgId: 1, role: owner, pm: { id: 5, username: "anna" } },
    { id: "ruth", name: "Ruth", orgId: 1, role: contributor, pm: { id: 6, username: "mark" } },
    { id: "acts", name: "Acts", orgId: 1, role: owner, pm: { id: 5, username: "anna" } },
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

describe("org Projects Updated filter (AQU-1043)", () => {
  it("offers fixed recency windows and defaults to 'any time'", async () => {
    renderProjectsPage()
    await screen.findByText("Gospels")

    // At the defaults the Sort by trigger carries no active-filter badge.
    expect(screen.queryByTestId("project-sort-menu-count")).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId("project-sort-menu"))
    fireEvent.click(await screen.findByRole("menuitem", { name: /^updated/i }))
    const options = await screen.findAllByRole("menuitemradio")
    expect(options.map((el) => el.textContent)).toEqual([
      "Updated any time",
      "Updated in last 7 days",
      "Updated in last 30 days",
      "Updated in last 90 days",
    ])
    expect(options[0]).toHaveAttribute("aria-checked", "true")
  })

  it("shows every row, never-edited included, under the default", async () => {
    renderProjectsPage()
    await screen.findByText("Gospels")

    expect(rowNames().sort()).toEqual(["Acts", "Gospels", "Psalms", "Ruth"])
  })

  it("narrows to the picked window — the 'touched this week' view the repro lacks", async () => {
    renderProjectsPage()
    await screen.findByText("Gospels")

    await pickFilter(/^updated/i, "Updated in last 7 days")
    expect(rowNames()).toEqual(["Gospels"])

    await pickFilter(/^updated/i, "Updated in last 30 days")
    expect(rowNames().sort()).toEqual(["Gospels", "Ruth"])

    await pickFilter(/^updated/i, "Updated in last 90 days")
    expect(rowNames().sort()).toEqual(["Gospels", "Ruth"])
    expect(screen.queryByText("Acts")).not.toBeInTheDocument()
  })

  it("keeps never-edited ('—') rows out of every window but listed under 'any time'", async () => {
    renderProjectsPage()
    await screen.findByText("Psalms")

    for (const window of [
      "Updated in last 7 days",
      "Updated in last 30 days",
      "Updated in last 90 days",
    ]) {
      await pickFilter(/^updated/i, window)
      expect(screen.queryByText("Psalms")).not.toBeInTheDocument()
    }

    await pickFilter(/^updated/i, "Updated any time")
    expect(rowNames()).toContain("Psalms")
  })

  it("restores the rows when reset to 'any time'", async () => {
    renderProjectsPage()
    await screen.findByText("Gospels")

    await pickFilter(/^updated/i, "Updated in last 7 days")
    expect(rowNames()).toEqual(["Gospels"])

    await pickFilter(/^updated/i, "Updated any time")
    expect(rowNames().sort()).toEqual(["Acts", "Gospels", "Psalms", "Ruth"])
  })

  it("composes with the status filter: Ruth is the only stalled project touched this month", async () => {
    renderProjectsPage()
    await screen.findByText("Gospels")

    await pickFilter(/^updated/i, "Updated in last 30 days")
    await pickFilter(/^status/i, "Stalled")
    expect(rowNames()).toEqual(["Ruth"])
  })

  it("composes with the PM filter", async () => {
    renderProjectsPage()
    await screen.findByText("Gospels")

    // anna is the mocked viewer, so her slice is the pinned "Managed by me"
    // option (AQU-1027). She owns Gospels (1d) and Acts (200d); only Gospels
    // is inside 90 days.
    await pickFilter(/^pm/i, "Managed by me")
    await pickFilter(/^updated/i, "Updated in last 90 days")
    expect(rowNames()).toEqual(["Gospels"])
  })

  it("composes with the Role filter", async () => {
    renderProjectsPage()
    await screen.findByText("Gospels")

    // Viewer is contributor only on Ruth, edited 20 days ago.
    await pickFilter(/^role/i, "Contributor")
    await pickFilter(/^updated/i, "Updated in last 30 days")
    expect(rowNames()).toEqual(["Ruth"])
  })

  it("composes with the search box", async () => {
    renderProjectsPage()
    await screen.findByText("Gospels")

    await pickFilter(/^updated/i, "Updated in last 30 days")
    fireEvent.change(screen.getByRole("textbox", { name: /search projects/i }), {
      target: { value: "ruth" },
    })
    expect(rowNames()).toEqual(["Ruth"])
  })

  it("shows the table's empty state, not a blank table, when nothing matches", async () => {
    renderProjectsPage()
    await screen.findByText("Gospels")

    // Contributor (Ruth only) edited within 7 days — Ruth is 20 days old.
    await pickFilter(/^role/i, "Contributor")
    await pickFilter(/^updated/i, "Updated in last 7 days")

    expect(screen.queryAllByTestId("project-table-name")).toHaveLength(0)
    const table = screen.getByTestId("org-projects-table")
    expect(within(table).getByText("No matching projects.")).toBeInTheDocument()

    await pickFilter(/^updated/i, "Updated any time")
    expect(rowNames()).toEqual(["Ruth"])
  })
})

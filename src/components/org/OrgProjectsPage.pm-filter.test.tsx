// AQU-1040 — dedicated PM filter in the org Projects toolbar: data-derived
// options, exact-match narrowing, Unassigned, and AND-composition with the
// status filter and the search box.

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

/** Portfolio rows: Gospels (anna, fresh), Ruth (mark, fresh), Acts (no PM,
 * 30 days stale → Stalled), Psalms (anna, 30 days stale → Stalled). */
function portfolioRows() {
  return [
    { id: "gospels", name: "Gospels", ...metrics(), lastEditAt: now - DAY },
    { id: "ruth", name: "Ruth", ...metrics(), lastEditAt: now - DAY },
    { id: "acts", name: "Acts", ...metrics(), lastEditAt: now - 30 * DAY },
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

const role = { level: 700, name: "owner", source: "creator" }

function accessibleRows() {
  return [
    { id: "gospels", name: "Gospels", orgId: 1, role, pm: { id: 5, username: "anna" } },
    { id: "ruth", name: "Ruth", orgId: 1, role, pm: { id: 6, username: "mark" } },
    { id: "acts", name: "Acts", orgId: 1, role, pm: null },
    { id: "psalms", name: "Psalms", orgId: 1, role, pm: { id: 5, username: "anna" } },
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

/** Base UI Select: open the trigger, then commit the option under the pointer. */
async function pickOption(triggerName: RegExp, optionName: string | RegExp) {
  fireEvent.click(screen.getByRole("combobox", { name: triggerName }))
  const option = await screen.findByRole("option", { name: optionName })
  fireEvent.pointerMove(option)
  fireEvent.mouseMove(option)
  fireEvent.keyDown(document.activeElement ?? option, { key: "Enter" })
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull())
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
  listMyOrgs.mockResolvedValue([{ id: 1, name: "Come and See", role }])
  fetchAccessibleProjects.mockResolvedValue(accessibleRows())
  getPortfolio.mockResolvedValue(portfolioRows())
})
afterEach(() => vi.clearAllMocks())

describe("org Projects PM filter (AQU-1040)", () => {
  it("offers exactly the loaded PMs plus Unassigned plus an all-PMs default", async () => {
    renderProjectsPage()
    await screen.findByText("Gospels")

    fireEvent.click(screen.getByRole("combobox", { name: /project manager filter/i }))
    const options = (await screen.findAllByRole("option")).map((el) => el.textContent)
    expect(options).toEqual(["All PMs", "anna", "mark", "Unassigned"])
  })

  it("narrows to one PM's projects and restores them when reset to all", async () => {
    renderProjectsPage()
    await screen.findByText("Gospels")

    await pickOption(/project manager filter/i, "anna")
    expect(rowNames().sort()).toEqual(["Gospels", "Psalms"])
    expect(screen.queryByText("Ruth")).not.toBeInTheDocument()

    await pickOption(/project manager filter/i, "All PMs")
    expect(rowNames().sort()).toEqual(["Acts", "Gospels", "Psalms", "Ruth"])
  })

  it("Unassigned leaves only the PM-less project — the case search cannot express", async () => {
    renderProjectsPage()
    await screen.findByText("Gospels")

    await pickOption(/project manager filter/i, "Unassigned")
    expect(rowNames()).toEqual(["Acts"])
  })

  it("composes with the status filter: only that PM's stalled projects remain", async () => {
    renderProjectsPage()
    await screen.findByText("Gospels")

    await pickOption(/project manager filter/i, "anna")
    await pickOption(/project status filter/i, "Stalled")
    expect(rowNames()).toEqual(["Psalms"])
  })

  it("composes with the search box", async () => {
    renderProjectsPage()
    await screen.findByText("Gospels")

    await pickOption(/project manager filter/i, "anna")
    fireEvent.change(screen.getByRole("textbox", { name: /search projects/i }), {
      target: { value: "psal" },
    })
    expect(rowNames()).toEqual(["Psalms"])
  })

  it("shows the table's empty state, not a blank table, when nothing matches", async () => {
    renderProjectsPage()
    await screen.findByText("Gospels")

    await pickOption(/project manager filter/i, "mark")
    await pickOption(/project status filter/i, "Stalled")

    expect(screen.queryAllByTestId("project-table-name")).toHaveLength(0)
    const table = screen.getByTestId("org-projects-table")
    expect(within(table).getByText("No matching projects.")).toBeInTheDocument()
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
        pm: { id: 5, username: "anna" },
      },
      {
        id: "guest-b",
        name: "Guest Ruth",
        orgId: 2,
        orgName: "Sunset Bible",
        role: { level: 100, name: "viewer", source: "override" },
        pm: null,
      },
    ])

    renderProjectsPage("/orgs/2/projects")
    await screen.findByText("Guest Gospel")

    await pickOption(/project manager filter/i, "anna")
    expect(rowNames()).toEqual(["Guest Gospel"])

    await pickOption(/project manager filter/i, "Unassigned")
    expect(rowNames()).toEqual(["Guest Ruth"])
  })

  it("omits Unassigned when every loaded project has a PM", async () => {
    fetchAccessibleProjects.mockResolvedValue(
      accessibleRows().map((p) => (p.pm ? p : { ...p, pm: { id: 6, username: "mark" } })),
    )
    renderProjectsPage()
    await screen.findByText("Gospels")

    fireEvent.click(screen.getByRole("combobox", { name: /project manager filter/i }))
    const options = (await screen.findAllByRole("option")).map((el) => el.textContent)
    expect(options).toEqual(["All PMs", "anna", "mark"])
  })
})

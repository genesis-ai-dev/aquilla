// AQU-2259: the project list never remembered its sort. The table is sorted
// by clicking its column headers, and nothing saved the choice (the only code
// that ever wrote one was the old ProjectsList, no longer shown), so it always
// opened on "Recently updated".
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
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
    // AQU-1071: useOrgPortfolio reads the org rollup through the summary now
    // (rollup + active-language count in one response), so the double lives here.
    getOrgPortfolioSummary: async (...a: unknown[]) => ({
      projects: await getPortfolio(...a),
      activeLanguageCount: 0,
    }),
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

function rowNames() {
  return screen
    .getAllByTestId("project-table-name")
    .map((el) => el.textContent)
    .filter((name): name is string => name != null)
}

function tableSorting() {
  return screen.getAllByRole("table")[0].getAttribute("data-sorting")
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

describe("the project list remembers its sort (AQU-2259)", () => {
  it("opens on Recently updated the first time", async () => {
    renderProjectsPage()
    await screen.findByText("Gospels")
    expect(tableSorting()).toBe("edited:desc")
  })

  it("opens on the column someone last sorted by", async () => {
    const first = renderProjectsPage()
    await screen.findByText("Gospels")
    fireEvent.click(screen.getByRole("button", { name: /^project/i }))
    await waitFor(() => expect(tableSorting()).toBe("name:asc"))
    first.unmount()

    renderProjectsPage()
    await screen.findByText("Gospels")
    expect(tableSorting()).toBe("name:asc")
    expect(rowNames()).toEqual(["Acts", "Gospels", "Psalms", "Ruth"])
  })

  it("keeps a choice saved by the old project list", async () => {
    localStorage.setItem("org:all-projects:view", "least-translated")
    renderProjectsPage()
    await screen.findByText("Gospels")
    expect(tableSorting()).toBe("translated:asc")
  })
})

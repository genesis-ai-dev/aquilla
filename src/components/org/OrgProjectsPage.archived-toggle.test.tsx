// AQU-1070 — "Show archived" toggle on the org Projects list.
//
// Partners billed by active-language band need to see which languages were
// stood down *beside* the live ones, greyed out, rather than on the separate
// Archived page. The default list must stay the active working set.

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
const fetchArchivedProjects = vi.fn()
// AQU-1357: partial mock — see src/lib/sync/cloud-projects-mock-guard.test.ts.
vi.mock("@/lib/sync/cloud-projects", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/sync/cloud-projects")>()),
  fetchAccessibleProjectsResult: async (...a: unknown[]) => ({
    ok: true as const,
    projects: await fetchAccessibleProjects(...a),
  }),
  fetchArchivedProjectsResult: async (...a: unknown[]) => ({
    ok: true as const,
    projects: await fetchArchivedProjects(...a),
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
const role = { level: 700, name: "owner", source: "creator" }

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

function renderProjectsPage() {
  return render(
    <MemoryRouter initialEntries={["/orgs/1/projects"]}>
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

function rowFor(projectId: string): HTMLElement {
  const row = document.querySelector(`[data-project-id="${projectId}"]`)
  if (!(row instanceof HTMLElement)) throw new Error(`no row for ${projectId}`)
  return row
}

beforeEach(() => {
  localStorage.clear()
  listMyOrgs.mockReset()
  fetchAccessibleProjects.mockReset()
  fetchArchivedProjects.mockReset()
  getPortfolio.mockReset()
  listMyOrgs.mockResolvedValue([{ id: 1, name: "Come and See", role }])
  fetchAccessibleProjects.mockResolvedValue([
    { id: "gospels", name: "Gospels", orgId: 1, role, pm: null },
  ])
  getPortfolio.mockResolvedValue([
    { id: "gospels", name: "Gospels", ...metrics(), lastEditAt: now - DAY },
  ])
  fetchArchivedProjects.mockResolvedValue([
    {
      id: "swahili",
      name: "Swahili pilot",
      gitlabProjectId: null,
      orgId: 1,
      archivedAt: "2026-05-01T00:00:00Z",
    },
  ])
})
afterEach(() => vi.clearAllMocks())

describe("org Projects archived toggle (AQU-1070)", () => {
  it("shows only live projects by default and does not fetch the archived list", async () => {
    renderProjectsPage()
    await screen.findByText("Gospels")

    expect(rowNames()).toEqual(["Gospels"])
    expect(fetchArchivedProjects).not.toHaveBeenCalled()
  })

  it("folds archived projects into the list, greyed and marked Archived, when toggled on", async () => {
    renderProjectsPage()
    await screen.findByText("Gospels")

    fireEvent.click(screen.getByTestId("show-archived-toggle"))
    await screen.findByText("Swahili pilot")

    expect(rowNames()).toEqual(["Gospels", "Swahili pilot"])
    // The greyed-out treatment is what tells a PM the row is stood down.
    expect(rowFor("swahili")).toHaveAttribute("data-archived", "true")
    expect(rowFor("swahili").className).toContain("opacity-60")
    // A live row keeps its normal treatment either way.
    expect(rowFor("gospels")).not.toHaveAttribute("data-archived")
    expect(rowFor("gospels").className).not.toContain("opacity-60")
  })

  it("toggling back off restores the active-only list", async () => {
    renderProjectsPage()
    await screen.findByText("Gospels")

    const toggle = screen.getByTestId("show-archived-toggle")
    fireEvent.click(toggle)
    await screen.findByText("Swahili pilot")
    expect(toggle).toHaveAttribute("aria-pressed", "true")

    fireEvent.click(toggle)
    await waitFor(() => expect(screen.queryByText("Swahili pilot")).not.toBeInTheDocument())
    expect(toggle).toHaveAttribute("aria-pressed", "false")
    expect(rowNames()).toEqual(["Gospels"])
  })

  it("never renders a project twice when the archived list is stale about a restored project", async () => {
    // Restored in another tab: the live read already has it, the archived read
    // has not caught up. The live row wins — it is the one with real rollups.
    fetchArchivedProjects.mockResolvedValue([
      {
        id: "gospels",
        name: "Gospels",
        gitlabProjectId: null,
        orgId: 1,
        archivedAt: "2026-05-01T00:00:00Z",
      },
    ])
    renderProjectsPage()
    await screen.findByText("Gospels")

    fireEvent.click(screen.getByTestId("show-archived-toggle"))
    await waitFor(() => expect(fetchArchivedProjects).toHaveBeenCalled())

    expect(rowNames()).toEqual(["Gospels"])
    expect(rowFor("gospels")).not.toHaveAttribute("data-archived")
  })
})

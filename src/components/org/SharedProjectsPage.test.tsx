import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, screen, waitFor, within } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { OrgProvider } from "@/context/OrgContext"
import { SharedProjectsPage } from "./SharedProjectsPage"

// AQU-417: the dedicated home for "shared with you" projects — every accessible
// project in an org the caller is NOT a member of, gathered in one place. These
// tests pin (a) that foreign-org grants render as client-side <Link>s to
// /projects/:id (the AQU-416 reachability guarantee, now on this page), (b) that
// own-org projects never leak in, and (c) the empty state.

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "jwt", username: "wendi", createdAt: "x" }, loading: false }),
}))
// The sidebar runs its own fetches/switcher — irrelevant to this page's list.
vi.mock("./OrgSidebar", () => ({ OrgSidebar: () => null }))

const listMyOrgs = vi.fn()
vi.mock("@/lib/frontier/orgs", () => ({
  listMyOrgs: (...a: unknown[]) => listMyOrgs(...a),
}))

const fetchAccessibleProjects = vi.fn()
vi.mock("@/lib/sync/cloud-projects", () => ({
  fetchAccessibleProjects: (...a: unknown[]) => fetchAccessibleProjects(...a),
}))

function renderPage() {
  return render(
    <MemoryRouter>
      <OrgProvider>
        <SharedProjectsPage />
      </OrgProvider>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  localStorage.clear()
  listMyOrgs.mockReset()
  fetchAccessibleProjects.mockReset()
})
afterEach(() => vi.clearAllMocks())

describe("SharedProjectsPage (AQU-417)", () => {
  it("lists foreign-org grants as client-side links to /projects/:id and excludes own-org projects", async () => {
    listMyOrgs.mockResolvedValue([{ id: 1, name: "Come and See", role: { level: 700, name: "owner" } }])
    fetchAccessibleProjects.mockResolvedValue([
      // Caller's own org (id 1) — must NOT appear in the shared list.
      { id: "own-1", name: "My Org Project", orgId: 1, role: { level: 700, name: "owner", source: "creator" } },
      // Foreign-org grant (viewer via invite) — the shared row.
      { id: "p503", name: "Guest Gospel", orgId: 503, orgName: "Host Org", role: { level: 100, name: "viewer", source: "override" } },
    ])

    renderPage()

    const shared = await screen.findByTestId("shared-with-you")
    const link = within(shared).getByRole("link", { name: /guest gospel/i })
    expect(link).toHaveAttribute("href", "/projects/p503")
    // Own-org project must not leak into the shared list.
    expect(within(shared).queryByText("My Org Project")).not.toBeInTheDocument()
    // The host-org label is surfaced for cross-org context.
    expect(within(shared).getByText("Host Org")).toBeInTheDocument()
  })

  it("shows an empty state when nothing is shared with the caller", async () => {
    listMyOrgs.mockResolvedValue([{ id: 1, name: "Come and See", role: { level: 700, name: "owner" } }])
    fetchAccessibleProjects.mockResolvedValue([
      { id: "own-1", name: "My Org Project", orgId: 1, role: { level: 700, name: "owner", source: "creator" } },
    ])

    renderPage()

    await waitFor(() => expect(fetchAccessibleProjects).toHaveBeenCalled())
    expect(screen.queryByTestId("shared-with-you")).not.toBeInTheDocument()
    expect(await screen.findByText("Nothing shared with you yet.")).toBeInTheDocument()
  })
})

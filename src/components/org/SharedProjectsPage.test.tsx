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

function renderPage(initialEntry = "/shared") {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
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

  // AQU-624: arriving from the org switcher scoped to one guest org
  // (`/shared?org=<id>`) narrows the page to that org's shared projects and
  // names it, so the page reads as that org's overview.
  it("scopes to a single guest org and excludes other foreign-org grants when ?org is set", async () => {
    listMyOrgs.mockResolvedValue([{ id: 1, name: "Come and See", role: { level: 700, name: "owner" } }])
    fetchAccessibleProjects.mockResolvedValue([
      { id: "own-1", name: "My Org Project", orgId: 1, role: { level: 700, name: "owner", source: "creator" } },
      { id: "p503", name: "Guest Gospel", orgId: 503, orgName: "Host Org", role: { level: 100, name: "viewer", source: "override" } },
      { id: "p777", name: "Other Shared", orgId: 777, orgName: "Other Org", role: { level: 100, name: "viewer", source: "override" } },
    ])

    renderPage("/shared?org=503")

    const shared = await screen.findByTestId("shared-with-you")
    // Only the scoped org's project shows…
    expect(within(shared).getByRole("link", { name: /guest gospel/i })).toHaveAttribute("href", "/projects/p503")
    // …the other foreign-org grant is filtered out…
    expect(within(shared).queryByText("Other Shared")).not.toBeInTheDocument()
    // …own-org projects still never leak in…
    expect(within(shared).queryByText("My Org Project")).not.toBeInTheDocument()
    // …and the page is titled with the scoped org's name.
    expect(screen.getByRole("heading", { name: "Host Org" })).toBeInTheDocument()
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

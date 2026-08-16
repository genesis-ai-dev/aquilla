import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { OrgProvider } from "@/context/OrgContext"
import { ProjectsList } from "./ProjectsList"

const navigate = vi.fn()
vi.mock("react-router-dom", async (importActual) => {
  const actual = await importActual<typeof import("react-router-dom")>()
  return { ...actual, useNavigate: () => navigate }
})

// Default: signed-in. Type-cast to allow null session in signed-out tests.
type FakeSession = { jwt: string; username: string; createdAt: string } | null
const mockUseFrontierSession = vi.fn<() => { session: FakeSession; loading: boolean }>(() => ({ session: { jwt: "jwt", username: "anna", createdAt: "x" }, loading: false }))
vi.mock("@/hooks/useFrontierSession", () => ({ useFrontierSession: () => mockUseFrontierSession() }))
vi.mock("@/lib/frontier/orgs", () => ({ listMyOrgs: vi.fn(async () => [{ id: 7, name: "Come and See", role: { level: 700, name: "owner" } }]) }))
vi.mock("@/components/AccountSwitcher", () => ({ AccountSwitcher: () => null }))
const fetchAccessibleProjectsResultMock = vi.fn()
vi.mock("@/lib/sync/cloud-projects", () => ({
  fetchAccessibleProjectsResult: (...a: unknown[]) => fetchAccessibleProjectsResultMock(...a),
  fetchAccessibleProjects: vi.fn(async () => []),
  createCloudProject: vi.fn(),
}))

beforeEach(() => {
  localStorage.clear()
  fetchAccessibleProjectsResultMock.mockReset()
  navigate.mockClear()
  mockUseFrontierSession.mockReturnValue({ session: { jwt: "jwt", username: "anna", createdAt: "x" }, loading: false } as { session: FakeSession; loading: boolean })
})
afterEach(() => vi.restoreAllMocks())

describe("ProjectsList", () => {
  it("shows explicit progress over a value-free panel while projects are unresolved", async () => {
    fetchAccessibleProjectsResultMock.mockImplementation(
      () => new Promise(() => {}),
    )
    render(<MemoryRouter><OrgProvider><ProjectsList /></OrgProvider></MemoryRouter>)

    const status = await screen.findByRole("status", {
      name: "Loading projects",
    })
    expect(status).toHaveAttribute("aria-busy", "true")
    expect(status.querySelector("[data-slot='spinner']")).not.toBeNull()
    expect(screen.queryByText("No projects in this org yet.")).not.toBeInTheDocument()
  })

  it("fetches the unfiltered project list and renders active-org projects", async () => {
    fetchAccessibleProjectsResultMock.mockResolvedValue({
      ok: true,
      projects: [{ id: "p1", name: "John", orgId: 7, role: { level: 700, name: "owner", source: "creator" }, files: [] }],
    })
    render(<MemoryRouter><OrgProvider><ProjectsList /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByText("John")).toBeInTheDocument())
    // AQU-335: the fetch must NOT be org-filtered — cross-org grants
    // (invite-link / bulk-add) are partitioned client-side instead.
    expect(fetchAccessibleProjectsResultMock).toHaveBeenCalledWith("jwt")
    expect(screen.queryByTestId("shared-with-you")).not.toBeInTheDocument()
  })

  // AQU-335: a project joined via magic-link invite lives in the INVITER's
  // org. The invitee isn't an org member, so an org-scoped list hid it —
  // URL-accessible but unreachable from the dashboard. It must render under
  // "Shared with you".
  it("renders projects from orgs the user doesn't belong to under Shared with you", async () => {
    fetchAccessibleProjectsResultMock.mockResolvedValue({
      ok: true,
      projects: [
        { id: "p1", name: "John", orgId: 7, role: { level: 700, name: "owner", source: "creator" }, files: [] },
        { id: "p503", name: "Joined Via Invite", orgId: 503, role: { level: 400, name: "contributor", source: "override" }, files: [] },
      ],
    })
    render(<MemoryRouter><OrgProvider><ProjectsList /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByText("Joined Via Invite")).toBeInTheDocument())
    const shared = screen.getByTestId("shared-with-you")
    expect(shared).toHaveTextContent("Shared with you")
    expect(shared).toHaveTextContent("Joined Via Invite")
    // The active-org project stays in the main list, not the shared section.
    expect(shared).not.toHaveTextContent("John")
  })

  // AQU-416: clicking a "Shared with you" row must actually navigate — this
  // was the literal repro ("clicking reloads the page / doesn't navigate").
  // The row's onOpen and the own-project row's onOpen both call the same
  // navigate(`/projects/${id}`); assert the shared row fires it too so a
  // future divergence (e.g. gating the shared row's onClick on org
  // membership) fails here instead of only in a live click-through.
  it("clicking a Shared with you row navigates to its project overview", async () => {
    fetchAccessibleProjectsResultMock.mockResolvedValue({
      ok: true,
      projects: [
        { id: "p1", name: "John", orgId: 7, role: { level: 700, name: "owner", source: "creator" }, files: [] },
        { id: "p503", name: "Joined Via Invite", orgId: 503, role: { level: 400, name: "contributor", source: "override" }, files: [] },
      ],
    })
    render(<MemoryRouter><OrgProvider><ProjectsList /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByText("Joined Via Invite")).toBeInTheDocument())

    const shared = screen.getByTestId("shared-with-you")
    fireEvent.click(within(shared).getByText("Joined Via Invite"))

    expect(navigate).toHaveBeenCalledWith("/projects/p503")
  })

  // AQU-293: no infinite spinner when no session / org
  it("resolves to a sign-in prompt (not an infinite spinner) when there is no session", async () => {
    // Why: /projects must never stay in a perpetual Loading… state when the
    // user is signed out — that's a dead end with no recovery path.
    mockUseFrontierSession.mockReturnValue({ session: null, loading: false })

    render(<MemoryRouter><OrgProvider><ProjectsList /></OrgProvider></MemoryRouter>)

    // The signed-out state should appear; the loading spinner must not persist.
    await waitFor(() => {
      expect(screen.getByRole("link", { name: /sign in/i })).toBeInTheDocument()
    })
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument()
    expect(fetchAccessibleProjectsResultMock).not.toHaveBeenCalled()
  })

  it("sign-in link on the signed-out state points to /login with next=/projects", async () => {
    mockUseFrontierSession.mockReturnValue({ session: null, loading: false })

    render(<MemoryRouter><OrgProvider><ProjectsList /></OrgProvider></MemoryRouter>)

    const link = await screen.findByRole("link", { name: /sign in/i })
    expect(link.getAttribute("href")).toMatch(/\/login\?next=.*projects/)
  })

  // AQU-366: the projects list must scroll natively (h-full + overflow-y-auto
  // inside AppShell's height-constrained main slot) rather than clip. jsdom
  // can't compute real layout, so this asserts the structural contract
  // instead of pixel scroll behavior — see AppShell.tsx / this file for the
  // flex chain that makes `h-full overflow-y-auto` the correct scroll surface.
  it("renders the list in a scrollable container (h-full + overflow-y-auto, no fixed/clipped height)", async () => {
    fetchAccessibleProjectsResultMock.mockResolvedValue({
      ok: true,
      projects: [{ id: "p1", name: "John", orgId: 7, role: { level: 700, name: "owner", source: "creator" }, files: [] }],
    })
    render(<MemoryRouter><OrgProvider><ProjectsList /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByText("John")).toBeInTheDocument())

    const scrollContainer = screen.getByTestId("projects-list-scroll")
    expect(scrollContainer.className).toMatch(/\bh-full\b/)
    expect(scrollContainer.className).toMatch(/\boverflow-y-auto\b/)
    // Must not clip via overflow-hidden (the ScrollArea/flex footgun this
    // guards against — see AQU-164).
    expect(scrollContainer.className).not.toMatch(/overflow-hidden/)
  })
})

// RES-5 follow-up (UI-QA 2026-06-10): when the ORGS fetch fails, activeOrgId
// never resolves and loadProjects() never runs — the page used to fall through
// to a false "No projects in this org yet." empty state. It must show the
// unreachable banner instead.
describe("ProjectsList — orgs fetch failure (RES-5)", () => {
  it("shows the unreachable banner, not the empty state, when the orgs fetch fails", async () => {
    const { listMyOrgs } = await import("@/lib/frontier/orgs")
    vi.mocked(listMyOrgs).mockRejectedValueOnce(new Error("network down"))

    render(<MemoryRouter><OrgProvider><ProjectsList /></OrgProvider></MemoryRouter>)

    await waitFor(() => {
      expect(screen.getByText(/can't reach the server/i)).toBeInTheDocument()
    })
    // AQU-882: the sidebar org switcher grew its own retry affordance for this
    // same failure, so scope to the banner rather than matching any /retry/.
    const banner = screen.getByTestId("projects-unreachable-banner")
    expect(within(banner).getByRole("button", { name: /retry/i })).toBeInTheDocument()
    expect(screen.queryByText(/no projects in this org yet/i)).not.toBeInTheDocument()
    // The projects fetch never ran (no org id) — and must not be needed for
    // the banner to appear.
    expect(fetchAccessibleProjectsResultMock).not.toHaveBeenCalled()
  })

  it("Retry after an orgs failure re-fetches orgs and recovers to the project grid", async () => {
    const { listMyOrgs } = await import("@/lib/frontier/orgs")
    vi.mocked(listMyOrgs).mockRejectedValueOnce(new Error("network down"))
    fetchAccessibleProjectsResultMock.mockResolvedValue({
      ok: true,
      projects: [{ id: "p1", name: "John", orgId: 7, role: { level: 700, name: "owner", source: "creator" }, files: [] }],
    })

    render(<MemoryRouter><OrgProvider><ProjectsList /></OrgProvider></MemoryRouter>)
    const banner = await screen.findByTestId("projects-unreachable-banner")
    within(banner).getByRole("button", { name: /retry/i }).click()

    await waitFor(() => expect(screen.getByText("John")).toBeInTheDocument())
    expect(screen.queryByText(/can't reach the server/i)).not.toBeInTheDocument()
  })
})

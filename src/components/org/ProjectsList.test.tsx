import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { OrgProvider } from "@/context/OrgContext"
import { ProjectsList } from "./ProjectsList"

// Default: signed-in. Type-cast to allow null session in signed-out tests.
type FakeSession = { jwt: string; username: string; createdAt: string } | null
const mockUseFrontierSession = vi.fn<[], { session: FakeSession; loading: boolean }>(() => ({ session: { jwt: "jwt", username: "anna", createdAt: "x" }, loading: false }))
vi.mock("@/hooks/useFrontierSession", () => ({ useFrontierSession: () => mockUseFrontierSession() }))
vi.mock("@/lib/frontier/orgs", () => ({ listMyOrgs: vi.fn(async () => [{ id: 7, name: "Come and See", role: { level: 700, name: "owner" } }]) }))
vi.mock("@/components/AccountSwitcher", () => ({ AccountSwitcher: () => null }))
const fetchAccessibleProjects = vi.fn()
vi.mock("@/lib/sync/cloud-projects", () => ({ fetchAccessibleProjects: (...a: unknown[]) => fetchAccessibleProjects(...a), createCloudProject: vi.fn() }))

beforeEach(() => {
  localStorage.clear()
  fetchAccessibleProjects.mockReset()
  mockUseFrontierSession.mockReturnValue({ session: { jwt: "jwt", username: "anna", createdAt: "x" }, loading: false } as { session: FakeSession; loading: boolean })
})
afterEach(() => vi.restoreAllMocks())

describe("ProjectsList", () => {
  it("fetches projects scoped to the active org and renders them", async () => {
    fetchAccessibleProjects.mockResolvedValue([
      { id: "p1", name: "John", orgId: 7, role: { level: 700, name: "owner", source: "creator" }, files: [] },
    ])
    render(<MemoryRouter><OrgProvider><ProjectsList /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByText("John")).toBeInTheDocument())
    expect(fetchAccessibleProjects).toHaveBeenCalledWith("jwt", 7)
  })

  // FRO-293: no infinite spinner when no session / org
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
    expect(fetchAccessibleProjects).not.toHaveBeenCalled()
  })

  it("sign-in link on the signed-out state points to /login with next=/projects", async () => {
    mockUseFrontierSession.mockReturnValue({ session: null, loading: false })

    render(<MemoryRouter><OrgProvider><ProjectsList /></OrgProvider></MemoryRouter>)

    const link = await screen.findByRole("link", { name: /sign in/i })
    expect(link.getAttribute("href")).toMatch(/\/login\?next=.*projects/)
  })
})

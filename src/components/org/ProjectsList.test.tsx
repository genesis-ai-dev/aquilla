import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { OrgProvider } from "@/context/OrgContext"
import { ProjectsList } from "./ProjectsList"

vi.mock("@/hooks/useFrontierSession", () => ({ useFrontierSession: () => ({ session: { jwt: "jwt", username: "anna", createdAt: "x" }, loading: false }) }))
vi.mock("@/lib/frontier/orgs", () => ({ listMyOrgs: vi.fn(async () => [{ id: 7, name: "Come and See", role: { level: 700, name: "owner" } }]) }))
vi.mock("@/components/AccountSwitcher", () => ({ AccountSwitcher: () => null }))
const fetchAccessibleProjectsResultMock = vi.fn()
vi.mock("@/lib/sync/cloud-projects", () => ({
  fetchAccessibleProjectsResult: (...a: unknown[]) => fetchAccessibleProjectsResultMock(...a),
  fetchAccessibleProjects: vi.fn(async () => []),
  createCloudProject: vi.fn(),
}))

beforeEach(() => { localStorage.clear(); fetchAccessibleProjectsResultMock.mockReset() })
afterEach(() => vi.restoreAllMocks())

describe("ProjectsList", () => {
  it("fetches projects scoped to the active org and renders them", async () => {
    fetchAccessibleProjectsResultMock.mockResolvedValue({
      ok: true,
      projects: [{ id: "p1", name: "John", orgId: 7, role: { level: 700, name: "owner", source: "creator" }, files: [] }],
    })
    render(<MemoryRouter><OrgProvider><ProjectsList /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByText("John")).toBeInTheDocument())
    expect(fetchAccessibleProjectsResultMock).toHaveBeenCalledWith("jwt", 7)
  })
})

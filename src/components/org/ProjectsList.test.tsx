import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { OrgProvider } from "@/context/OrgContext"
import { ProjectsList } from "./ProjectsList"

vi.mock("@/hooks/useFrontierSession", () => ({ useFrontierSession: () => ({ session: { jwt: "jwt", username: "anna", createdAt: "x" }, loading: false }) }))
vi.mock("@/lib/frontier/orgs", () => ({ listMyOrgs: vi.fn(async () => [{ id: 7, name: "Come and See", role: { level: 700, name: "owner" } }]) }))
vi.mock("@/components/AccountSwitcher", () => ({ AccountSwitcher: () => null }))
const fetchAccessibleProjects = vi.fn()
vi.mock("@/lib/sync/cloud-projects", () => ({ fetchAccessibleProjects: (...a: unknown[]) => fetchAccessibleProjects(...a), createCloudProject: vi.fn() }))

beforeEach(() => { localStorage.clear(); fetchAccessibleProjects.mockReset() })
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
})

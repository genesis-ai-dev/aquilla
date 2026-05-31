import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, screen, waitFor, fireEvent } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { OrgProvider } from "@/context/OrgContext"
import { Settings } from "./Settings"
import { renameOrg, listMyOrgs } from "@/lib/frontier/orgs"

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "jwt", username: "wendi", createdAt: "x" }, loading: false }),
}))
vi.mock("@/lib/frontier/orgs", () => ({
  listMyOrgs: vi.fn(async () => [{ id: 1, name: "Come and See", role: { level: 700, name: "owner" } }]),
  renameOrg: vi.fn(async () => {}),
}))
vi.mock("@/hooks/useOrg", () => ({
  useOrgMembers: () => ({ members: [{ userId: 1 }, { userId: 2 }, { userId: 3 }], isLoading: false, error: null }),
}))
vi.mock("@/lib/frontier/portfolio", () => ({
  getPortfolio: vi.fn(async () => [{ id: "p1" }, { id: "p2" }]),
}))
vi.mock("@/components/AccountSwitcher", () => ({ AccountSwitcher: () => null }))

beforeEach(() => localStorage.clear())
afterEach(() => vi.clearAllMocks())

function renderSettings() {
  return render(<MemoryRouter><OrgProvider><Settings /></OrgProvider></MemoryRouter>)
}

describe("Org Settings", () => {
  it("shows the org name and an owner can rename it", async () => {
    renderSettings()
    await waitFor(() => expect(screen.getAllByText("Come and See").length).toBeGreaterThan(0))
    fireEvent.click(screen.getByRole("button", { name: /rename/i }))
    const input = screen.getByLabelText(/organization name/i)
    fireEvent.change(input, { target: { value: "CAS" } })
    fireEvent.click(screen.getByRole("button", { name: /save/i }))
    await waitFor(() => expect(renameOrg).toHaveBeenCalledWith("jwt", 1, "CAS"))
  })

  it("shows org facts (member + project counts)", async () => {
    renderSettings()
    await waitFor(() => expect(screen.getByText("3")).toBeInTheDocument()) // members
    await waitFor(() => expect(screen.getByText("2")).toBeInTheDocument()) // projects
  })

  it("hides the rename control for a non-admin", async () => {
    vi.mocked(listMyOrgs).mockResolvedValueOnce([{ id: 1, name: "Come and See", role: { level: 100, name: "viewer" } }])
    renderSettings()
    await waitFor(() => expect(screen.getAllByText("Come and See").length).toBeGreaterThan(0))
    expect(screen.queryByRole("button", { name: /rename/i })).not.toBeInTheDocument()
  })
})

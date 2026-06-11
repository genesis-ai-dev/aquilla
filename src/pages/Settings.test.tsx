import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { OrgProvider } from "@/context/OrgContext"
import { Settings } from "./Settings"
import { renameOrg, listMyOrgs } from "@/lib/frontier/orgs"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockPatch = vi.fn<() => Promise<any>>(async () => ({ kind: "ok", value: { orgId: 1, settings: {}, version: 1, updatedAt: null, updatedBy: null } }))

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
vi.mock("@/hooks/useOrgSettings", () => ({
  useOrgSettings: () => ({
    exportMinRole: null,
    patch: mockPatch,
    settings: {},
    orgRules: [],
    promotionRequests: [],
    canRequestPromotion: false,
    version: null,
    hasFetched: true,
    canEdit: true,
    canExport: true,
    refresh: vi.fn(async () => null),
    requestPromotion: vi.fn(async () => ({ kind: "blocked" })),
  }),
}))

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

describe("Export policy saved acknowledgment", () => {
  it("shows Saved after a successful export-role change", async () => {
    mockPatch.mockResolvedValueOnce({ kind: "ok", value: { orgId: 1, settings: {}, version: 2, updatedAt: null, updatedBy: null } })
    renderSettings()
    // Wait for the export permissions section to appear.
    await waitFor(() => expect(screen.getByLabelText(/who can export/i)).toBeDefined())

    const select = screen.getByLabelText(/who can export/i) as HTMLSelectElement
    await act(async () => {
      fireEvent.change(select, { target: { value: "400" } })
    })

    await waitFor(() => expect(screen.getByTestId("export-role-saved")).toBeDefined())
    expect(screen.getByTestId("export-role-saved").textContent).toContain("Saved")
  })

  it("does not show Saved when the save fails", async () => {
    mockPatch.mockResolvedValueOnce({ kind: "error" as const, status: 500, message: "Server error" })
    renderSettings()
    await waitFor(() => expect(screen.getByLabelText(/who can export/i)).toBeDefined())

    const select = screen.getByLabelText(/who can export/i) as HTMLSelectElement
    await act(async () => {
      fireEvent.change(select, { target: { value: "400" } })
    })

    await waitFor(() => expect(screen.queryByTestId("export-role-saved")).toBeNull())
    expect(screen.getByText(/server error/i)).toBeDefined()
  })
})

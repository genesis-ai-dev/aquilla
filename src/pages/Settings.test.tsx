import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, screen, waitFor, fireEvent } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { OrgProvider } from "@/context/OrgContext"
import { Settings, OrgSettingsIdentity, OrgSettingsExport } from "./Settings"
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
    // AQU-433: OrgProviderSection consumes these from the hook contract.
    orgProviderKeys: {},
    canEditOrgKeys: true,
    // AQU-485: roster/member-progress visibility — default floor (Maintainer)
    // and the mocked caller (owner, role 700) passes it.
    canViewRoster: true,
    rosterViewMinRole: 600,
    canViewMemberProgress: true,
    memberProgressViewMinRole: 600,
    // AQU-496: self-assignment authority — default leads-only.
    allowSelfAssignment: false,
    refresh: vi.fn(async () => null),
    requestPromotion: vi.fn(async () => ({ kind: "blocked" })),
  }),
  // AQU-485: Settings.tsx imports this directly (not part of the hook's
  // return value) to gate the roster/progress Select controls owner-only.
  canEditRosterProgressFloor: (level: number | null | undefined) => (level ?? 0) >= 700,
  // AQU-496: same pattern, gates the allowSelfAssignment Switch owner-only.
  canEditAssignmentAuthority: (level: number | null | undefined) => (level ?? 0) >= 700,
}))

beforeEach(() => localStorage.clear())
afterEach(() => vi.clearAllMocks())

// Drive the shadcn (Base UI) Select: open the trigger, hover-highlight the
// option, commit with Enter. Under happy-dom clicking an option does not
// reliably commit a selection, but the keyboard path does (same recipe as
// AssignModal.test.tsx). No trigger-text assertion here: the export floor is
// controlled by the mocked useOrgSettings hook, so the displayed value does
// not change after a pick — callers assert on the patch result instead.
async function pickSelectOption(triggerName: RegExp, optionName: RegExp) {
  const trigger = screen.getByRole("combobox", { name: triggerName })
  fireEvent.click(trigger)
  const option = await screen.findByRole("option", { name: optionName })
  fireEvent.pointerMove(option)
  fireEvent.mouseMove(option)
  // Enter targets the option itself: outside a Dialog, focus may never enter
  // the popup under happy-dom, so document.activeElement can stay on <body>.
  fireEvent.keyDown(option, { key: "Enter" })
}

function renderSettings(path = "/settings") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <OrgProvider>
        <Routes>
          <Route path="/settings" element={<Settings />} />
          <Route path="/settings/identity" element={<OrgSettingsIdentity />} />
          <Route path="/settings/export" element={<OrgSettingsExport />} />
        </Routes>
      </OrgProvider>
    </MemoryRouter>,
  )
}

describe("Org Settings", () => {
  it("shows the org name and an owner can rename it", async () => {
    renderSettings("/settings/identity")
    await waitFor(() => expect(screen.getAllByText("Come and See").length).toBeGreaterThan(0))
    fireEvent.click(screen.getByRole("button", { name: /rename/i }))
    const input = await screen.findByLabelText(/organization name/i)
    fireEvent.change(input, { target: { value: "CAS" } })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(renameOrg).toHaveBeenCalledWith("jwt", 1, "CAS"))
  })

  it("hides the rename control for a non-admin", async () => {
    vi.mocked(listMyOrgs).mockResolvedValueOnce([{ id: 1, name: "Come and See", role: { level: 100, name: "viewer" } }])
    renderSettings("/settings/identity")
    await waitFor(() => expect(screen.getAllByText("Come and See").length).toBeGreaterThan(0))
    expect(screen.queryByRole("button", { name: /rename/i })).not.toBeInTheDocument()
  })
})

describe("Export policy saved acknowledgment", () => {
  it("shows Saved after a successful export-role change", async () => {
    mockPatch.mockResolvedValueOnce({ kind: "ok", value: { orgId: 1, settings: {}, version: 2, updatedAt: null, updatedBy: null } })
    renderSettings("/settings/export")
    // Wait for the export permissions section to appear.
    await waitFor(() => expect(screen.getByLabelText(/who can export/i)).toBeDefined())

    await pickSelectOption(/who can export/i, /contributor \(400\)/i)

    await waitFor(() => expect(screen.getByTestId("export-role-saved")).toBeDefined())
    expect(screen.getByTestId("export-role-saved").textContent).toContain("Saved")
  })

  it("does not show Saved when the save fails", async () => {
    mockPatch.mockResolvedValueOnce({ kind: "error" as const, status: 500, message: "Server error" })
    renderSettings("/settings/export")
    await waitFor(() => expect(screen.getByLabelText(/who can export/i)).toBeDefined())

    await pickSelectOption(/who can export/i, /contributor \(400\)/i)

    // The server error must surface, and the Saved acknowledgment must not.
    expect(await screen.findByText(/server error/i)).toBeDefined()
    expect(screen.queryByTestId("export-role-saved")).toBeNull()
  })
})

// AQU-485: roster + member-progress visibility settings UI.
describe("Roster & member-progress visibility settings (AQU-485)", () => {
  it("renders both independent controls, defaulting to Maintainer", async () => {
    renderSettings("/settings/roster")
    await waitFor(() => expect(screen.getByLabelText(/who can view the roster/i)).toBeDefined())
    expect(screen.getByLabelText(/who can view member progress/i)).toBeDefined()
  })

  it("shows Saved after successfully changing the roster floor, independent of the progress floor", async () => {
    mockPatch.mockResolvedValueOnce({ kind: "ok", value: { orgId: 1, settings: { rosterViewMinRole: 400 }, version: 2, updatedAt: null, updatedBy: null } })
    renderSettings("/settings/roster")
    await waitFor(() => expect(screen.getByLabelText(/who can view the roster/i)).toBeDefined())

    await pickSelectOption(/who can view the roster/i, /contributor \(400\)/i)

    await waitFor(() => expect(screen.getByTestId("roster-role-saved")).toBeDefined())
    // Changing the roster floor must not touch the progress floor's ack state.
    expect(screen.queryByTestId("progress-role-saved")).toBeNull()
  })

  it("surfaces a server error for the member-progress floor without a false Saved", async () => {
    mockPatch.mockResolvedValueOnce({ kind: "error" as const, status: 500, message: "Server error" })
    renderSettings("/settings/roster")
    await waitFor(() => expect(screen.getByLabelText(/who can view member progress/i)).toBeDefined())

    await pickSelectOption(/who can view member progress/i, /owner \(700\)/i)

    expect(await screen.findByText(/server error/i)).toBeDefined()
    expect(screen.queryByTestId("progress-role-saved")).toBeNull()
  })
})

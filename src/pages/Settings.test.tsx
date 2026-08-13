import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, screen, waitFor, fireEvent } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { OrgProvider } from "@/context/OrgContext"
import { Settings, OrgSettingsIdentity, OrgSettingsExport, OrgSettingsRoster, OrgSettingsAssignment } from "./Settings"
import { renameOrg, listMyOrgs } from "@/lib/frontier/orgs"
import { toast } from "@/components/ui/toast"

vi.mock("@/components/ui/toast", () => ({
  toast: { add: vi.fn(), close: vi.fn(), update: vi.fn(), promise: vi.fn() },
}))

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

function renderSettings(path = "/orgs/1/settings") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <OrgProvider>
        <Routes>
          <Route path="/orgs/:orgId/settings" element={<Settings />} />
          <Route path="/orgs/:orgId/settings/identity" element={<OrgSettingsIdentity />} />
          <Route path="/orgs/:orgId/settings/export" element={<OrgSettingsExport />} />
          <Route path="/orgs/:orgId/settings/roster" element={<OrgSettingsRoster />} />
          <Route path="/orgs/:orgId/settings/assignment" element={<OrgSettingsAssignment />} />
        </Routes>
      </OrgProvider>
    </MemoryRouter>,
  )
}

describe("Org Settings", () => {
  it("shows the org name and an owner can rename it on blur", async () => {
    renderSettings("/orgs/1/settings/identity")
    const input = await screen.findByLabelText(/^Organization name$/i)
    await waitFor(() => expect(input).toHaveValue("Come and See"))
    fireEvent.change(input, { target: { value: "CAS" } })
    fireEvent.blur(input)
    await waitFor(() => expect(renameOrg).toHaveBeenCalledWith("jwt", 1, "CAS"))
    expect(toast.add).toHaveBeenCalledWith({
      type: "success",
      title: "Organization name updated",
    })
  })

  it("disables the name field for a non-admin", async () => {
    vi.mocked(listMyOrgs).mockResolvedValueOnce([{ id: 1, name: "Come and See", role: { level: 100, name: "viewer" } }])
    renderSettings("/orgs/1/settings/identity")
    const input = await screen.findByLabelText(/^Organization name$/i)
    await waitFor(() => expect(input).toHaveValue("Come and See"))
    expect(input).toBeDisabled()
  })
})

describe("Export policy silent auto-save", () => {
  it("patches on change without a Saved acknowledgment", async () => {
    mockPatch.mockResolvedValueOnce({ kind: "ok", value: { orgId: 1, settings: {}, version: 2, updatedAt: null, updatedBy: null } })
    renderSettings("/orgs/1/settings/export")
    await waitFor(() => expect(screen.getByLabelText(/who can export/i)).toBeDefined())

    await pickSelectOption(/who can export/i, /contributor \(400\)/i)

    await waitFor(() => expect(mockPatch).toHaveBeenCalledWith({ exportMinRole: 400 }))
    expect(screen.queryByText(/^Saved$/i)).toBeNull()
    expect(toast.add).not.toHaveBeenCalled()
  })

  it("surfaces a server error when the save fails", async () => {
    mockPatch.mockResolvedValueOnce({ kind: "error" as const, status: 500, message: "Server error" })
    renderSettings("/orgs/1/settings/export")
    await waitFor(() => expect(screen.getByLabelText(/who can export/i)).toBeDefined())

    await pickSelectOption(/who can export/i, /contributor \(400\)/i)

    expect(await screen.findByText(/server error/i)).toBeDefined()
    expect(screen.queryByText(/^Saved$/i)).toBeNull()
  })
})

// AQU-485: roster + member-progress visibility settings UI.
describe("Roster & member-progress visibility settings (AQU-485)", () => {
  it("renders both independent controls, defaulting to Maintainer", async () => {
    renderSettings("/orgs/1/settings/roster")
    await waitFor(() => expect(screen.getByLabelText(/who can view the roster/i)).toBeDefined())
    expect(screen.getByLabelText(/who can view member progress/i)).toBeDefined()
  })

  it("silently patches the roster floor without a Saved acknowledgment", async () => {
    mockPatch.mockResolvedValueOnce({ kind: "ok", value: { orgId: 1, settings: { rosterViewMinRole: 400 }, version: 2, updatedAt: null, updatedBy: null } })
    renderSettings("/orgs/1/settings/roster")
    await waitFor(() => expect(screen.getByLabelText(/who can view the roster/i)).toBeDefined())

    await pickSelectOption(/who can view the roster/i, /contributor \(400\)/i)

    await waitFor(() => expect(mockPatch).toHaveBeenCalledWith({ rosterViewMinRole: 400 }))
    expect(screen.queryByText(/^Saved$/i)).toBeNull()
    expect(toast.add).not.toHaveBeenCalled()
  })

  it("surfaces a server error for the member-progress floor without a false Saved", async () => {
    mockPatch.mockResolvedValueOnce({ kind: "error" as const, status: 500, message: "Server error" })
    renderSettings("/orgs/1/settings/roster")
    await waitFor(() => expect(screen.getByLabelText(/who can view member progress/i)).toBeDefined())

    await pickSelectOption(/who can view member progress/i, /owner \(700\)/i)

    expect(await screen.findByText(/server error/i)).toBeDefined()
    expect(screen.queryByText(/^Saved$/i)).toBeNull()
  })
})

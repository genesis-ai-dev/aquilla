import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, screen, waitFor, fireEvent } from "@testing-library/react"
import { MemoryRouter, Navigate, Route, Routes } from "react-router-dom"
import { OrgProvider } from "@/context/OrgContext"
import { Settings, OrgSettingsIdentity, OrgSettingsKnowledge, OrgSettingsSecurity } from "./Settings"
import { renameOrg, listMyOrgs } from "@/lib/frontier/orgs"
import { toast } from "@/components/ui/toast"

vi.mock("@/components/ui/toast", () => ({
  toast: { add: vi.fn(), close: vi.fn(), update: vi.fn(), promise: vi.fn() },
}))

const mockPatch = vi.fn<() => Promise<any>>(async () => ({ kind: "ok", value: { orgId: 1, settings: {}, version: 1, updatedAt: null, updatedBy: null } }))

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "jwt", username: "wendi", createdAt: "x" }, loading: false }),
}))
vi.mock("@/lib/frontier/orgs", () => ({
  listMyOrgs: vi.fn(async () => [{ id: 1, name: "Come and See", role: { level: 700, name: "owner" } }]),
  renameOrg: vi.fn(async () => {}),
}))
vi.mock("@/components/AccountSwitcher", () => ({ AccountSwitcher: () => null }))
vi.mock("@/lib/frontier/knowledge-base", () => ({
  listKnowledgeDocuments: vi.fn(async () => []),
  getKnowledgeDocument: vi.fn(),
  getKnowledgeDocumentContent: vi.fn(),
  getKnowledgeDocumentOriginal: vi.fn(),
  uploadKnowledgeDocument: vi.fn(),
  deleteKnowledgeDocument: vi.fn(),
  reindexKnowledgeDocument: vi.fn(),
}))

const rosterSettings = vi.hoisted(() => ({ canViewRoster: true }))
vi.mock("@/hooks/useOrgSettings", () => ({
  useOrgSettings: () => ({
    exportMinRole: null,
    egressMinRole: 700,
    canEgress: true,
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
    canViewRoster: rosterSettings.canViewRoster,
    rosterViewMinRole: 600,
    canViewMemberProgress: true,
    memberProgressViewMinRole: 600,
    // AQU-496: self-assignment authority — default leads-only.
    allowSelfAssignment: false,
    // AQU-1037: assigning work to others defaults to Project lead.
    assignmentMinRole: 500,
    // AQU-822: terminology floor — default Project lead.
    termbaseEditMinRole: 500,
    languageEditMinRole: 600,
    // AQU-1002: comment floors — defaults reproduce post-AQU-999 behaviour.
    commentCreateMinRole: 200,
    commentResolveMinRole: 400,
    refresh: vi.fn(async () => null),
    requestPromotion: vi.fn(async () => ({ kind: "blocked" })),
  }),
  canEditRosterProgressFloor: (level: number | null | undefined) => (level ?? 0) >= 700,
  canEditAssignmentAuthority: (level: number | null | undefined) => (level ?? 0) >= 700,
  canEditTermbaseFloor: (level: number | null | undefined) => (level ?? 0) >= 700,
  canEditEgressFloor: (level: number | null | undefined) => (level ?? 0) >= 700,
  canEditCommentFloors: (level: number | null | undefined) => (level ?? 0) >= 700,
}))

beforeEach(() => {
  localStorage.clear()
  rosterSettings.canViewRoster = true
})
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
          <Route path="/orgs/:orgId/settings/security" element={<OrgSettingsSecurity />} />
          <Route path="/orgs/:orgId/settings/knowledge" element={<OrgSettingsKnowledge />} />
          <Route path="/orgs/:orgId/settings/export" element={<Navigate to="../security" replace relative="path" />} />
          <Route path="/orgs/:orgId/settings/roster" element={<Navigate to="../security" replace relative="path" />} />
        </Routes>
      </OrgProvider>
    </MemoryRouter>,
  )
}

describe("Org Settings", () => {
  it("lists Billing & usage on the settings index", async () => {
    renderSettings("/orgs/1/settings")
    expect(await screen.findByRole("link", { name: /Billing & usage/i })).toBeDefined()
  })

  it("links to and renders the organization knowledge base", async () => {
    const { unmount } = renderSettings("/orgs/1/settings")
    const link = await screen.findByRole("link", { name: /Knowledge base/i })
    expect(link).toHaveAttribute("href", "/orgs/1/settings/knowledge")
    unmount()

    renderSettings("/orgs/1/settings/knowledge")
    expect(await screen.findByRole("heading", { name: "Knowledge base" })).toBeInTheDocument()
    expect(screen.getAllByText(/every project in this organization/i)).toHaveLength(1)
  })

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

describe("Security settings page", () => {
  it("renders visibility and permission controls on one page", async () => {
    renderSettings("/orgs/1/settings/security")
    await waitFor(() => expect(screen.getByRole("heading", { name: "Security" })).toBeInTheDocument())
    expect(screen.getByText("Visibility")).toBeInTheDocument()
    expect(screen.getByText("Permissions")).toBeInTheDocument()
    expect(screen.getByLabelText(/who can view the roster/i)).toBeDefined()
    expect(screen.getByLabelText(/who can view member progress/i)).toBeDefined()
    expect(screen.getByLabelText(/who can export/i)).toBeDefined()
    expect(screen.getByLabelText(/who can assign work/i)).toBeDefined()
    expect(screen.getByLabelText(/allow self-assignment/i)).toBeDefined()
    expect(screen.getByLabelText(/who can manage terminology/i)).toBeDefined()
  })

  it("patches export on change without a Saved acknowledgment", async () => {
    mockPatch.mockResolvedValueOnce({ kind: "ok", value: { orgId: 1, settings: {}, version: 2, updatedAt: null, updatedBy: null } })
    renderSettings("/orgs/1/settings/security")
    await waitFor(() => expect(screen.getByLabelText(/who can export/i)).toBeDefined())

    await pickSelectOption(/who can export/i, /contributor \(400\)/i)

    await waitFor(() => expect(mockPatch).toHaveBeenCalledWith({ exportMinRole: 400 }))
    expect(screen.queryByText(/^Saved$/i)).toBeNull()
    expect(toast.add).not.toHaveBeenCalled()
  })

  it("patches the egress floor on change — an owner opens Data egress to maintainers (AQU-907)", async () => {
    renderSettings("/orgs/1/settings/security")
    await waitFor(() => expect(screen.getByLabelText(/who can use data egress/i)).toBeDefined())

    await pickSelectOption(/who can use data egress/i, /maintainer \(600\)/i)

    await waitFor(() => expect(mockPatch).toHaveBeenCalledWith({ egressMinRole: 600 }))
  })

  it("surfaces a server error when the export save fails", async () => {
    mockPatch.mockResolvedValueOnce({ kind: "error" as const, status: 500, message: "Server error" })
    renderSettings("/orgs/1/settings/security")
    await waitFor(() => expect(screen.getByLabelText(/who can export/i)).toBeDefined())

    await pickSelectOption(/who can export/i, /contributor \(400\)/i)

    expect(await screen.findByText(/server error/i)).toBeDefined()
    expect(screen.queryByText(/^Saved$/i)).toBeNull()
  })

  it("silently patches the roster floor without a Saved acknowledgment", async () => {
    mockPatch.mockResolvedValueOnce({ kind: "ok", value: { orgId: 1, settings: { rosterViewMinRole: 400 }, version: 2, updatedAt: null, updatedBy: null } })
    renderSettings("/orgs/1/settings/security")
    await waitFor(() => expect(screen.getByLabelText(/who can view the roster/i)).toBeDefined())

    await pickSelectOption(/who can view the roster/i, /contributor \(400\)/i)

    await waitFor(() => expect(mockPatch).toHaveBeenCalledWith({ rosterViewMinRole: 400 }))
    expect(screen.queryByText(/^Saved$/i)).toBeNull()
    expect(toast.add).not.toHaveBeenCalled()
  })

  it("surfaces a server error for the member-progress floor without a false Saved", async () => {
    mockPatch.mockResolvedValueOnce({ kind: "error" as const, status: 500, message: "Server error" })
    renderSettings("/orgs/1/settings/security")
    await waitFor(() => expect(screen.getByLabelText(/who can view member progress/i)).toBeDefined())

    await pickSelectOption(/who can view member progress/i, /owner \(700\)/i)

    expect(await screen.findByText(/server error/i)).toBeDefined()
    expect(screen.queryByText(/^Saved$/i)).toBeNull()
  })

  it("redirects retired floor URLs onto /settings/security", async () => {
    renderSettings("/orgs/1/settings/roster")
    await waitFor(() => expect(screen.getByRole("heading", { name: "Security" })).toBeInTheDocument())
    expect(screen.getByLabelText(/who can view the roster/i)).toBeDefined()
  })
})

describe("Settings index", () => {
  it("omits the Members settings row when the caller is below the roster floor", async () => {
    rosterSettings.canViewRoster = false
    renderSettings("/orgs/1/settings")
    await waitFor(() => expect(screen.getByText("Organization settings")).toBeInTheDocument())
    expect(screen.queryByRole("link", { name: "Members" })).not.toBeInTheDocument()
    expect(screen.getByRole("link", { name: /^security/i })).toBeInTheDocument()
  })

  it("links Security as a single row, not per-floor pages", async () => {
    renderSettings("/orgs/1/settings")
    await waitFor(() => expect(screen.getByText("Organization settings")).toBeInTheDocument())
    expect(screen.getByRole("link", { name: /^security/i })).toHaveAttribute("href", "/orgs/1/settings/security")
    expect(screen.queryByRole("link", { name: /roster & progress visibility/i })).not.toBeInTheDocument()
    expect(screen.queryByRole("link", { name: /export permissions/i })).not.toBeInTheDocument()
  })
})

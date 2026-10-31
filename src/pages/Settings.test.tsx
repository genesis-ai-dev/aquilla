import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, screen, waitFor, fireEvent } from "@testing-library/react"
import { MemoryRouter, Navigate, Route, Routes } from "react-router-dom"
import { OrgProvider } from "@/context/OrgContext"
import { Settings, OrgSettingsIdentity, OrgSettingsKnowledge, OrgSettingsSecurity } from "./Settings"
import { renameOrg, listMyOrgs, deleteOrg, OrgHasProjectsError } from "@/lib/frontier/orgs"
import { toast } from "@/components/ui/toast"

// AQU-1277: OrgProvider loads the project directory via
// fetchAccessibleProjectsResult, which catches its own network errors. Unmocked
// it reached production identity for real while the tests stayed green.
vi.mock("@/lib/sync/cloud-projects", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/sync/cloud-projects")>()),
  fetchAccessibleProjectsResult: vi.fn(async () => ({ ok: true as const, projects: [] })),
}))

// AQU-1771: the Security page's "N projects are stricter" counts.
vi.mock("@/lib/sync/org-settings", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/sync/org-settings")>()),
  fetchVisibilityOverrideCounts: vi.fn(async () => ({ rosterViewMinRole: 0, memberProgressViewMinRole: 0 })),
}))

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
  deleteOrg: vi.fn(async () => {}),
  OrgHasProjectsError: class OrgHasProjectsError extends Error {
    projectCount: number
    constructor(projectCount: number) {
      super("organization_has_projects")
      this.name = "OrgHasProjectsError"
      this.projectCount = projectCount
    }
  },
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
    // AQU-2304: import floor — default Project lead, i.e. what every org does
    // today until an owner raises it.
    importMinRole: 500,
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
  canEditImportFloor: (level: number | null | undefined) => (level ?? 0) >= 700,
}))

beforeEach(() => {
  localStorage.clear()
  rosterSettings.canViewRoster = true
  vi.mocked(listMyOrgs).mockResolvedValue([{ id: 1, name: "Come and See", role: { level: 700, name: "owner" } }])
  vi.mocked(deleteOrg).mockReset()
  vi.mocked(deleteOrg).mockResolvedValue(undefined)
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
          <Route path="/orgs/:orgId/overview" element={<div>Org overview</div>} />
          <Route path="/orgs/all" element={<div>All organizations</div>} />
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
  it("lists Billing on the settings index", async () => {
    renderSettings("/orgs/1/settings")
    expect(await screen.findByRole("link", { name: /^Billing/i })).toBeDefined()
  })

  it("links to and renders the organization knowledge base", async () => {
    const { unmount } = renderSettings("/orgs/1/settings")
    const link = await screen.findByRole("link", { name: /Knowledge base/i })
    expect(link).toHaveAttribute("href", "/orgs/1/settings/knowledge")
    unmount()

    renderSettings("/orgs/1/settings/knowledge")
    expect(await screen.findByRole("heading", { name: "Knowledge base" })).toBeInTheDocument()
    // The page header carries the description; the surface hides its own copy
    // (showTitle={false}), so it appears once. Let the document list settle
    // first — its empty state also says "every project in this organization",
    // and this assertion used to pass only by running before that render.
    expect(await screen.findByText("No knowledge documents yet")).toBeInTheDocument()
    expect(screen.getAllByText(/^Add reference documents that every project/i)).toHaveLength(1)
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
    expect(screen.queryByRole("button", { name: /delete organization/i })).toBeNull()
  })

  it("shows a Danger zone only to the owner", async () => {
    renderSettings("/orgs/1/settings/identity")
    expect(await screen.findByRole("button", { name: /delete organization/i })).toBeInTheDocument()
    expect(screen.getByText("Danger zone")).toBeInTheDocument()
  })

  it("hides the Danger zone from a maintainer who can still rename", async () => {
    vi.mocked(listMyOrgs).mockResolvedValueOnce([{ id: 1, name: "Come and See", role: { level: 600, name: "maintainer" } }])
    renderSettings("/orgs/1/settings/identity")
    const input = await screen.findByLabelText(/^Organization name$/i)
    await waitFor(() => expect(input).toHaveValue("Come and See"))
    expect(input).toBeEnabled()
    expect(screen.queryByRole("button", { name: /delete organization/i })).toBeNull()
  })

  it("leaves the organization in place when delete is cancelled", async () => {
    renderSettings("/orgs/1/settings/identity")
    fireEvent.click(await screen.findByRole("button", { name: /delete organization/i }))
    expect(await screen.findByRole("heading", { name: "Delete 'Come and See'?" })).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }))
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Delete 'Come and See'?" })).toBeNull())
    expect(deleteOrg).not.toHaveBeenCalled()
  })

  it("deletes the organization after confirm and switches to another org", async () => {
    renderSettings("/orgs/1/settings/identity")
    fireEvent.click(await screen.findByRole("button", { name: /delete organization/i }))
    vi.mocked(listMyOrgs).mockResolvedValueOnce([
      { id: 2, name: "Fresh workspace", role: { level: 700, name: "owner" } },
    ])
    fireEvent.click(await screen.findByRole("button", { name: /^confirm$/i }))
    await waitFor(() => expect(deleteOrg).toHaveBeenCalledWith("jwt", 1))
    expect(await screen.findByText("Org overview")).toBeInTheDocument()
    expect(localStorage.getItem("org:active")).toBe("2")
  })

  it("keeps the organization and explains when it still has projects", async () => {
    vi.mocked(deleteOrg).mockRejectedValueOnce(new OrgHasProjectsError(2))
    renderSettings("/orgs/1/settings/identity")
    fireEvent.click(await screen.findByRole("button", { name: /delete organization/i }))
    fireEvent.click(await screen.findByRole("button", { name: /^confirm$/i }))
    expect(await screen.findByRole("alert")).toHaveTextContent(/still has projects/i)
    expect(screen.getByLabelText(/^Organization name$/i)).toHaveValue("Come and See")
  })
})

describe("Security settings page", () => {
  it("renders visibility and permission controls on one page", async () => {
    renderSettings("/orgs/1/settings/security")
    await waitFor(() => expect(screen.getByRole("heading", { name: "Security" })).toBeInTheDocument())
    expect(screen.getByText("Visibility")).toBeInTheDocument()
    expect(screen.getByText("Permissions")).toBeInTheDocument()
    expect(screen.getByLabelText(/who can see the member list/i)).toBeDefined()
    expect(screen.getByLabelText(/who can see member progress/i)).toBeDefined()
    // Each permission's control, by role: its (i) is named "About …" too.
    expect(screen.getByRole("combobox", { name: /who can export/i })).toBeDefined()
    expect(screen.getByRole("combobox", { name: /who can assign work/i })).toBeDefined()
    expect(screen.getByRole("switch", { name: /allow self-assignment/i })).toBeDefined()
    expect(screen.getByRole("combobox", { name: /who can manage terminology/i })).toBeDefined()
    // AQU-2304: import sits with the other "Who can…" rows, beside languages.
    expect(screen.getByRole("combobox", { name: /who can import files/i })).toBeDefined()
  })

  it("shows one short line per permission and keeps the rest behind a click (i) (Sam, Oct 29)", async () => {
    renderSettings("/orgs/1/settings/security")
    await waitFor(() => expect(screen.getByRole("combobox", { name: /who can export/i })).toBeDefined())
    expect(screen.getByText("The lowest role that can export a project's deliverables.")).toBeVisible()
    const info = screen.getByRole("button", { name: "About Who can export" })
    const text = screen.getByTestId("settings-info-export-min-role-text")
    expect(info).toHaveAttribute("aria-expanded", "false")
    expect(text).toHaveAttribute("aria-hidden", "true")
    expect(text).toHaveTextContent(/CSV and TSV files are made in the browser/)
    fireEvent.click(info)
    expect(info).toHaveAttribute("aria-expanded", "true")
    expect(text).toHaveAttribute("data-open", "true")
    expect(text).toHaveAttribute("aria-hidden", "false")
    fireEvent.click(info)
    expect(text).toHaveAttribute("data-open", "false")
    for (const name of [
      "About Who can use Data egress",
      "About Who can assign work",
      "About Allow self-assignment",
      "About Allow language lane coordinators to assign work",
      "About Who can manage terminology",
      "About Who can change project languages",
      "About Who can import files",
    ]) {
      expect(screen.getByRole("button", { name })).toHaveAttribute("aria-expanded", "false")
    }
  })

  // ── AQU-2304: the org's import floor ──────────────────────────────────────
  it("offers exactly Project lead and Maintainer for the import floor", async () => {
    renderSettings("/orgs/1/settings/security")
    const trigger = await screen.findByRole("combobox", { name: /who can import files/i })
    fireEvent.click(trigger)
    const options = await screen.findAllByRole("option")
    // Anything below Project lead would be a control that does nothing —
    // `file.create`'s own static floor refuses a contributor regardless.
    expect(options.map((o) => o.textContent)).toEqual([
      expect.stringMatching(/^project lead — default/i),
      expect.stringMatching(/^maintainer — only maintainers/i),
    ])
  })

  it("patches the import floor on change — an owner reserves imports for maintainers (AQU-2304)", async () => {
    renderSettings("/orgs/1/settings/security")
    await waitFor(() => expect(screen.getByRole("combobox", { name: /who can import files/i })).toBeDefined())

    await pickSelectOption(/who can import files/i, /^maintainer/i)

    await waitFor(() => expect(mockPatch).toHaveBeenCalledWith({ importMinRole: 600 }))
    expect(screen.queryByText(/^Saved$/i)).toBeNull()
  })

  it("surfaces the owner-only refusal when a non-owner's import save is blocked", async () => {
    mockPatch.mockResolvedValueOnce({ kind: "blocked" as const })
    renderSettings("/orgs/1/settings/security")
    await waitFor(() => expect(screen.getByRole("combobox", { name: /who can import files/i })).toBeDefined())

    await pickSelectOption(/who can import files/i, /^maintainer/i)

    expect(await screen.findByText(/only org owners can change the import permission policy/i)).toBeDefined()
  })

  it("says importing files in the page's own intro sentence (AQU-2304)", async () => {
    renderSettings("/orgs/1/settings/security")
    await waitFor(() => expect(screen.getByRole("heading", { name: "Security" })).toBeInTheDocument())
    expect(screen.getByText(/who can export, assign, manage terms, import files/i)).toBeDefined()
  })

  it("patches export on change without a Saved acknowledgment", async () => {
    mockPatch.mockResolvedValueOnce({ kind: "ok", value: { orgId: 1, settings: {}, version: 2, updatedAt: null, updatedBy: null } })
    renderSettings("/orgs/1/settings/security")
    await waitFor(() => expect(screen.getByRole("combobox", { name: /who can export/i })).toBeDefined())

    await pickSelectOption(/who can export/i, /^contributor$/i)

    await waitFor(() => expect(mockPatch).toHaveBeenCalledWith({ exportMinRole: 400 }))
    expect(screen.queryByText(/^Saved$/i)).toBeNull()
    expect(toast.add).not.toHaveBeenCalled()
  })

  it("patches the egress floor on change — an owner opens Data egress to maintainers (AQU-907)", async () => {
    renderSettings("/orgs/1/settings/security")
    await waitFor(() => expect(screen.getByRole("combobox", { name: /who can use data egress/i })).toBeDefined())

    await pickSelectOption(/who can use data egress/i, /^maintainer$/i)

    await waitFor(() => expect(mockPatch).toHaveBeenCalledWith({ egressMinRole: 600 }))
  })

  it("surfaces a server error when the export save fails", async () => {
    mockPatch.mockResolvedValueOnce({ kind: "error" as const, status: 500, message: "Server error" })
    renderSettings("/orgs/1/settings/security")
    await waitFor(() => expect(screen.getByRole("combobox", { name: /who can export/i })).toBeDefined())

    await pickSelectOption(/who can export/i, /^contributor$/i)

    expect(await screen.findByText(/server error/i)).toBeDefined()
    expect(screen.queryByText(/^Saved$/i)).toBeNull()
  })

  it("silently patches the roster floor without a Saved acknowledgment", async () => {
    mockPatch.mockResolvedValueOnce({ kind: "ok", value: { orgId: 1, settings: { rosterViewMinRole: 400 }, version: 2, updatedAt: null, updatedBy: null } })
    renderSettings("/orgs/1/settings/security")
    await waitFor(() => expect(screen.getByLabelText(/who can see the member list/i)).toBeDefined())

    await pickSelectOption(/who can see the member list/i, /^contributor$/i)

    await waitFor(() => expect(mockPatch).toHaveBeenCalledWith({ rosterViewMinRole: 400 }))
    expect(screen.queryByText(/^Saved$/i)).toBeNull()
    expect(toast.add).not.toHaveBeenCalled()
  })

  it("surfaces a server error for the member-progress floor without a false Saved", async () => {
    mockPatch.mockResolvedValueOnce({ kind: "error" as const, status: 500, message: "Server error" })
    renderSettings("/orgs/1/settings/security")
    await waitFor(() => expect(screen.getByLabelText(/who can see member progress/i)).toBeDefined())

    await pickSelectOption(/who can see member progress/i, /^owner/i)

    expect(await screen.findByText(/server error/i)).toBeDefined()
    expect(screen.queryByText(/^Saved$/i)).toBeNull()
  })

  it("redirects retired floor URLs onto /settings/security", async () => {
    renderSettings("/orgs/1/settings/roster")
    await waitFor(() => expect(screen.getByRole("heading", { name: "Security" })).toBeInTheDocument())
    expect(screen.getByLabelText(/who can see the member list/i)).toBeDefined()
  })
})

describe("Settings index", () => {
  it("omits the Members settings row when the caller is below the roster floor", async () => {
    rosterSettings.canViewRoster = false
    renderSettings("/orgs/1/settings")
    await waitFor(() => expect(screen.getByRole("heading", { name: "Organization settings" })).toBeInTheDocument())
    expect(screen.queryByRole("link", { name: "Members" })).not.toBeInTheDocument()
    expect(screen.getByRole("link", { name: /^security/i })).toBeInTheDocument()
  })

  it("links Security as a single row, not per-floor pages", async () => {
    renderSettings("/orgs/1/settings")
    await waitFor(() => expect(screen.getByRole("heading", { name: "Organization settings" })).toBeInTheDocument())
    expect(screen.getByRole("link", { name: /^security/i })).toHaveAttribute("href", "/orgs/1/settings/security")
    expect(screen.queryByRole("link", { name: /roster & progress visibility/i })).not.toBeInTheDocument()
    expect(screen.queryByRole("link", { name: /export permissions/i })).not.toBeInTheDocument()
  })
})

// AQU-2260 (Sam, Oct 29, Settings cleanup 5c, option A): an org settings page
// you can open but not change is shown read-only, with one line at its top
// saying who can, and "View only" beside it in the settings list.
describe("Org settings you can open but not change (AQU-2260)", () => {
  const asRole = (level: number, name: string) =>
    vi.mocked(listMyOrgs).mockResolvedValue([{ id: 1, name: "Come and See", role: { level, name } }])

  it("a Maintainer reads Security with one line saying Owners change it", async () => {
    asRole(600, "maintainer")
    renderSettings("/orgs/1/settings/security")
    expect(await screen.findByTestId("org-settings-locked")).toHaveTextContent("Only Owners can change Security.")
    expect(screen.getAllByTestId("org-settings-locked")).toHaveLength(1)
    // Read-only, not hidden: the controls are still there to read.
    expect(screen.getByLabelText(/who can see the member list/i)).toBeDefined()
    // AQU-2304: and the import floor is one of them — readable, not writable.
    expect(screen.getByRole("combobox", { name: /who can import files/i })).toBeDisabled()
  })

  it("a Contributor reads Identity and Knowledge with the Maintainer line at the top", async () => {
    asRole(400, "contributor")
    renderSettings("/orgs/1/settings/identity")
    expect(await screen.findByTestId("org-settings-locked")).toHaveTextContent("Only Maintainers can change Identity.")
    expect(screen.getByLabelText(/^Organization name$/i)).toBeDisabled()
  })

  it("an Owner sees no lock line", async () => {
    renderSettings("/orgs/1/settings/security")
    await waitFor(() => expect(screen.getByRole("heading", { name: "Security" })).toBeInTheDocument())
    expect(screen.queryByTestId("org-settings-locked")).toBeNull()
  })

  it("the settings list says View only beside each page a Contributor cannot change", async () => {
    asRole(400, "contributor")
    renderSettings("/orgs/1/settings")
    const security = await screen.findByRole("link", { name: /^security/i })
    await waitFor(() => expect(security).toHaveTextContent("View only"))
    for (const name of [/^identity/i, /^ai provider keys/i, /^rules/i, /^monday\.com/i, /^airtable/i, /^project defaults/i]) {
      expect(screen.getByRole("link", { name })).toHaveTextContent("View only")
    }
  })

  it("for a Maintainer, only Security says View only", async () => {
    asRole(600, "maintainer")
    renderSettings("/orgs/1/settings")
    const security = await screen.findByRole("link", { name: /^security/i })
    await waitFor(() => expect(security).toHaveTextContent("View only"))
    expect(screen.getByRole("link", { name: /^identity/i })).not.toHaveTextContent("View only")
    expect(screen.getByRole("link", { name: /^project defaults/i })).not.toHaveTextContent("View only")
  })
})

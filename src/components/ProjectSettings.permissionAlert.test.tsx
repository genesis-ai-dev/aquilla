// AQU-623 — permission denials on shared settings must be REACHABLE on the
// locked control itself (GitHub-style), not as a page-level banner.
//
// A below-floor member's shared inputs are disabled up-front
// (DisabledFieldTooltip), so a role-blocked save never fires. The compact
// hint on each locked field names who can edit and offers a next-action
// link. These tests encode: the index has no page-level alert; hovering a
// locked field on a settings pane shows the hint; maintainer+ and unsynced
// local projects do not.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { screen, within } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { ProjectSettings } from "./ProjectSettings"
import type { ProjectRecord } from "@/lib/parsers/types"
import { renderWithTooltips } from "@/test-utils/tooltip"
import userEvent from "@testing-library/user-event"

const PROJECT_ID = "proj-permission-alert"

function makeProject(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: PROJECT_ID,
    name: "Permission Alert Test Project",
    files: [],
    sourceLanguage: "English",
    targetLanguage: "French",
    syncRole: { level: 100, source: "member" },
    ...overrides,
  } as unknown as ProjectRecord
}

let currentProject: ProjectRecord = makeProject()
let currentCanEdit = false
let currentReasonCannotEdit: "offline" | "role" | null = "role"
// AQU-1086: the language keys carry their own org-configurable floor, so the
// hook exposes a second gate for them. Defaults here mirror the hook-wide one
// (the org has not lowered languageEditMinRole).
let currentCanEditLanguages = false
let currentReasonCannotEditLanguages: "offline" | "role" | null = "role"
let currentLanguageEditFloor = 600
// AQU-1912: "Count headings" has its own project-lead gate.
let currentCanEditCountStructural = false
let currentReasonCannotEditCountStructural: "offline" | "role" | null = "role"
const languageLanes = [
  {
    id: "source-lane",
    role: "source" as const,
    language: "English",
    name: null,
    langCode: "en",
    legacyTag: "",
    position: 0,
    archivedAt: null,
  },
  {
    id: "target-lane",
    role: "target" as const,
    language: "French",
    name: null,
    langCode: "fr",
    legacyTag: "French",
    position: 1,
    archivedAt: null,
  },
]

vi.mock("@/hooks/useProject", () => ({
  useProject: () => ({
    project: currentProject,
    loading: false,
    refresh: vi.fn(),
  }),
}))

vi.mock("@/hooks/useProjectSettings", () => ({
  useProjectSettings: () => ({
    canEdit: currentCanEdit,
    reasonCannotEdit: currentReasonCannotEdit,
    canEditLanguages: currentCanEditLanguages,
    reasonCannotEditLanguages: currentReasonCannotEditLanguages,
    languageEditFloor: currentLanguageEditFloor,
    canEditCountStructural: currentCanEditCountStructural,
    reasonCannotEditCountStructural: currentReasonCannotEditCountStructural,
    patch: vi.fn().mockResolvedValue({ kind: "ok" }),
    version: 1,
    updatedAt: null,
    updatedBy: null,
    conflict: false,
    dismissConflict: vi.fn(),
    settings: {},
    lanes: languageLanes,
    renameLane: vi.fn().mockResolvedValue("ok"),
    createLane: vi.fn().mockResolvedValue({ kind: "ok" }),
    setLaneArchived: vi.fn().mockResolvedValue({ kind: "ok" }),
    hasFetched: true,
    isOnline: true,
    refresh: vi.fn(),
  }),
}))

// The validation pane's named-validator picker reads the roster.
vi.mock("@/hooks/useProjectMembers", () => ({
  useProjectMembers: () => ({
    members: [],
    isLoading: false,
    error: null,
    rosterHidden: false,
    refresh: vi.fn(),
  }),
}))

vi.mock("@/hooks/useOrg", () => ({
  useOrg: () => ({ org: null }),
}))

// AQU-2457: the lock lines' "View …" link opens PrivilegedMembersDialog, which
// reads the privileged roster. Stub the fetch so the dialog renders its list.
const { fetchPrivilegedProjectMembers } = vi.hoisted(() => ({
  fetchPrivilegedProjectMembers: vi.fn(),
}))
vi.mock("@/lib/frontier/members", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/frontier/members")>()
  return {
    ...actual,
    fetchPrivilegedProjectMembers: (...args: unknown[]) => fetchPrivilegedProjectMembers(...args),
  }
})

vi.mock("@/components/org/OrgSidebar", () => ({
  OrgSidebar: () => <div data-testid="org-sidebar">sidebar</div>,
}))
vi.mock("@/components/org/OrgBreadcrumb", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  OrgBreadcrumb: ({ section, trail }: any) => (
    <div data-testid="org-breadcrumb">
      {section}
      {(trail ?? []).map((t: { label: string }) => ` › ${t.label}`).join("")}
    </div>
  ),
}))

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "tok", username: "tester", email: "t@example.com" }, loading: false }),
}))

vi.mock("@/hooks/useAccounts", () => ({
  useAccounts: () => ({ active: null, sessions: [], loading: false, add: vi.fn(), activate: vi.fn(), remove: vi.fn() }),
}))

vi.mock("@/components/AccountSwitcher", () => ({
  AccountSwitcher: () => <div data-testid="account-switcher" />,
}))

vi.mock("@/hooks/useCompletionSettings", () => ({
  buildCompletionSettings: vi.fn((existing: unknown, updates: unknown) => ({ ...Object(existing), ...Object(updates) })),
  DEFAULT_SYSTEM_PROMPT: "Translate accurately.",
}))

vi.mock("@/lib/completion/completion-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/completion/completion-service")>()
  return {
    ...actual,
    fetchModels: vi.fn().mockResolvedValue([]),
    resolveProvider: vi.fn(() => "frontier"),
  }
})

vi.mock("@/lib/store/project-index", () => ({
  getProject: vi.fn().mockResolvedValue(null),
  updateProject: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("@/lib/progress/read-validation-count", () => ({
  readValidationCount: vi.fn(() => 1),
  readValidationCountAudio: vi.fn(() => 1),
}))

vi.mock("@/lib/store/user-api-keys", () => ({
  setUserApiKey: vi.fn(),
  useUserApiKey: vi.fn(() => null),
}))

vi.mock("@/lib/metrics/use-post-edit-metrics", () => ({
  usePostEditMetrics: () => ({
    metrics: null,
    isLoading: false,
    isError: false,
    revalidate: vi.fn(),
  }),
}))

function renderSettings(path = `/project/${PROJECT_ID}/settings`) {
  return renderWithTooltips(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/project/:id/settings" element={<ProjectSettings />} />
        <Route path="/project/:id/settings/:section" element={<ProjectSettings />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  fetchPrivilegedProjectMembers.mockResolvedValue({ kind: "ok", members: [] })
  currentProject = makeProject()
  currentCanEdit = false
  currentReasonCannotEdit = "role"
  currentCanEditLanguages = false
  currentReasonCannotEditLanguages = "role"
  currentLanguageEditFloor = 600
  currentCanEditCountStructural = false
  currentReasonCannotEditCountStructural = "role"
})

// AQU-2260 (Sam, Oct 29): no hovers. A card locked as a whole says so once
// under its heading ("Only Maintainers can change these settings."), and a
// single locked control says so in one line beneath it.
describe("ProjectSettings — per-control permission hint (AQU-623)", () => {
  it("does not show a page-level permission alert on the settings index", () => {
    renderSettings()
    expect(screen.queryByRole("alert")).toBeNull()
    expect(screen.queryByText(/doesn't have permission to change shared settings/i)).toBeNull()
  })

  it("viewer on a cloud project sees the hint on a locked field, without any save attempt", async () => {
    currentProject = makeProject({ syncRole: { level: 100, source: "member" } } as Partial<ProjectRecord>)
    renderSettings(`/project/${PROJECT_ID}/settings/general`)
    const title = screen.getByLabelText(/project name/i)
    expect(title).toBeDisabled()
    const projectInfo = screen.getAllByTestId("settings-group-locked")[0]!
    expect(projectInfo).toHaveTextContent("Only Maintainers can change these settings.")
    expect(within(projectInfo).getByRole("button", { name: /view maintainers/i })).toBeTruthy()
    await userEvent.setup().hover(title)
    expect(screen.queryByRole("tooltip")).toBeNull()
    expect(screen.queryByRole("link", { name: /view members/i })).toBeNull()
  })

  it("contributor on a cloud project sees the same per-control hint", async () => {
    currentProject = makeProject({ syncRole: { level: 400, source: "member" } } as Partial<ProjectRecord>)
    renderSettings(`/project/${PROJECT_ID}/settings/general`)
    expect(screen.getAllByTestId("settings-group-locked")[0]).toHaveTextContent("Only Maintainers can change these settings.")
    // Said once per card, never under each control of a card it already covers.
    expect(screen.queryByText("Only Maintainers can change this.")).toBeNull()
  })

  it("maintainer+ sees no lock hint", () => {
    currentProject = makeProject({ syncRole: { level: 600, source: "member" } } as Partial<ProjectRecord>)
    currentCanEdit = true
    currentReasonCannotEdit = null
    currentCanEditLanguages = true
    currentReasonCannotEditLanguages = null
    renderSettings(`/project/${PROJECT_ID}/settings/general`)
    expect(screen.getByLabelText(/project name/i)).not.toBeDisabled()
    expect(screen.queryByText(/Only Maintainers can change/)).toBeNull()
    expect(screen.queryByTestId("settings-group-locked")).toBeNull()
  })

  it("unsynced local project (hook reports reason 'role' with null level) shows no page alert", () => {
    currentProject = makeProject({ syncRole: undefined } as Partial<ProjectRecord>)
    renderSettings()
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("offline viewer on a cloud project shows no permission alert (offline is not a role denial)", () => {
    currentProject = makeProject({ syncRole: { level: 100, source: "member" } } as Partial<ProjectRecord>)
    currentReasonCannotEdit = "offline"
    renderSettings()
    expect(screen.queryByRole("alert")).toBeNull()
  })
})

// AQU-1086 / AQU-984 / AQU-1594: the lane language fields sit behind
// languageEditMinRole. The unset default is Project Lead, so a lead edits them.
// An org that stored Maintainer still locks them, and the hint names that role.
describe("ProjectSettings — org-configurable language floor (AQU-1086 / AQU-984)", () => {
  it("project lead sees the lane language fields locked when the org stored Maintainer, naming Maintainers", async () => {
    currentProject = makeProject({ syncRole: { level: 500, source: "member" } } as Partial<ProjectRecord>)
    renderSettings(`/project/${PROJECT_ID}/settings/general`)
    const source = screen.getByLabelText(/source language/i)
    expect(source).toBeDisabled()
    // Media redesign: one floor gates the whole card, so the row's ⋯ menu is
    // locked too, and the card says so once, under its title.
    expect(screen.getByTestId("lane-menu-target-lane")).toBeDisabled()
    expect(screen.getByTestId("languages-view-only")).toHaveTextContent("Only Maintainers can change these settings.")
  })

  it("a contributor below the unset default sees the language fields locked, naming Project Leads", async () => {
    currentProject = makeProject({ syncRole: { level: 400, source: "member" } } as Partial<ProjectRecord>)
    currentCanEditLanguages = false
    currentReasonCannotEditLanguages = "role"
    currentLanguageEditFloor = 500
    renderSettings(`/project/${PROJECT_ID}/settings/general`)
    const source = screen.getByLabelText(/source language/i)
    expect(source).toBeDisabled()
    expect(screen.getByTestId("languages-view-only")).toHaveTextContent("Only Project Leads can change these settings.")
  })

  it("project lead with the floor at 500 can edit the lane language fields", () => {
    currentProject = makeProject({
      syncRole: { level: 500, source: "member" },
      languageEditMinRole: 500,
    } as Partial<ProjectRecord>)
    currentCanEditLanguages = true
    currentReasonCannotEditLanguages = null
    currentLanguageEditFloor = 500
    renderSettings(`/project/${PROJECT_ID}/settings/general`)
    expect(screen.getByLabelText(/source language/i)).not.toBeDisabled()
    expect(screen.getByTestId("lane-menu-target-lane")).not.toBeDisabled()
    expect(screen.queryByTestId("languages-view-only")).toBeNull()
  })

  it("lowering the language floor does not unlock any other shared field", async () => {
    currentProject = makeProject({
      syncRole: { level: 500, source: "member" },
      languageEditMinRole: 500,
    } as Partial<ProjectRecord>)
    currentCanEditLanguages = true
    currentReasonCannotEditLanguages = null
    currentLanguageEditFloor = 500
    // canEdit (the hook-wide maintainer floor) stays false — see beforeEach.
    renderSettings(`/project/${PROJECT_ID}/settings/general`)
    const title = screen.getByLabelText(/project name/i)
    expect(title).toBeDisabled()
    expect(screen.getAllByTestId("settings-group-locked")[0]).toHaveTextContent("Only Maintainers can change these settings.")
    expect(screen.queryByTestId("languages-view-only")).toBeNull()
  })
})

// AQU-1912: the server has let a project lead change "Count headings" since
// AQU-1083; the page gated the control on the maintainer floor instead.
describe("ProjectSettings — Count headings follows its own project-lead floor (AQU-1912)", () => {
  const headingsControl = () =>
    screen.getByRole("switch", { name: /count headings as translatable content/i })

  it("a project lead can change it while the rest of the validation card stays locked", () => {
    currentProject = makeProject({ syncRole: { level: 500, source: "member" } } as Partial<ProjectRecord>)
    currentCanEditCountStructural = true
    currentReasonCannotEditCountStructural = null
    renderSettings(`/project/${PROJECT_ID}/settings/validation`)
    expect(headingsControl()).not.toHaveAttribute("aria-disabled", "true")
    // canEdit (maintainer) stays false — see beforeEach.
    expect(screen.getByRole("switch", { name: /auto-propagate repetitions/i })).toHaveAttribute("aria-disabled", "true")
  })

  it("a contributor sees it locked, and the hint names Project Leads", async () => {
    currentProject = makeProject({ syncRole: { level: 400, source: "member" } } as Partial<ProjectRecord>)
    renderSettings(`/project/${PROJECT_ID}/settings/validation`)
    expect(headingsControl()).toHaveAttribute("aria-disabled", "true")
    // The card says Maintainers once; Count headings, locked for another
    // reason, says its own line beneath it (AQU-2260). What the organization
    // does is on the menu beside it (AQU-2263).
    expect(screen.getAllByTestId("settings-group-locked")[0]).toHaveTextContent("Only Maintainers can change these settings.")
    expect(screen.getByText("Only Project Leads can change this.")).toBeVisible()
    expect(screen.getByTestId("count-structural-cells-source")).toHaveTextContent(/Organization default/)
  })
})

// AQU-2457: there is one PrivilegedMembersDialog behind every lock line, and it
// used to be handed the page-wide Maintainer role no matter which line opened
// it — so "View project leads" under the Languages card opened a dialog
// titled "Maintainers", contradicting the line above it. The dialog now names,
// and asks the server for, the floor of the section that opened it.
describe("ProjectSettings — the privileged-members dialog matches the section that opened it (AQU-2457)", () => {
  it("Languages → View project leads names Project Leads and asks for that floor", async () => {
    currentProject = makeProject({ syncRole: { level: 400, source: "member" } } as Partial<ProjectRecord>)
    currentLanguageEditFloor = 500
    renderSettings(`/project/${PROJECT_ID}/settings/general`)
    const languagesLock = screen.getByTestId("languages-view-only")
    expect(languagesLock).toHaveTextContent("Only Project Leads can change these settings.")
    await userEvent.setup().click(
      within(languagesLock).getByRole("button", { name: /view project leads/i }),
    )
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByRole("heading", { name: /^project leads$/i })).toBeTruthy()
    expect(within(dialog).getByText(/only project leads can change these settings/i)).toBeTruthy()
    expect(fetchPrivilegedProjectMembers).toHaveBeenCalledWith("tok", PROJECT_ID, 500)
  })

  it("an org that raised the language floor to Maintainer gets a Maintainers dialog from the same line", async () => {
    currentProject = makeProject({ syncRole: { level: 400, source: "member" } } as Partial<ProjectRecord>)
    currentLanguageEditFloor = 600
    renderSettings(`/project/${PROJECT_ID}/settings/general`)
    const languagesLock = screen.getByTestId("languages-view-only")
    expect(languagesLock).toHaveTextContent("Only Maintainers can change these settings.")
    await userEvent.setup().click(
      within(languagesLock).getByRole("button", { name: /view maintainers/i }),
    )
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByRole("heading", { name: /^maintainers$/i })).toBeTruthy()
    expect(fetchPrivilegedProjectMembers).toHaveBeenCalledWith("tok", PROJECT_ID, 600)
  })

  it("a Maintainer-only section still opens the Maintainers dialog", async () => {
    currentProject = makeProject({ syncRole: { level: 400, source: "member" } } as Partial<ProjectRecord>)
    renderSettings(`/project/${PROJECT_ID}/settings/general`)
    const projectInfo = screen.getAllByTestId("settings-group-locked")[0]!
    await userEvent.setup().click(
      within(projectInfo).getByRole("button", { name: /view maintainers/i }),
    )
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByRole("heading", { name: /^maintainers$/i })).toBeTruthy()
    expect(fetchPrivilegedProjectMembers).toHaveBeenCalledWith("tok", PROJECT_ID, 600)
  })

  it("Count headings → View project leads names Project Leads, not the card's Maintainers", async () => {
    currentProject = makeProject({ syncRole: { level: 400, source: "member" } } as Partial<ProjectRecord>)
    renderSettings(`/project/${PROJECT_ID}/settings/validation`)
    // The only Project-Lead lock line on this pane; the card's own line above
    // it says Maintainers.
    expect(screen.getByText("Only Project Leads can change this.")).toBeVisible()
    await userEvent.setup().click(
      screen.getByRole("button", { name: /view project leads/i }),
    )
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByRole("heading", { name: /^project leads$/i })).toBeTruthy()
    expect(fetchPrivilegedProjectMembers).toHaveBeenCalledWith("tok", PROJECT_ID, 500)
  })
})

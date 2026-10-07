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
import { screen } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { ProjectSettings } from "./ProjectSettings"
import type { ProjectRecord } from "@/lib/parsers/types"
import { expectTooltip, renderWithTooltips } from "@/test-utils/tooltip"

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
    patch: vi.fn().mockResolvedValue({ kind: "ok" }),
    version: 1,
    updatedAt: null,
    updatedBy: null,
    conflict: false,
    dismissConflict: vi.fn(),
    settings: {},
    hasFetched: true,
    isOnline: true,
    refresh: vi.fn(),
  }),
}))

vi.mock("@/hooks/useOrg", () => ({
  useOrg: () => ({ org: null }),
}))

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
  currentProject = makeProject()
  currentCanEdit = false
  currentReasonCannotEdit = "role"
  currentCanEditLanguages = false
  currentReasonCannotEditLanguages = "role"
  currentLanguageEditFloor = 600
})

describe("ProjectSettings — per-control permission hint (AQU-623)", () => {
  it("does not show a page-level permission alert on the settings index", () => {
    renderSettings()
    expect(screen.queryByRole("alert")).toBeNull()
    expect(screen.queryByText(/doesn't have permission to change shared settings/i)).toBeNull()
  })

  it("viewer on a cloud project sees the hint on a locked field, without any save attempt", async () => {
    currentProject = makeProject({ syncRole: { level: 100, source: "member" } } as Partial<ProjectRecord>)
    renderSettings(`/project/${PROJECT_ID}/settings/general`)
    const title = screen.getByLabelText(/title/i)
    expect(title).toBeDisabled()
    await expectTooltip(title, /Only Maintainers can modify/)
    expect(screen.getByRole("button", { name: /view maintainers/i })).toBeTruthy()
    expect(screen.queryByRole("link", { name: /view members/i })).toBeNull()
  })

  it("contributor on a cloud project sees the same per-control hint", async () => {
    currentProject = makeProject({ syncRole: { level: 400, source: "member" } } as Partial<ProjectRecord>)
    renderSettings(`/project/${PROJECT_ID}/settings/general`)
    await expectTooltip(screen.getByLabelText(/title/i), /Only Maintainers can modify/)
  })

  it("maintainer+ sees no lock hint", () => {
    currentProject = makeProject({ syncRole: { level: 600, source: "member" } } as Partial<ProjectRecord>)
    currentCanEdit = true
    currentReasonCannotEdit = null
    renderSettings(`/project/${PROJECT_ID}/settings/general`)
    expect(screen.getByLabelText(/title/i)).not.toBeDisabled()
    expect(screen.queryByText(/Only Maintainers can modify/)).toBeNull()
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

// AQU-1086: the Source/Target language fields sit behind the org's
// configurable languageEditMinRole rather than the hook-wide maintainer floor.
// Two things must hold: at the default the fields look exactly as they did
// before, and with the floor lowered a project lead gets the fields WITHOUT
// the rest of the form unlocking.
describe("ProjectSettings — org-configurable language floor (AQU-1086)", () => {
  it("project lead at the default floor sees the language fields locked, naming Maintainers", async () => {
    currentProject = makeProject({ syncRole: { level: 500, source: "member" } } as Partial<ProjectRecord>)
    renderSettings(`/project/${PROJECT_ID}/settings/general`)
    const source = screen.getByLabelText(/source language/i)
    expect(source).toBeDisabled()
    await expectTooltip(source, /Only Maintainers can modify/)
  })

  it("project lead with the floor lowered to 500 can edit the language fields", () => {
    currentProject = makeProject({
      syncRole: { level: 500, source: "member" },
      languageEditMinRole: 500,
    } as Partial<ProjectRecord>)
    currentCanEditLanguages = true
    currentReasonCannotEditLanguages = null
    currentLanguageEditFloor = 500
    renderSettings(`/project/${PROJECT_ID}/settings/general`)
    expect(screen.getByLabelText(/source language/i)).not.toBeDisabled()
    expect(screen.getByLabelText(/target language/i)).not.toBeDisabled()
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
    const title = screen.getByLabelText(/title/i)
    expect(title).toBeDisabled()
    await expectTooltip(title, /Only Maintainers can modify/)
  })
})

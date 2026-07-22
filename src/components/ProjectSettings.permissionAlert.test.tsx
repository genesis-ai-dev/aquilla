// AQU-623 (live-QA finding) — the permission-denied alert must be REACHABLE.
//
// The alert originally rendered only after a shared-settings PATCH came back
// role-blocked. But a below-floor member's shared inputs are disabled up-front
// (DisabledFieldTooltip), so that save could never fire and the alert was
// unreachable in the normal flow — QA only ever saw the hover tooltips. These
// tests encode the fix: on a cloud project the alert renders persistently for
// a below-floor role (naming the role + linking the permission docs), never
// for maintainer+, and never on an unsynced local project (whose hook also
// reports reason "role" because roleLevel is null, but which has no
// shared-settings permission model).

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { ProjectSettings } from "./ProjectSettings"
import type { ProjectRecord } from "@/lib/parsers/types"

const PROJECT_ID = "proj-permission-alert"

// The settings shell renders the org sidebar/breadcrumb, which need an
// OrgProvider — mock them out like the other ProjectSettings tests do.
vi.mock("@/components/org/OrgSidebar", () => ({
  OrgSidebar: () => <div data-testid="org-sidebar">sidebar</div>,
}))
vi.mock("@/components/org/OrgBreadcrumb", () => ({
  OrgBreadcrumb: () => <div data-testid="org-breadcrumb" />,
}))

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

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "tok", username: "tester", email: "t@example.com" }, loading: false }),
}))

vi.mock("@/hooks/useAccounts", () => ({
  useAccounts: () => ({ active: null, sessions: [], loading: false, add: vi.fn(), activate: vi.fn(), remove: vi.fn() }),
}))

// The alert falls back to AccountSwitcher (full auth-dialog tree) when no
// other session exists; stub it — these tests are about reachability, not
// the switch-user affordance (covered in PermissionDeniedAlert.test.tsx).
vi.mock("@/components/AccountSwitcher", () => ({
  AccountSwitcher: () => <div data-testid="account-switcher" />,
}))

vi.mock("@/hooks/useCompletionSettings", () => ({
  buildCompletionSettings: vi.fn((existing: unknown, updates: unknown) => ({ ...Object(existing), ...Object(updates) })),
  DEFAULT_SYSTEM_PROMPT: "Translate accurately.",
}))

vi.mock("@/lib/completion/completion-service", () => ({
  fetchModels: vi.fn().mockResolvedValue([]),
  resolveProvider: vi.fn(() => "frontier"),
  FRONTIER_CHAT_URL: "https://api.aquilla.app/chat/api/v1/chat/completions",
}))

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

function renderSettings() {
  return render(
    <MemoryRouter initialEntries={[`/project/${PROJECT_ID}/settings`]}>
      <Routes>
        <Route path="/project/:id/settings" element={<ProjectSettings />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  currentProject = makeProject()
  currentCanEdit = false
  currentReasonCannotEdit = "role"
})

describe("ProjectSettings — persistent permission-denied alert (AQU-623)", () => {
  it("viewer on a cloud project sees the alert naming their role, without any save attempt", () => {
    currentProject = makeProject({ syncRole: { level: 100, source: "member" } } as Partial<ProjectRecord>)
    renderSettings()
    const alert = screen.getByRole("alert")
    expect(alert).toHaveTextContent(
      "You're signed in as tester (t@example.com) — your role on this project is Viewer, which doesn't have permission to change shared settings (needs Maintainer or higher).",
    )
    expect(
      screen.getByRole("link", { name: /learn about permission levels/i }),
    ).toHaveAttribute("target", "_blank")
  })

  it("contributor on a cloud project sees the alert with their role name", () => {
    currentProject = makeProject({ syncRole: { level: 400, source: "member" } } as Partial<ProjectRecord>)
    renderSettings()
    expect(screen.getByRole("alert")).toHaveTextContent(
      "your role on this project is Contributor",
    )
  })

  it("maintainer+ sees no alert", () => {
    currentProject = makeProject({ syncRole: { level: 600, source: "member" } } as Partial<ProjectRecord>)
    currentCanEdit = true
    currentReasonCannotEdit = null
    renderSettings()
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("unsynced local project (hook reports reason 'role' with null level) shows no alert", () => {
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

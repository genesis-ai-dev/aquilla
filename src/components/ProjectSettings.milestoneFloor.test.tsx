// AQU-2309 — "Who can set milestones", in Project Settings → Content structure.
//
// Two rungs: Maintainer (the default when the project has never set it) and
// Project Lead. Changing it patches `milestoneFloor` and nothing else. It sits
// beside "Who can add and remove cells" and reuses that control's role names.
// A project lead sees the control and cannot change it. A contributor does
// not see it.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { screen, within } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { ProjectSettings } from "./ProjectSettings"
import type { ProjectRecord } from "@/lib/parsers/types"
import { renderWithTooltips } from "@/test-utils/tooltip"
import userEvent from "@testing-library/user-event"
import { ROLE } from "@/lib/frontier/roles"

const PROJECT_ID = "proj-milestone-floor"

function makeProject(overrides: object = {}): ProjectRecord {
  return {
    id: PROJECT_ID,
    name: "Milestone Floor Settings Test Project",
    files: [],
    sourceLanguage: "English",
    targetLanguage: "French",
    syncRole: { level: 600, source: "member" },
    ...overrides,
  } as unknown as ProjectRecord
}

const patchSpy = vi.fn().mockResolvedValue({ kind: "ok" })

let currentProject: ProjectRecord = makeProject()

vi.mock("@/hooks/useProject", () => ({
  useProject: () => ({
    project: currentProject,
    loading: false,
    refresh: vi.fn(),
  }),
}))

vi.mock("@/hooks/useProjectSettings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/useProjectSettings")>()
  const { useLiveProjectSettings } = await import("@/test-utils/live-project-settings")
  return {
    ...actual,
    useProjectSettings: () =>
      useLiveProjectSettings(() => ({
        settings: {},
        patch: patchSpy,
        canEdit: (currentProject.syncRole?.level ?? ROLE.MAINTAINER) >= ROLE.MAINTAINER,
        reasonCannotEdit:
          (currentProject.syncRole?.level ?? ROLE.MAINTAINER) >= ROLE.MAINTAINER ? null : "role",
      })),
  }
})

vi.mock("@/hooks/useOrg", () => ({
  useOrg: () => ({ org: null }),
}))

vi.mock("@/components/org/OrgSidebar", () => ({
  OrgSidebar: () => <div data-testid="org-sidebar">sidebar</div>,
}))
vi.mock("@/components/org/OrgBreadcrumb", () => ({
  OrgBreadcrumb: ({ section, trail }: { section: string; trail?: { label: string }[] }) => (
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
  patchProject: vi.fn().mockResolvedValue(null),
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

function renderSettings(path = `/project/${PROJECT_ID}/settings/general`) {
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
})

describe("ProjectSettings — who can set milestones (AQU-2309)", () => {
  it("shows Maintainer for a project that never set it", () => {
    renderSettings()
    expect(screen.getByTestId("settings-milestone-floor")).toHaveTextContent("Maintainer")
    expect(screen.getByText("Who can set milestones")).toBeInTheDocument()
  })

  it("reads back the project-lead rung", () => {
    currentProject = makeProject({ milestoneFloor: "project_lead" })
    renderSettings()
    expect(screen.getByTestId("settings-milestone-floor")).toHaveTextContent("Project Lead")
  })

  it("offers exactly the two rungs, between cell editing and cell labels", async () => {
    const user = userEvent.setup()
    renderSettings()
    const editing = screen.getByTestId("settings-cell-editing-floor")
    const milestone = screen.getByTestId("settings-milestone-floor")
    const label = screen.getByTestId("settings-cell-label-floor")
    expect(editing.compareDocumentPosition(milestone) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(milestone.compareDocumentPosition(label) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    await user.click(milestone)
    const listbox = await screen.findByRole("listbox")
    const names = within(listbox).getAllByRole("option").map((o) => o.textContent?.trim())
    expect(names).toEqual(["Maintainer", "Project Lead"])
  })

  it("saves the chosen rung as milestoneFloor, and touches nothing else", async () => {
    const user = userEvent.setup()
    renderSettings()
    await user.click(screen.getByTestId("settings-milestone-floor"))
    await user.click(await screen.findByRole("option", { name: "Project Lead" }))

    expect(patchSpy).toHaveBeenCalledTimes(1)
    const sent = patchSpy.mock.calls[0][0] as Record<string, unknown>
    expect(sent).toEqual({ milestoneFloor: "project_lead" })
  })

  it("shows the control disabled to a project lead", () => {
    currentProject = makeProject({ syncRole: { level: ROLE.PROJECT_LEAD, source: "member" } })
    renderSettings()
    const control = screen.getByTestId("settings-milestone-floor")
    expect(control).toBeDisabled()
    expect(control).toHaveTextContent("Maintainer")
    expect(patchSpy).not.toHaveBeenCalled()
  })

  it.each([
    ["a contributor", ROLE.CONTRIBUTOR],
    ["a reviewer", ROLE.REVIEWER],
    ["a viewer", ROLE.VIEWER],
  ])("does not show the control to %s", (_who, level) => {
    currentProject = makeProject({ syncRole: { level, source: "member" } })
    renderSettings()
    expect(screen.queryByTestId("settings-milestone-floor")).toBeNull()
    expect(screen.getByTestId("settings-cell-editing-floor")).toBeInTheDocument()
  })

  it("shows the control on a local project that has no membership role", () => {
    currentProject = makeProject({ syncRole: undefined })
    renderSettings()
    expect(screen.getByTestId("settings-milestone-floor")).toBeEnabled()
  })
})

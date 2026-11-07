// AQU-2408 — "Who can label cells", in Project Settings → Content structure.
//
// Two rungs only: Maintainer (the default when the project has never set it)
// and Project Lead. Changing it patches `cellLabelFloor` and nothing else, the
// moment it changes (AQU-2262). It sits beside the cell-editing tier and reuses
// that control's role names, so the two read the same.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { screen, within } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { ProjectSettings } from "./ProjectSettings"
import type { ProjectRecord } from "@/lib/parsers/types"
import { renderWithTooltips } from "@/test-utils/tooltip"
import userEvent from "@testing-library/user-event"

const PROJECT_ID = "proj-cell-label"

function makeProject(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: PROJECT_ID,
    name: "Cell Label Settings Test Project",
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
        canEdit: true,
        reasonCannotEdit: null,
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

describe("ProjectSettings — who can label cells (AQU-2408)", () => {
  it("shows Maintainer for a project that never set it — the default is a rank, not a refusal", () => {
    renderSettings()
    expect(screen.getByTestId("settings-cell-label-floor")).toHaveTextContent("Maintainer")
  })

  it("reads back the project-lead rung", () => {
    currentProject = makeProject({ cellLabelFloor: "project_lead" } as Partial<ProjectRecord>)
    renderSettings()
    expect(screen.getByTestId("settings-cell-label-floor")).toHaveTextContent("Project Lead")
  })

  it("offers exactly the two rungs, beside the cell-editing tier", async () => {
    const user = userEvent.setup()
    renderSettings()
    expect(screen.getByTestId("settings-cell-editing-floor")).toBeInTheDocument()
    await user.click(screen.getByTestId("settings-cell-label-floor"))
    const listbox = await screen.findByRole("listbox")
    const names = within(listbox).getAllByRole("option").map((o) => o.textContent?.trim())
    expect(names).toEqual(["Maintainer", "Project Lead"])
  })

  it("saves the chosen rung as cellLabelFloor, and touches nothing else", async () => {
    const user = userEvent.setup()
    renderSettings()
    await user.click(screen.getByTestId("settings-cell-label-floor"))
    await user.click(await screen.findByRole("option", { name: "Project Lead" }))

    expect(patchSpy).toHaveBeenCalledTimes(1)
    const sent = patchSpy.mock.calls[0][0] as Record<string, unknown>
    expect(sent).toEqual({ cellLabelFloor: "project_lead" })
  })
})

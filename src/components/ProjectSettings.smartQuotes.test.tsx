// Smart quotes, in Project Settings › General under the target language.
//
// What these tests hold: a project that never set it shows the switch OFF —
// curly quotes rewrite what translators type, so nobody gets them without
// asking; a stored `true` reads back ON; and flipping the switch patches
// `smartQuotes` and nothing else, so saving it cannot disturb another setting.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { screen } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { ProjectSettings } from "./ProjectSettings"
import type { ProjectRecord } from "@/lib/parsers/types"
import { renderWithTooltips } from "@/test-utils/tooltip"
import userEvent from "@testing-library/user-event"

// AQU-1573: the Reference Bible card lists the server's Bibles when the General
// pane renders on a cloud project; answer locally (none installed).
vi.mock("@/lib/frontier/reference-bibles", () => ({
  fetchReferenceBibles: vi.fn(async () => []),
  fetchReferencePassages: vi.fn(async () => null),
}))

const PROJECT_ID = "proj-smart-quotes"

function makeProject(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: PROJECT_ID,
    name: "Smart Quotes Settings Test Project",
    files: [],
    sourceLanguage: "English",
    targetLanguage: "French",
    syncRole: { level: 600, source: "member" },
    ...overrides,
  } as unknown as ProjectRecord
}

const patchSpy = vi.fn().mockResolvedValue({ kind: "ok" })

let currentProject: ProjectRecord = makeProject()
let currentCanEdit = true
let currentReasonCannotEdit: "offline" | "role" | null = null
let currentSettings: Record<string, unknown> = {}

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
    patch: patchSpy,
    version: 1,
    updatedAt: null,
    updatedBy: null,
    conflict: false,
    dismissConflict: vi.fn(),
    settings: currentSettings,
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

const PANE = `/project/${PROJECT_ID}/settings/general`

beforeEach(() => {
  vi.clearAllMocks()
  currentProject = makeProject()
  currentCanEdit = true
  currentReasonCannotEdit = null
  currentSettings = {}
})

describe("ProjectSettings — smart quotes", () => {
  it("is off for a project that never set it", () => {
    renderSettings(PANE)
    expect(screen.getByRole("switch", { name: "Smart quotes" })).not.toBeChecked()
  })

  // This page loads the project without the settings overlay, so the stored
  // value exists only in the settings blob. Reading `project.smartQuotes`
  // alone showed a saved ON as OFF after every reload.
  it("reads back a stored true from the settings blob", () => {
    currentSettings = { smartQuotes: true }
    renderSettings(PANE)
    expect(screen.getByRole("switch", { name: "Smart quotes" })).toBeChecked()
  })

  it("saves the switch as smartQuotes, and touches nothing else", async () => {
    const user = userEvent.setup()
    renderSettings(PANE)

    await user.click(screen.getByRole("switch", { name: "Smart quotes" }))
    await user.click(screen.getByRole("button", { name: /save changes/i }))

    expect(patchSpy).toHaveBeenCalledTimes(1)
    const sent = patchSpy.mock.calls[0][0] as Record<string, unknown>
    expect(sent).toEqual({ smartQuotes: true })
  })
})

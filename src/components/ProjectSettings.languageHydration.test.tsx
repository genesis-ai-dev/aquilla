// AQU-1594 — source and target languages are lane rows. A settings blob that
// still carries the old project-level keys must not fill the lane editors or
// mark General dirty. A lane with no language stays empty, and a draft the
// user has started typing survives a later settings GET.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { ProjectSettings } from "./ProjectSettings"

vi.mock("@/components/org/OrgSidebar", () => ({
  OrgSidebar: () => <div data-testid="org-sidebar">sidebar</div>,
}))
vi.mock("@/components/org/OrgBreadcrumb", () => ({
  OrgBreadcrumb: ({ section, trail }: { section?: string; trail?: { label: string }[] }) => (
    <div data-testid="org-breadcrumb">
      {section}
      {(trail ?? []).map((t: { label: string }) => ` › ${t.label}`).join("")}
    </div>
  ),
}))

import type { ProjectRecord } from "@/lib/parsers/types"
import type { ProjectWideSettings } from "@/lib/sync/project-settings"

const PROJECT_ID = "proj-language-hydration"

/** Mirrors `minimalProjectRecord`: the server summary carries no languages, so
 *  the record this page sees always has them as empty strings. */
function makeProject(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: PROJECT_ID,
    name: "Language Hydration Test Project",
    files: [],
    sourceLanguage: "",
    targetLanguage: "",
    syncRole: { level: 700, source: "creator" },
    ...overrides,
  } as unknown as ProjectRecord
}

let currentProject: ProjectRecord = makeProject()
let currentSettings: ProjectWideSettings = {}
let currentHasFetched = true
let currentLanes = [
  {
    id: "source-lane",
    role: "source" as const,
    language: "",
    name: null,
    langCode: null,
    legacyTag: "",
    position: 0,
    archivedAt: null,
  },
  {
    id: "target-lane",
    role: "target" as const,
    language: "",
    name: null,
    langCode: null,
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
    canEdit: true,
    reasonCannotEdit: null,
    canEditLanguages: true,
    reasonCannotEditLanguages: null,
    patch: vi.fn().mockResolvedValue({ kind: "ok" }),
    lanes: currentLanes,
    renameLane: vi.fn().mockResolvedValue("ok"),
    createLane: vi.fn().mockResolvedValue({ kind: "ok" }),
    setLaneArchived: vi.fn().mockResolvedValue({ kind: "ok" }),
    version: 1,
    updatedAt: null,
    updatedBy: null,
    conflict: false,
    dismissConflict: vi.fn(),
    settings: currentSettings,
    hasFetched: currentHasFetched,
    isOnline: true,
    refresh: vi.fn(),
  }),
}))

vi.mock("@/hooks/useOrg", () => ({
  useOrg: () => ({ org: null }),
}))

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "tok", username: "tester" }, loading: false }),
}))

vi.mock("@/hooks/useAccounts", () => ({
  useAccounts: () => ({ active: null, sessions: [], loading: false, add: vi.fn(), activate: vi.fn(), remove: vi.fn() }),
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

// A FRESH element every call: `rerender()` with a referentially identical
// element lets React bail out of reconciliation, so the second hydration phase
// would never be observed.
const tree = () => (
  <MemoryRouter initialEntries={[`/project/${PROJECT_ID}/settings/general`]}>
    <Routes>
      <Route path="/project/:id/settings" element={<ProjectSettings />} />
      <Route path="/project/:id/settings/:section" element={<ProjectSettings />} />
    </Routes>
  </MemoryRouter>
)

function renderSettings() {
  return render(tree())
}

const sourceField = () => screen.getByLabelText(/source language/i) as HTMLInputElement

function sourceLane(language: string) {
  return { ...currentLanes[0]!, language }
}

function targetLane(language: string) {
  return { ...currentLanes[1]!, language }
}

beforeEach(() => {
  vi.clearAllMocks()
  currentProject = makeProject()
  currentSettings = {}
  currentHasFetched = true
  currentLanes = [sourceLane(""), targetLane("")]
})

describe("ProjectSettings — languages live on the lane, not Project Info (AQU-1594)", () => {
  it("shows the lane's language, not a project-level settings key", () => {
    currentSettings = { sourceLanguage: "Spanish", targetLanguage: "German" }
    currentLanes = [sourceLane("English"), targetLane("French")]
    renderSettings()
    expect(sourceField().value).toBe("English")
    expect((screen.getByTestId("lane-language-target-lane") as HTMLInputElement).value).toBe("French")
    expect(screen.queryByRole("button", { name: /save changes/i })).toBeNull()
  })

  it("a later settings blob does not rewrite the lane fields or dirty the form", () => {
    currentSettings = {}
    currentHasFetched = false
    currentLanes = [sourceLane("English"), targetLane("French")]
    const { rerender } = renderSettings()
    expect(sourceField().value).toBe("English")

    currentSettings = { sourceLanguage: "Spanish", targetLanguage: "German" }
    currentHasFetched = true
    rerender(tree())

    expect(sourceField().value).toBe("English")
    expect((screen.getByTestId("lane-language-target-lane") as HTMLInputElement).value).toBe("French")
    expect(screen.queryByRole("button", { name: /save changes/i })).toBeNull()
  })

  it("leaves a genuinely empty lane language empty", () => {
    currentSettings = { sourceLanguage: "English", targetLanguage: "French" }
    renderSettings()
    expect(sourceField().value).toBe("")
    expect((screen.getByTestId("lane-language-target-lane") as HTMLInputElement).value).toBe("")
  })

  it("shows a free-text lane language outside the catalog verbatim", () => {
    currentLanes = [sourceLane("Grade 7 English"), targetLane("Kâ-nêhiyawêt")]
    renderSettings()
    expect(sourceField().value).toBe("Grade 7 English")
    expect((screen.getByTestId("lane-language-target-lane") as HTMLInputElement).value).toBe("Kâ-nêhiyawêt")
  })

  it("never stomps a language the user typed when the settings blob arrives", () => {
    currentSettings = {}
    currentHasFetched = false
    const { rerender } = renderSettings()

    fireEvent.change(sourceField(), { target: { value: "Koine Greek" } })
    expect(sourceField().value).toBe("Koine Greek")

    currentSettings = { sourceLanguage: "English", targetLanguage: "French" }
    currentHasFetched = true
    rerender(tree())

    expect(sourceField().value).toBe("Koine Greek")
  })
})

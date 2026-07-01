// FRO-460 — Bible resources derive-on-read UI tests.
//
// Why these tests exist: the prior design persisted `bibleResourcesEnabled`
// via a load-time effect, which silently re-enabled an explicit OFF (a trust
// bug). The redesign never writes on load — the switch DISPLAYS a derived
// effective value (explicit ?? isScriptureProject) and only persists what the
// user explicitly toggles. These tests encode that:
//   1. A scripture project with the setting UNSET shows the switch ON
//      (derived default) WITHOUT that being a "saved" state — no dirty flag.
//   2. A scripture project with an EXPLICIT false shows the switch OFF — the
//      trust invariant: derive-on-read must never override an explicit OFF.
//   3. A non-scripture project with the setting UNSET shows the switch OFF.
//   4. Toggling the switch marks the form dirty (about to persist an
//      explicit value), proving persistence only happens on user action.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { ProjectSettings } from "./ProjectSettings"
import type { ProjectRecord } from "@/lib/parsers/types"

const PROJECT_ID = "proj-bible-resources"

function makeProject(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: PROJECT_ID,
    name: "Bible Resources Test Project",
    files: [],
    sourceLanguage: "English",
    targetLanguage: "French",
    syncRole: { level: 700, source: "creator" },
    ...overrides,
  } as unknown as ProjectRecord
}

let currentProject: ProjectRecord = makeProject()

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
  useFrontierSession: () => ({ session: { jwt: "tok", username: "tester" }, loading: false }),
}))

vi.mock("@/hooks/useCompletionSettings", () => ({
  buildCompletionSettings: vi.fn((existing: unknown, updates: unknown) => ({ ...Object(existing), ...Object(updates) })),
  DEFAULT_SYSTEM_PROMPT: "Translate accurately.",
}))

vi.mock("@/lib/completion/completion-service", () => ({
  fetchModels: vi.fn().mockResolvedValue([]),
  resolveProvider: vi.fn(() => "frontier"),
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
})

describe("ProjectSettings — Bible resources (FRO-460 derive-on-read)", () => {
  it("scripture project, setting UNSET -> switch shows ON (derived default), not dirty", () => {
    currentProject = makeProject({
      files: [{ id: "f1", name: "GEN.usfm", type: "usfm", createdAt: "", cellCount: 1 }],
      bibleResourcesEnabled: undefined,
    })
    renderSettings()
    const toggle = screen.getByRole("switch", { name: /enable bible resources/i })
    expect(toggle).toHaveAttribute("aria-checked", "true")
    // Nothing was toggled by the user — the page must not report unsaved changes
    // just from rendering the derived state.
    expect(screen.queryByRole("button", { name: /save changes/i })).toBeNull()
  })

  it("scripture project, EXPLICIT false -> switch shows OFF (trust invariant respected)", () => {
    currentProject = makeProject({
      files: [{ id: "f1", name: "GEN.usfm", type: "usfm", createdAt: "", cellCount: 1 }],
      bibleResourcesEnabled: false,
    })
    renderSettings()
    const toggle = screen.getByRole("switch", { name: /enable bible resources/i })
    expect(toggle).toHaveAttribute("aria-checked", "false")
  })

  it("non-scripture project, setting UNSET -> switch shows OFF", () => {
    currentProject = makeProject({
      files: [{ id: "f1", name: "notes.docx", type: "docx", createdAt: "", cellCount: 1 }],
      bibleResourcesEnabled: undefined,
    })
    renderSettings()
    const toggle = screen.getByRole("switch", { name: /enable bible resources/i })
    expect(toggle).toHaveAttribute("aria-checked", "false")
  })

  it("toggling the switch marks the form dirty (persists only on explicit user action)", () => {
    currentProject = makeProject({
      files: [{ id: "f1", name: "GEN.usfm", type: "usfm", createdAt: "", cellCount: 1 }],
      bibleResourcesEnabled: undefined,
    })
    renderSettings()
    const toggle = screen.getByRole("switch", { name: /enable bible resources/i })
    fireEvent.click(toggle)
    expect(screen.getByRole("button", { name: /save changes/i })).toBeTruthy()
  })
})

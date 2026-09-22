// AQU-1115 — Project Settings → General must show the project's SAVED source
// and target languages in the editable Source/Target Language fields.
//
// Why these tests exist: this page passes `includeSettings: false` to
// `useProject` (it owns the editable settings hook itself), so the `project`
// record it receives is `minimalProjectRecord`, which hardcodes
// `sourceLanguage: ""` / `targetLanguage: ""`. The languages live only in the
// shared project-settings blob. The baseline seed runs on the first non-null
// `project`, so it captured those empty strings and the two fields rendered
// blank forever — while the Languages card directly below (which reads the
// blob directly) showed the correct language. These tests pin the corrected
// behavior:
//   1. Languages already in the blob when the page mounts -> fields populated.
//   2. Languages arriving in the LATER hydration phase (the real two-phase
//      load) -> fields settle to the real values, and that settling is not a
//      user edit (no "Save changes" button appears).
//   3. A genuinely empty language stays empty — no invented default.
//   4. A free-text label outside the language catalog shows verbatim.
//   5. Hydration must never stomp a language the user has already typed.

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
const targetField = () => screen.getByLabelText(/target language/i) as HTMLInputElement

beforeEach(() => {
  vi.clearAllMocks()
  currentProject = makeProject()
  currentSettings = {}
  currentHasFetched = true
})

describe("ProjectSettings — saved languages reach the General fields (AQU-1115)", () => {
  it("shows the project's saved source and target languages on first render", () => {
    currentSettings = { sourceLanguage: "English", targetLanguage: "French" }
    renderSettings()
    expect(sourceField().value).toBe("English")
    expect(targetField().value).toBe("French")
    // Hydrating the true values is not a user edit.
    expect(screen.queryByRole("button", { name: /save changes/i })).toBeNull()
  })

  it("settles to the real languages when they arrive in the LATER hydration phase", () => {
    // Phase 1: the project record has resolved, but this page's settings GET
    // hasn't landed yet, so the blob carries no languages. `minimalProjectRecord`
    // means `project` has none either — the fields can only be blank here.
    currentSettings = {}
    currentHasFetched = false
    const { rerender } = renderSettings()
    expect(sourceField().value).toBe("")
    expect(targetField().value).toBe("")

    // Phase 2: the settings GET resolves with the project's real languages.
    currentSettings = { sourceLanguage: "English", targetLanguage: "French" }
    currentHasFetched = true
    rerender(tree())

    expect(sourceField().value).toBe("English")
    expect(targetField().value).toBe("French")
    // Settling to the server value must not make the form look dirty, or an
    // unrelated save would be offered as a language change.
    expect(screen.queryByRole("button", { name: /save changes/i })).toBeNull()
  })

  it("leaves a genuinely empty language empty — no invented default", () => {
    currentSettings = { sourceLanguage: "English" }
    renderSettings()
    expect(sourceField().value).toBe("English")
    expect(targetField().value).toBe("")
  })

  it("shows a free-text language outside the catalog verbatim", () => {
    currentSettings = { sourceLanguage: "Grade 7 English", targetLanguage: "Kâ-nêhiyawêt" }
    renderSettings()
    expect(sourceField().value).toBe("Grade 7 English")
    expect(targetField().value).toBe("Kâ-nêhiyawêt")
  })

  it("never stomps a language the user typed before hydration landed", () => {
    currentSettings = {}
    currentHasFetched = false
    const { rerender } = renderSettings()

    fireEvent.change(sourceField(), { target: { value: "Koine Greek" } })
    expect(sourceField().value).toBe("Koine Greek")

    // The late settings GET carries a different source language. The user's
    // in-progress edit wins; the untouched target field still hydrates.
    currentSettings = { sourceLanguage: "English", targetLanguage: "French" }
    currentHasFetched = true
    rerender(tree())

    expect(sourceField().value).toBe("Koine Greek")
    expect(targetField().value).toBe("French")
  })
})

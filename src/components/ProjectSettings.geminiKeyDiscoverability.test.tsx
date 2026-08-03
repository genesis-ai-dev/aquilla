// AQU-522 — Gemini API-key entry must be discoverable, not buried.
//
// Why this test exists: the Gemini/TTS API key lives in the "Voice" section
// near the bottom of Project Settings. Reaching it meant opening settings and
// scrolling past every AI/LLM control to find it — "it's not very obvious"
// (2026-07-09 UW demo). The fix makes the settings search deep-linkable via a
// `?q=` param, and the "open audio setup" affordances now navigate to
// `…/settings?q=gemini`, which filters the page down to the Voice card so the
// key entry is visible immediately with nothing to hunt for or scroll past.
//
// Regression guard: a `?q=gemini` deep link must render the Gemini API key
// field directly (no pane click-through), and must NOT simultaneously render an
// unrelated control from another section (proving it filtered rather than
// dumping the user at the top of a long page again).

import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { ProjectSettings } from "./ProjectSettings"


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

import type { ProjectRecord } from "@/lib/parsers/types"

const PROJECT_ID = "proj-gemini-discoverability"

function makeProject(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: PROJECT_ID,
    name: "Gemini Discoverability Test Project",
    files: [{ id: "f1", name: "GEN.usfm", type: "usfm", createdAt: "", cellCount: 1 }],
    sourceLanguage: "English",
    targetLanguage: "French",
    syncRole: { level: 700, source: "creator" },
    ...overrides,
  } as unknown as ProjectRecord
}

vi.mock("@/hooks/useProject", () => ({
  useProject: () => ({ project: makeProject(), loading: false, refresh: vi.fn() }),
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

vi.mock("@/hooks/useOrg", () => ({ useOrg: () => ({ org: null }) }))

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "tok", username: "tester" }, loading: false }),
}))

vi.mock("@/hooks/useCompletionSettings", () => ({
  buildCompletionSettings: vi.fn((existing: unknown, updates: unknown) => ({ ...Object(existing), ...Object(updates) })),
  DEFAULT_SYSTEM_PROMPT: "Translate accurately.",
}))

vi.mock("@/lib/completion/completion-service", async (importOriginal) => {
  // Partial mock: ProjectSettings and other modules in its render tree read
  // real constants from this module at module-eval time (FRONTIER_CHAT_URL via
  // lib/ab/feedback.ts, DEFAULT_COMPLETION_MAX_TOKENS for initial state) —
  // keep every real export and stub only the network-touching functions.
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
  usePostEditMetrics: () => ({ metrics: null, isLoading: false, isError: false, revalidate: vi.fn() }),
}))

function renderAt(path: string) {
  return render(
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
})

describe("ProjectSettings — Gemini key discoverability (AQU-522)", () => {
  it("a `?q=gemini` deep link surfaces the Gemini API key field directly", () => {
    renderAt(`/project/${PROJECT_ID}/settings?q=gemini`)

    // The buried key entry is visible immediately — no pane click-through.
    expect(screen.getByText(/gemini api key/i)).toBeTruthy()
    // Search results are grouped under the main section header.
    expect(screen.getByText("AI & completion")).toBeTruthy()
  })

  it("the deep link filters to the Voice card — no unrelated section is shown", () => {
    renderAt(`/project/${PROJECT_ID}/settings?q=gemini`)

    // A control from a different section (General → Project Name) must NOT be in
    // the document: proving the user landed on the key, not the top of the page.
    expect(screen.queryByLabelText(/project name/i)).toBeNull()
    // And General's group header must not appear either (no matches in that group).
    expect(screen.queryByText("General")).toBeNull()
  })

  it("seeds the search box so the active filter is visible and clearable", () => {
    renderAt(`/project/${PROJECT_ID}/settings?q=gemini`)

    const search = screen.getByLabelText(/search settings/i) as HTMLInputElement
    expect(search.value).toBe("gemini")
  })

  it("no `?q=` param preserves the default index (no regression)", () => {
    renderAt(`/project/${PROJECT_ID}/settings`)

    // Default landing still shows the grouped index, not a pre-filtered pane.
    expect(screen.getByText("AI & completion")).toBeTruthy()
    const search = screen.getByLabelText(/search settings/i) as HTMLInputElement
    expect(search.value).toBe("")
  })
})

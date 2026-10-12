// AQU-1672 — the translation brief must have a direct entry in Project Settings.
//
// Why this test exists: the brief gates Autopilot starts (AQU-827) but had no
// row of its own anywhere in settings. The only path a partner user found
// (Samuel, 2026-10-04) was Project settings → AI & completion → Living Memory →
// *click the breadcrumb* → the Living Memory index → Brief. The fix gives the
// brief its own `section-brief` NavRow in the AI & completion pane, carrying
// its derived status as the row hint, and searchable by the word "brief".
//
// Regression guard: the AI & completion pane must link straight to
// `/project/:id/memory/brief`, a `?q=brief` search must surface that same link
// (the Living Memory cross-link next to it is hidden while searching, which is
// what made a search for "brief" come back empty), and the row must report the
// brief's real status rather than a fixed string.

import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { ProjectSettings } from "./ProjectSettings"


vi.mock("@/components/org/OrgSidebar", () => ({
  OrgSidebar: () => <div data-testid="org-sidebar">sidebar</div>,
}))
vi.mock("@/components/org/OrgBreadcrumb", () => ({
  OrgBreadcrumb: ({ section, trail }: { section?: string; trail?: { label: string }[] }) => (
    <div data-testid="org-breadcrumb">
      {section}
      {(trail ?? []).map((t) => ` › ${t.label}`).join("")}
    </div>
  ),
}))

import type { ProjectRecord } from "@/lib/parsers/types"

const PROJECT_ID = "proj-brief-discoverability"

function makeProject(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: PROJECT_ID,
    name: "Brief Discoverability Test Project",
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

// Mutable so a single test can swap in a project that already has a brief.
const settingsBlob: { current: Record<string, unknown> } = { current: {} }

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
    settings: settingsBlob.current,
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
  settingsBlob.current = {}
})

describe("ProjectSettings — translation-brief discoverability (AQU-1672)", () => {
  function briefRow() {
    return screen.getByRole("link", { name: /translation brief/i })
  }

  it("links the AI & completion pane straight to the brief", () => {
    renderAt(`/project/${PROJECT_ID}/settings/ai`)

    expect(briefRow()).toHaveAttribute("href", `/project/${PROJECT_ID}/memory/brief`)
  })

  it("a `?q=brief` search surfaces the brief link", () => {
    renderAt(`/project/${PROJECT_ID}/settings?q=brief`)

    expect(briefRow()).toHaveAttribute("href", `/project/${PROJECT_ID}/memory/brief`)
  })

  it("reports 'Not started' when the project has no brief", () => {
    renderAt(`/project/${PROJECT_ID}/settings/ai`)

    expect(briefRow().textContent).toMatch(/not started/i)
  })

  it("reports the brief's derived status — a partially answered brief reads Draft", () => {
    settingsBlob.current = {
      translationBrief: {
        version: 1,
        updatedAt: "2026-10-05T10:00:00.000Z",
        updatedBy: "tester",
        parameters: { purpose: "Evangelistic" },
        freeformNotes: "",
        l2Markdown: "",
        l1Summary: null,
        l1GeneratedAt: null,
        l1ModelId: null,
      },
    }
    renderAt(`/project/${PROJECT_ID}/settings/ai`)

    expect(briefRow().textContent).toMatch(/draft/i)
  })
})

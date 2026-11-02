// AQU-2342 — Project settings → AI has ONE entry to the project instructions.
//
// The instructions replaced the translation brief, the system prompt and
// Living Memory's instruction entries. The AI pane links straight to
// `/project/:id/memory/instructions` with a one-line preview of the resolved
// text, and a search for any of the old names still lands on that link
// (AQU-1672: a search for "brief" once came back empty).

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

const PROJECT_ID = "proj-instructions-discoverability"

function makeProject(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: PROJECT_ID,
    name: "Instructions Discoverability Test Project",
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

describe("ProjectSettings — the Instructions entry (AQU-2342)", () => {
  const instructionsHref = `/project/${PROJECT_ID}/memory/instructions`
  function instructionsRow() {
    return screen.getByRole("link", { name: /^instructions/i })
  }

  it("links the AI pane straight to the instructions, as its only Living Memory link", () => {
    renderAt(`/project/${PROJECT_ID}/settings/ai`)

    expect(instructionsRow()).toHaveAttribute("href", instructionsHref)
    expect(screen.queryByRole("link", { name: /translation brief/i })).toBeNull()
    expect(screen.queryByRole("link", { name: /living memory/i })).toBeNull()
  })

  it.each(["brief", "system prompt", "instructions"])("a `?q=%s` search surfaces the instructions link", (q) => {
    renderAt(`/project/${PROJECT_ID}/settings?q=${encodeURIComponent(q)}`)

    expect(instructionsRow()).toHaveAttribute("href", instructionsHref)
  })

  it("says 'Not written yet' when the project has no instructions", () => {
    renderAt(`/project/${PROJECT_ID}/settings/ai`)

    expect(instructionsRow().textContent).toMatch(/not written yet/i)
  })

  it("previews the stored instructions on one line", () => {
    settingsBlob.current = { translationInstructions: "Plain register\nfor rural youth." }
    renderAt(`/project/${PROJECT_ID}/settings/ai`)

    expect(instructionsRow().textContent).toContain("Plain register for rural youth.")
  })

  it("previews the migrated text when only an old brief exists", () => {
    settingsBlob.current = {
      translationBrief: {
        version: 1,
        updatedAt: "2026-10-05T10:00:00.000Z",
        updatedBy: "tester",
        parameters: { purpose: "Evangelistic" },
        freeformNotes: "",
        l2Markdown: "",
        l1Summary: "Draft for new readers.",
        l1GeneratedAt: null,
        l1ModelId: null,
      },
    }
    renderAt(`/project/${PROJECT_ID}/settings/ai`)

    expect(instructionsRow().textContent).toContain("Draft for new readers.")
  })
})

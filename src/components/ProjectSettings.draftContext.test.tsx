// D10 — draftContext settings UI tests (swarm/p1-settings-ui).
//
// Why these tests exist:
//   1. The "Preceding committed-target cells" input renders when the section is
//      visible — confirms the field is wired up in the DOM.
//   2. Changing the value from 3 → 0 marks the form dirty.
//   3. The input clamps to [0, 10].
//
// ProjectSettings mounts a large tree (useProject, useProjectSettings, many
// hooks). We stub every hook to keep the test fast and focused on D10 only.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { ProjectSettings } from "./ProjectSettings"
import type { ProjectRecord } from "@/lib/parsers/types"

// ─── Shared project stub ─────────────────────────────────────────────────────

const PROJECT_ID = "proj-draft-ctx"

function makeProject(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: PROJECT_ID,
    name: "Draft Context Test Project",
    files: [],
    sourceLanguage: "English",
    targetLanguage: "French",
    syncRole: { level: 700, source: "creator" },
    draftContext: { precedingTargetCells: 3 },
    ...overrides,
  } as unknown as ProjectRecord
}

// ─── Hook mocks ──────────────────────────────────────────────────────────────

vi.mock("@/hooks/useProject", () => ({
  useProject: () => ({
    project: makeProject(),
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
    settings: { draftContext: { precedingTargetCells: 3 } },
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
  // AQU-478: ProjectSettings now transitively imports events-emit.ts (via
  // UpstreamChangesPanel) → src/lib/ab/feedback.ts, which reads this export
  // at module-eval time.
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

// ─── Render helper ───────────────────────────────────────────────────────────

// AQU-501: Draft Context lives in the "AI & completion" sub-menu pane —
// deep-link straight there via `?section=`.
function renderSettings() {
  return render(
    <MemoryRouter initialEntries={[`/project/${PROJECT_ID}/settings?section=ai`]}>
      <Routes>
        <Route path="/project/:id/settings" element={<ProjectSettings />} />
      </Routes>
    </MemoryRouter>,
  )
}

// ─── Tests ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
})

describe("ProjectSettings — Draft Context section (D10)", () => {
  it("renders the 'Preceding committed-target cells' input", () => {
    renderSettings()
    const input = screen.getByLabelText(/preceding committed-target cells/i) as HTMLInputElement
    expect(input).toBeTruthy()
    expect(input.type).toBe("number")
    expect(Number(input.value)).toBe(3)
  })

  it("reflects the draftContext value from the project record", () => {
    renderSettings()
    const input = screen.getByLabelText(/preceding committed-target cells/i) as HTMLInputElement
    expect(Number(input.value)).toBe(3)
  })

  it("changing the value marks the form dirty (Save button appears)", () => {
    renderSettings()
    const input = screen.getByLabelText(/preceding committed-target cells/i)
    fireEvent.change(input, { target: { value: "0" } })
    // When dirty, the header shows "Save changes" button.
    expect(screen.getByRole("button", { name: /save changes/i })).toBeTruthy()
  })

  it("clamps input to minimum 0", () => {
    renderSettings()
    const input = screen.getByLabelText(/preceding committed-target cells/i) as HTMLInputElement
    fireEvent.change(input, { target: { value: "-5" } })
    expect(Number(input.value)).toBe(0)
  })

  it("clamps input to maximum 10", () => {
    renderSettings()
    const input = screen.getByLabelText(/preceding committed-target cells/i) as HTMLInputElement
    fireEvent.change(input, { target: { value: "99" } })
    expect(Number(input.value)).toBe(10)
  })
})

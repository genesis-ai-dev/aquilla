// AQU-408 — AI Settings panel: every field must actually persist, not just
// "AI instructions". Prior bug: `buildCompletionSettings` (the merge function
// the Save Changes handler funnels every completion-settings edit through)
// omitted top_k / contextSize / useOnlyValidatedExamples / main_chat_language /
// fewShotExampleFormat entirely, so those 5 fields silently reset to their
// factory defaults on every save no matter what the user set them to.
//
// These tests use the REAL `buildCompletionSettings` (not a naive-spread
// mock, unlike the sibling ProjectSettings test files) so a regression in the
// merge function itself is caught here, not just in useCompletionSettings.test.ts.
//
// Also covers the issue's other acceptance criteria:
//   - success message reflects the actual delta saved (not a generic "Saved")
//   - after a successful save the page/modal stays open with the new values
//     as current state — the primary "Save changes" button no longer
//     navigates away; only the explicit "Save and close" menu item does.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { ProjectSettings } from "./ProjectSettings"
import type { ProjectRecord, CompletionSettings } from "@/lib/parsers/types"

const PROJECT_ID = "proj-ai-settings"

function makeProject(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: PROJECT_ID,
    name: "AI Settings Test Project",
    files: [],
    sourceLanguage: "English",
    targetLanguage: "French",
    syncRole: { level: 700, source: "creator" },
    completionSettings: {
      provider: "frontier",
      endpoint: "",
      model: "",
      maxTokens: 512,
      temperature: 0.3,
      systemPrompt: "Existing instructions",
      top_k: 15,
      contextSize: "medium",
      useOnlyValidatedExamples: false,
      main_chat_language: "",
      fewShotExampleFormat: "source-and-target",
    } satisfies CompletionSettings,
    ...overrides,
  } as unknown as ProjectRecord
}

vi.mock("@/hooks/useProject", () => ({
  useProject: () => ({
    project: makeProject(),
    loading: false,
    refresh: vi.fn(),
  }),
}))

const patchSharedMock = vi.fn().mockResolvedValue({ kind: "ok" })
vi.mock("@/hooks/useProjectSettings", () => ({
  useProjectSettings: () => ({
    canEdit: true,
    reasonCannotEdit: null,
    patch: patchSharedMock,
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

// Intentionally NOT mocked: we want the real buildCompletionSettings so a
// regression in the merge logic itself fails this test.

vi.mock("@/lib/completion/completion-service", async (importOriginal) => {
  // Partial mock: other modules in the render tree (e.g. lib/ab/feedback.ts)
  // import constants like FRONTIER_CHAT_URL from this module — keep the real
  // exports and stub only the network-touching functions.
  const actual = await importOriginal<typeof import("@/lib/completion/completion-service")>()
  return {
    ...actual,
    fetchModels: vi.fn().mockResolvedValue([]),
    resolveProvider: vi.fn(() => "frontier"),
  }
})

let lastUpdateProjectArg: ProjectRecord | null = null
vi.mock("@/lib/store/project-index", () => ({
  getProject: vi.fn(async () => makeProject()),
  updateProject: vi.fn(async (p: ProjectRecord) => {
    lastUpdateProjectArg = p
  }),
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

// Base UI Select renders a combobox trigger; options live in a portaled
// popup. Under happy-dom, hover-highlighting the option and pressing Enter
// commits the selection (see AssignModal.test.tsx for the same pattern).
async function pickSelectOption(triggerName: RegExp, optionName: RegExp) {
  const trigger = screen.getByRole("combobox", { name: triggerName })
  fireEvent.click(trigger)
  const option = await screen.findByRole("option", { name: optionName })
  fireEvent.pointerMove(option)
  fireEvent.mouseMove(option)
  fireEvent.keyDown(document.activeElement ?? option, { key: "Enter" })
  await waitFor(() => {
    expect(trigger.textContent).toMatch(optionName)
  })
}

// AQU-501: AI Instructions / Advanced LLM fields live in the "AI & completion"
// sub-menu pane — deep-link straight there via `?section=`.
function renderSettings() {
  return render(
    <MemoryRouter initialEntries={[`/project/${PROJECT_ID}/settings?section=ai`]}>
      <Routes>
        <Route path="/project/:id/settings" element={<ProjectSettings />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  patchSharedMock.mockResolvedValue({ kind: "ok" })
  lastUpdateProjectArg = null
})

describe("ProjectSettings — AI Settings persistence (AQU-408)", () => {
  it("persists Top K, context window, validated-only, and example format on Save", async () => {
    renderSettings()

    fireEvent.change(screen.getByLabelText(/examples retrieved/i), { target: { value: "17" } })
    await pickSelectOption(/context window/i, /large — chapter/i)
    fireEvent.click(screen.getByRole("checkbox", { name: /validated/i }))

    const saveBtn = screen.getByRole("button", { name: /save changes/i })
    fireEvent.click(saveBtn)

    await waitFor(() => expect(lastUpdateProjectArg).not.toBeNull())
    const saved = lastUpdateProjectArg!.completionSettings as CompletionSettings
    expect(saved.top_k).toBe(17)
    expect(saved.contextSize).toBe("large")
    expect(saved.useOnlyValidatedExamples).toBe(true)
    // Fields the user did NOT touch must survive the merge, not reset.
    expect(saved.fewShotExampleFormat).toBe("source-and-target")
    expect(saved.systemPrompt).toBe("Existing instructions")
  })

  it("shows a success message reflecting the actual fields saved, and the page stays open", async () => {
    renderSettings()

    fireEvent.change(screen.getByLabelText(/examples retrieved/i), { target: { value: "17" } })
    const saveBtn = screen.getByRole("button", { name: /save changes/i })
    fireEvent.click(saveBtn)

    // The page must still be showing the settings form (no navigation away) —
    // the same route continues to render its heading.
    await waitFor(() => expect(screen.getByText(/project settings/i)).toBeTruthy())

    const status = await screen.findByRole("status")
    expect(status.textContent?.toLowerCase()).toContain("examples retrieved")

    // "Save changes" button hides once the diff against baseline is empty
    // again (existing good behavior, preserved).
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /save changes/i })).toBeNull(),
    )
  })

  it("Save Changes button hides once the form is clean (no regression to existing diff behavior)", () => {
    renderSettings()
    expect(screen.queryByRole("button", { name: /save changes/i })).toBeNull()
    const input = screen.getByLabelText(/examples retrieved/i)
    fireEvent.change(input, { target: { value: "17" } })
    expect(screen.getByRole("button", { name: /save changes/i })).toBeTruthy()
    fireEvent.change(input, { target: { value: "15" } })
    expect(screen.queryByRole("button", { name: /save changes/i })).toBeNull()
  })
})

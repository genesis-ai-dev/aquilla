// AQU-408 — AI Settings panel: every field must actually persist, not just
// "AI instructions". Prior bug: `buildCompletionSettings` (the merge function
// the Save Changes handler funnels every completion-settings edit through)
// omitted top_k / contextSize / useOnlyValidatedExamples / main_chat_language /
// fewShotExampleFormat entirely, so those 5 fields silently reset to their
// factory defaults on every save no matter what the user set them to.
//
// AQU-2262: settings save as you change them, so each field now goes to the
// team's drafting settings on its own, MERGED into the stored ones: a field the
// person did not touch is never sent, so it cannot be reset. These tests hold
// that each field is written by itself, with the merge asked for, and that the
// page stays open and says "Saved" beside the field.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { pickSelectOption as selectOption } from "@/test-utils/select"
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
// A write shows on the page, as the real hook's overlay does.
vi.mock("@/hooks/useProjectSettings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/useProjectSettings")>()
  const { useLiveProjectSettings } = await import("@/test-utils/live-project-settings")
  return { ...actual, useProjectSettings: () => useLiveProjectSettings(() => ({ settings: {}, patch: patchSharedMock })) }
})

vi.mock("@/hooks/useOrg", () => ({
  useOrg: () => ({ org: null }),
}))

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "tok", username: "tester" }, loading: false }),
}))

vi.mock("@/hooks/useAccounts", () => ({
  useAccounts: () => ({ active: null, sessions: [], loading: false, add: vi.fn(), activate: vi.fn(), remove: vi.fn() }),
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

vi.mock("@/lib/store/project-index", () => ({
  getProject: vi.fn(async () => makeProject()),
  updateProject: vi.fn(async (_p: ProjectRecord) => {}),
  patchProject: vi.fn(async (_id: string, fn: (p: ProjectRecord) => ProjectRecord) => fn(makeProject())),
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

// The shared helper drives the pointer sequence Base UI requires to commit a
// choice (see src/test-utils/select.tsx); here we additionally hold it to
// rendering the chosen label on the trigger.
async function pickSelectOption(triggerName: RegExp, optionName: RegExp) {
  const trigger = await selectOption(triggerName, optionName)
  await waitFor(() => {
    expect(trigger.textContent).toMatch(optionName)
  })
}

// AQU-501: AI drafting / AI model (advanced) fields live in the "AI"
// sub-menu pane — deep-link straight there via `?section=`.
function renderSettings() {
  return render(
    <MemoryRouter initialEntries={[`/project/${PROJECT_ID}/settings/ai`]}>
      <Routes>
        <Route path="/project/:id/settings" element={<ProjectSettings />} />
        <Route path="/project/:id/settings/:section" element={<ProjectSettings />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  patchSharedMock.mockResolvedValue({ kind: "ok" })
})

describe("ProjectSettings — AI Settings persistence (AQU-408)", () => {
  /** What each write sent to the team's drafting settings, in order. */
  const draftingWrites = () =>
    patchSharedMock.mock.calls.map((c) => (c[0] as { draftingSettings?: Partial<CompletionSettings> }).draftingSettings)

  it("persists Top K and context, each by itself, while retrieval stays on approved examples", async () => {
    renderSettings()

    const topK = screen.getByLabelText(/examples retrieved/i)
    fireEvent.change(topK, { target: { value: "17" } })
    fireEvent.blur(topK)
    await waitFor(() => expect(draftingWrites()).toEqual([{ top_k: 17 }]))
    await pickSelectOption(/context window/i, /large — chapter/i)
    await waitFor(() => expect(draftingWrites()).toEqual([{ top_k: 17 }, { contextSize: "large" }]))

    const approvedOnly = screen.getByRole("switch", { name: /approved examples only/i })
    // Base UI Switch: checked + locked via data-* (not the native disabled prop).
    expect(approvedOnly).toHaveAttribute("aria-checked", "true")
    expect(approvedOnly).toHaveAttribute("data-disabled")
    expect(approvedOnly).toHaveAttribute("data-checked")

    // AQU-2259: these are the team's settings, saved to the shared settings,
    // each merged into what is stored, so a field not touched is never reset.
    for (const call of patchSharedMock.mock.calls) {
      expect(call[1]).toMatchObject({ mergeKeys: ["draftingSettings"] })
      // The instructions are a separate shared setting, never part of this one.
      expect(JSON.stringify(call[0])).not.toContain("systemPrompt")
    }
  })

  it("says Saved beside the field, and the page stays open", async () => {
    renderSettings()

    const topK = screen.getByLabelText(/examples retrieved/i)
    fireEvent.change(topK, { target: { value: "17" } })
    fireEvent.blur(topK)

    expect(await screen.findByTestId("save-status-draftingSettings.top_k")).toHaveTextContent("Saved")
    // The page must still be showing the settings form (no navigation away).
    expect(screen.getByRole("heading", { name: /^ai$/i })).toBeTruthy()
    expect(topK).toHaveValue(17)
  })

  it("has no Save bar, and typing back to the stored value saves nothing", () => {
    renderSettings()
    expect(screen.queryByRole("button", { name: /save changes/i })).toBeNull()
    const input = screen.getByLabelText(/examples retrieved/i)
    fireEvent.change(input, { target: { value: "17" } })
    fireEvent.change(input, { target: { value: "15" } })
    fireEvent.blur(input)
    expect(patchSharedMock).not.toHaveBeenCalled()
  })
})

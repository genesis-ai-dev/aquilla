// Decision 2026-08-05: the timing-mode control lives in Project Settings
// (audio-media group), behind the shared-settings maintainer floor, saved
// through the page's deferred-save diff — with the Flow-A warning when a
// video-bearing project switches TO Free timing.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { ProjectSettings } from "./ProjectSettings"

vi.mock("@/components/org/OrgSidebar", () => ({
  OrgSidebar: () => <div data-testid="org-sidebar">sidebar</div>,
}))
vi.mock("@/components/org/OrgBreadcrumb", () => ({
  OrgBreadcrumb: () => <div data-testid="org-breadcrumb" />,
}))

import type { ProjectRecord } from "@/lib/parsers/types"

const PROJECT_ID = "proj-timing-mode"

const state = vi.hoisted(() => ({
  project: null as unknown as Record<string, unknown>,
  canEdit: true,
  patch: vi.fn(async (_updates: unknown) => ({ kind: "ok" as const })),
}))

function makeProject(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: PROJECT_ID,
    name: "Timing Mode Test Project",
    files: [{ id: "f1", name: "chapter.mp3", type: "usfm", createdAt: "", cellCount: 1 }],
    sourceLanguage: "English",
    targetLanguage: "French",
    syncRole: { level: 700, source: "creator" },
    ...overrides,
  } as unknown as ProjectRecord
}

vi.mock("@/hooks/useProject", () => ({
  useProject: () => ({ project: state.project, loading: false, refresh: vi.fn() }),
}))
vi.mock("@/hooks/useProjectSettings", () => ({
  useProjectSettings: () => ({
    canEdit: state.canEdit,
    reasonCannotEdit: state.canEdit ? null : "role",
    patch: state.patch,
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
vi.mock("@/hooks/useAccounts", () => ({
  useAccounts: () => ({ active: null, sessions: [], loading: false, add: vi.fn(), activate: vi.fn(), remove: vi.fn() }),
}))
vi.mock("@/hooks/useCompletionSettings", () => ({
  buildCompletionSettings: vi.fn((existing: unknown, updates: unknown) => ({ ...Object(existing), ...Object(updates) })),
  DEFAULT_SYSTEM_PROMPT: "Translate accurately.",
}))
vi.mock("@/lib/completion/completion-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/completion/completion-service")>()
  return { ...actual, fetchModels: vi.fn().mockResolvedValue([]), resolveProvider: vi.fn(() => "frontier") }
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

function paneUi(client: QueryClient) {
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/project/${PROJECT_ID}/settings/audio-media`]}>
        <Routes>
          <Route path="/project/:id/settings/:section" element={<ProjectSettings />} />
          {/* Where "Save and close" lands — observable proof of navigation. */}
          <Route path="/project/:id/editor" element={<div data-testid="editor-route" />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

function renderPane() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(paneUi(client))
  return { ...view, rerenderPane: () => view.rerender(paneUi(client)) }
}

const saveButton = () => screen.getByRole("button", { name: /^Save changes$/ })

describe("ProjectSettings — timing mode (2026-08-05)", () => {
  beforeEach(() => {
    state.project = makeProject() as unknown as Record<string, unknown>
    state.canEdit = true
    state.patch.mockClear()
    state.patch.mockResolvedValue({ kind: "ok" as const })
  })

  it("renders in the audio-media pane, defaulting to Original's timing (absent = dubbing)", () => {
    renderPane()
    expect(screen.getByTestId("settings-timing-mode")).toHaveAttribute("data-mode", "dubbing")
    expect(screen.getByTestId("settings-timing-mode-dubbing")).toHaveAttribute("aria-pressed", "true")
  })

  it("a Free-timing project shows Free timing selected", () => {
    state.project = makeProject({ audioTimingMode: "audioFirst" }) as unknown as Record<string, unknown>
    renderPane()
    expect(screen.getByTestId("settings-timing-mode")).toHaveAttribute("data-mode", "audioFirst")
  })

  it("below the maintainer floor the buttons are disabled", () => {
    state.canEdit = false
    renderPane()
    expect(screen.getByTestId("settings-timing-mode-dubbing")).toBeDisabled()
    expect(screen.getByTestId("settings-timing-mode-audioFirst")).toBeDisabled()
  })

  it("no video: switching to Free timing saves straight through, no dialog", async () => {
    renderPane()
    fireEvent.click(screen.getByTestId("settings-timing-mode-audioFirst"))
    fireEvent.click(saveButton())
    await waitFor(() => expect(state.patch).toHaveBeenCalled())
    expect(state.patch).toHaveBeenCalledWith(expect.objectContaining({ audioTimingMode: "audioFirst" }))
    expect(screen.queryByTestId("timing-video-warning")).toBeNull()
  })

  it("with a linked video: switching to Free timing warns first; Confirm saves, Cancel keeps the draft", async () => {
    state.project = makeProject({
      files: [{ id: "f1", name: "ep.vtt", type: "usfm", createdAt: "", cellCount: 1, coreMediaUrl: "http://v.test/ep.mp4" }],
    } as Partial<ProjectRecord>) as unknown as Record<string, unknown>
    renderPane()
    fireEvent.click(screen.getByTestId("settings-timing-mode-audioFirst"))
    fireEvent.click(saveButton())
    // The dialog intercepts — nothing saved yet.
    await screen.findByTestId("timing-video-warning")
    expect(state.patch).not.toHaveBeenCalled()

    // Cancel: draft intact (still dirty — the Save button is still offered).
    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/ }))
    await waitFor(() => expect(screen.queryByTestId("timing-video-warning")).toBeNull())
    expect(state.patch).not.toHaveBeenCalled()

    // Save again → Confirm → the patch goes through.
    fireEvent.click(saveButton())
    await screen.findByTestId("timing-video-warning")
    fireEvent.click(screen.getByRole("button", { name: /^Switch to Free timing$/ }))
    await waitFor(() =>
      expect(state.patch).toHaveBeenCalledWith(expect.objectContaining({ audioTimingMode: "audioFirst" })),
    )
  })

  it("the overlay landing AFTER the page's own fetch still corrects the card (2026-08-06 latch race)", async () => {
    // Mount in the exact race order: this page's settings fetch has already
    // confirmed (hasFetched: true in the mock) while the PROJECT record does
    // not yet carry the audioTimingMode overlay (useProject's separate GET).
    const view = renderPane()
    expect(screen.getByTestId("settings-timing-mode")).toHaveAttribute("data-mode", "dubbing")
    // The overlay lands late with the real value — the card must follow.
    state.project = makeProject({ audioTimingMode: "audioFirst" }) as unknown as Record<string, unknown>
    view.rerenderPane()
    await waitFor(() =>
      expect(screen.getByTestId("settings-timing-mode")).toHaveAttribute("data-mode", "audioFirst"),
    )
  })

  it("Save-and-close intercepted by the video warning still CLOSES after Confirm (2026-08-06)", async () => {
    state.project = makeProject({
      files: [{ id: "f1", name: "ep.vtt", type: "usfm", createdAt: "", cellCount: 1, coreMediaUrl: "http://v.test/ep.mp4" }],
    } as Partial<ProjectRecord>) as unknown as Record<string, unknown>
    renderPane()
    fireEvent.click(screen.getByTestId("settings-timing-mode-audioFirst"))
    // Open the split-button menu and pick "Save and close".
    const trigger = screen.getByRole("button", { name: /more save options/i })
    fireEvent.pointerDown(trigger)
    fireEvent.click(trigger)
    fireEvent.click(await screen.findByText(/save and close/i))
    // The warning intercepts the save — Confirm must finish BOTH halves of
    // the gesture: the patch goes through AND the page closes to the editor.
    await screen.findByTestId("timing-video-warning")
    fireEvent.click(screen.getByRole("button", { name: /^Switch to Free timing$/ }))
    await waitFor(() =>
      expect(state.patch).toHaveBeenCalledWith(expect.objectContaining({ audioTimingMode: "audioFirst" })),
    )
    await screen.findByTestId("editor-route")
  })

  it("switching BACK to Original's timing never warns, video or not", async () => {
    state.project = makeProject({
      audioTimingMode: "audioFirst",
      files: [{ id: "f1", name: "ep.vtt", type: "usfm", createdAt: "", cellCount: 1, coreMediaUrl: "http://v.test/ep.mp4" }],
    } as Partial<ProjectRecord>) as unknown as Record<string, unknown>
    renderPane()
    fireEvent.click(screen.getByTestId("settings-timing-mode-dubbing"))
    fireEvent.click(saveButton())
    await waitFor(() => expect(state.patch).toHaveBeenCalled())
    expect(screen.queryByTestId("timing-video-warning")).toBeNull()
  })
})

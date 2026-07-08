// AQU-501 — Project settings sub-menu IA.
//
// Why these tests exist: Project Settings used to render every section on one
// long scrolling page with a scroll-spy TOC. That made a single setting hard
// to find and gave no sense of where you were. This converts it to the same
// index -> detail pane pattern org Settings uses (src/pages/Settings.tsx):
// picking a sub-section from a NavList shows only that pane, navigated via an
// internal `?section=` search param (no new route — App.tsx untouched).
//
// These tests encode the acceptance criteria directly:
//   1. Landing on /settings with no `section` param shows an index of labeled
//      sub-menus, not the full set of controls.
//   2. Picking a sub-menu link navigates to `?section=<id>` and renders ONLY
//      that group's controls — a setting from a different group must not be
//      in the document at the same time (the "no more one long scroll" bar).
//   3. A `?section=` deep link renders directly into that pane (so the pane is
//      link-able, not just reachable by clicking through).
//   4. No section was dropped: every previously-available control is still
//      reachable through some sub-menu (spot-checks one control per group).
//   5. The back link returns to the index.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { ProjectSettings } from "./ProjectSettings"
import type { ProjectRecord } from "@/lib/parsers/types"

const PROJECT_ID = "proj-submenu-ia"

function makeProject(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: PROJECT_ID,
    name: "Sub-menu IA Test Project",
    files: [{ id: "f1", name: "GEN.usfm", type: "usfm", createdAt: "", cellCount: 1 }],
    sourceLanguage: "English",
    targetLanguage: "French",
    syncRole: { level: 700, source: "creator" },
    // Give every group something to render: git-sync origin, no source link
    // (kept simple — source-link/upstream tested for visibility separately
    // isn't needed here since "General" and "AI" alone already prove the
    // per-pane isolation contract).
    origin: { kind: "git", cloneUrl: "https://example.test/repo.git", branch: "main" },
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
  // FRO-478: ProjectSettings transitively imports events-emit.ts (via
  // UpstreamChangesPanel) -> src/lib/ab/feedback.ts, which reads this export
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

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/project/:id/settings" element={<ProjectSettings />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("ProjectSettings — sub-menu IA (AQU-501)", () => {
  it("index (no ?section=) shows labeled sub-menus, not the full control set", () => {
    renderAt(`/project/${PROJECT_ID}/settings`)

    // The index is a NavList of groups...
    expect(screen.getByText("General")).toBeTruthy()
    expect(screen.getByText("AI & completion")).toBeTruthy()
    expect(screen.getByText("Validation & health")).toBeTruthy()

    // ...not the controls themselves. Project Name (General) and AI
    // Instructions (AI & completion) must NOT both be in the document at once
    // on the index — proving this isn't still one long scroll.
    expect(screen.queryByLabelText(/project name/i)).toBeNull()
    expect(screen.queryByLabelText(/username/i)).toBeNull()
  })

  it("picking a sub-menu renders only that group's controls", () => {
    renderAt(`/project/${PROJECT_ID}/settings`)

    fireEvent.click(screen.getByText("General"))

    // General's own controls are present...
    expect(screen.getByLabelText(/project name/i)).toBeTruthy()
    expect(screen.getByLabelText(/username/i)).toBeTruthy()

    // ...but a control that lives in a different group (AI & completion) is
    // NOT rendered at the same time. This is the core "no more one long
    // scroll" assertion — every field used to be simultaneously in the DOM.
    expect(screen.queryByLabelText(/examples retrieved/i)).toBeNull()
    expect(screen.queryByRole("switch", { name: /allow self-validation/i })).toBeNull()
  })

  it("a `?section=` deep link renders directly into that pane", () => {
    renderAt(`/project/${PROJECT_ID}/settings?section=ai`)

    expect(screen.getByLabelText(/examples retrieved/i)).toBeTruthy()
    expect(screen.queryByLabelText(/project name/i)).toBeNull()
  })

  it("the back link returns to the settings index", () => {
    renderAt(`/project/${PROJECT_ID}/settings?section=general`)
    expect(screen.getByLabelText(/project name/i)).toBeTruthy()

    fireEvent.click(screen.getByRole("link", { name: /settings/i }))

    expect(screen.getByText("AI & completion")).toBeTruthy()
    expect(screen.queryByLabelText(/project name/i)).toBeNull()
  })

  // No setting lost: every section that used to live on the single scroll is
  // still reachable through exactly one sub-menu pane.
  it("every settings group renders its expected controls (no section dropped)", () => {
    renderAt(`/project/${PROJECT_ID}/settings?section=general`)
    expect(screen.getByLabelText(/project name/i)).toBeTruthy()
    expect(screen.getByRole("switch", { name: /enable bible resources/i })).toBeTruthy()
    expect(screen.getByLabelText(/username/i)).toBeTruthy()

    renderAt(`/project/${PROJECT_ID}/settings?section=source-sync`)
    // This project has a git origin but no source link, so only Git Sync
    // renders in this pane — confirms the group still mounts correctly when
    // some of its member sections are conditionally hidden.
    expect(screen.getByText(/git sync/i)).toBeTruthy()

    renderAt(`/project/${PROJECT_ID}/settings?section=ai`)
    expect(screen.getByLabelText(/examples retrieved/i)).toBeTruthy()
    expect(screen.getByLabelText(/preceding committed-target cells/i)).toBeTruthy()
    expect(screen.getByText(/^voice$/i)).toBeTruthy()
    expect(screen.getByRole("button", { name: /open terminology library/i })).toBeTruthy()

    renderAt(`/project/${PROJECT_ID}/settings?section=validation`)
    expect(screen.getByLabelText(/required validators \(text\)/i)).toBeTruthy()
    expect(screen.getByText(/^harmonization$/i)).toBeTruthy()
    expect(screen.getByText(/staleness & health/i)).toBeTruthy()

    renderAt(`/project/${PROJECT_ID}/settings?section=audio-media`)
    expect(screen.getByText(/audio loading/i)).toBeTruthy()

    renderAt(`/project/${PROJECT_ID}/settings?section=metrics`)
    // PostEditMetricsSection renders its own heading regardless of loading state.
    expect(screen.getByText(/ai metrics|post-edit/i)).toBeTruthy()
  })

  // The hidden termbase-sharing section (SHOW_TERMBASE_SHARING_IN_SETTINGS
  // flag) must stay hidden the same way it was pre-AQU-501 — not surfaced as
  // its own sub-menu group or NavRow.
  it("termbase sharing stays hidden behind its feature flag", () => {
    renderAt(`/project/${PROJECT_ID}/settings`)
    expect(screen.queryByText(/term base sharing/i)).toBeNull()

    renderAt(`/project/${PROJECT_ID}/settings?section=ai`)
    expect(screen.queryByText(/term base sharing/i)).toBeNull()
  })
})

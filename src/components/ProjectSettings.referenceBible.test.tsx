// AQU-1573 — Reference Bible UI.
//
// The point of the setting is that it is INDEPENDENT of the Bible-resources
// switch it sits beside: the projects that need it (sermons, devotionals,
// curriculum, books) keep Aquifer lookup off. So the first test here is a
// non-scripture project with `bibleResourcesEnabled: false` — the exact state of
// the partner project in the ticket — and the control must still be there,
// offering every version in the registry.
//
// The scaffolding mirrors ProjectSettings.bibleResources.test.tsx: ProjectSettings
// reaches a lot of hooks, and this file stubs the same ones.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { ProjectSettings } from "./ProjectSettings"


vi.mock("@/components/org/OrgSidebar", () => ({
  OrgSidebar: () => <div data-testid="org-sidebar">sidebar</div>,
}))
vi.mock("@/components/org/OrgBreadcrumb", () => ({
  // This file asserts nothing about the breadcrumb, so the mock renders a
  // marker and takes no props — the sibling bibleResources suite needs the
  // section/trail passthrough, this one does not.
  OrgBreadcrumb: () => <div data-testid="org-breadcrumb">breadcrumb</div>,
}))

import {
  MAX_REFERENCE_BIBLE_VERSIONS,
  REFERENCE_BIBLE_VERSIONS,
} from "../../db/shared/reference-bibles"

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
// AQU-460 display-race: lets a test simulate the two-phase hydration where
// `project.bibleResourcesEnabled` is still `undefined` because the settings
// GET hasn't resolved yet. Defaults to true (hydrated) so the other tests in
// this file — which don't care about the race — keep their prior behavior.
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
    settings: {},
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
  usePostEditMetrics: () => ({
    metrics: null,
    isLoading: false,
    isError: false,
    revalidate: vi.fn(),
  }),
}))

// AQU-501: Bible resources lives in the "General" sub-menu pane — deep-link
// straight to it via the `?section=` search param so these tests don't have
// to click through the settings index first.
function renderSettings() {
  return render(
    <MemoryRouter initialEntries={[`/project/${PROJECT_ID}/settings/general`]}>
      <Routes>
        <Route path="/project/:id/settings" element={<ProjectSettings />} />
        <Route path="/project/:id/settings/:section" element={<ProjectSettings />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  currentHasFetched = true
})

describe("ProjectSettings — Reference Bible (AQU-1573)", () => {
  beforeEach(() => {
    currentProject = makeProject({
      files: [{ id: "f1", name: "session-01.docx", type: "docx", createdAt: "", cellCount: 1 }],
      // The partner project's real state: Aquifer lookup explicitly off.
      bibleResourcesEnabled: false,
    })
  })

  it("offers every registry version on a non-scripture project with Bible resources OFF", () => {
    renderSettings()
    expect(screen.getByRole("switch", { name: /enable bible resources/i })).toHaveAttribute(
      "aria-checked",
      "false",
    )
    for (const version of REFERENCE_BIBLE_VERSIONS) {
      const box = screen.getByTestId(`settings-reference-bible-${version.id}`)
      expect(box).toHaveAttribute("aria-checked", "false")
      // Base UI renders the checkbox as a span, so "disabled" is aria-disabled.
      expect(box).not.toHaveAttribute("aria-disabled", "true")
    }
  })

  it("shows each version's language, edition and licence so a lead can tell them apart", () => {
    renderSettings()
    expect(screen.getByText(/Arabic — Smith–Van Dyck \(1865\)/)).toBeTruthy()
    expect(screen.getAllByText(/Public domain/).length).toBeGreaterThan(0)
  })

  it("renders the project's stored versions as checked", () => {
    currentProject = makeProject({
      files: [],
      bibleResourcesEnabled: false,
      referenceBibleVersions: ["arb-vandyck"],
    })
    renderSettings()
    expect(screen.getByTestId("settings-reference-bible-arb-vandyck")).toHaveAttribute(
      "aria-checked",
      "true",
    )
    expect(screen.getByTestId("settings-reference-bible-eng-kjv")).toHaveAttribute(
      "aria-checked",
      "false",
    )
  })

  it("picking a version marks the form dirty — it persists only on an explicit save", () => {
    renderSettings()
    expect(screen.queryByRole("button", { name: /save changes/i })).toBeNull()
    fireEvent.click(screen.getByTestId("settings-reference-bible-arb-vandyck"))
    expect(screen.getByTestId("settings-reference-bible-arb-vandyck")).toHaveAttribute(
      "aria-checked",
      "true",
    )
    expect(screen.getByRole("button", { name: /save changes/i })).toBeTruthy()
  })

  it("at the cap, the chosen versions stay operable so one can be swapped for another", () => {
    currentProject = makeProject({
      files: [],
      bibleResourcesEnabled: false,
      referenceBibleVersions: REFERENCE_BIBLE_VERSIONS.slice(0, MAX_REFERENCE_BIBLE_VERSIONS).map(
        (v) => v.id,
      ),
    })
    renderSettings()
    for (const version of REFERENCE_BIBLE_VERSIONS.slice(0, MAX_REFERENCE_BIBLE_VERSIONS)) {
      expect(
        screen.getByTestId(`settings-reference-bible-${version.id}`),
      ).not.toHaveAttribute("aria-disabled", "true")
    }
    for (const version of REFERENCE_BIBLE_VERSIONS.slice(MAX_REFERENCE_BIBLE_VERSIONS)) {
      expect(screen.getByTestId(`settings-reference-bible-${version.id}`)).toHaveAttribute(
        "aria-disabled",
        "true",
      )
    }
  })

  it("clearing a version at the cap frees a slot again", () => {
    currentProject = makeProject({
      files: [],
      bibleResourcesEnabled: false,
      referenceBibleVersions: REFERENCE_BIBLE_VERSIONS.slice(0, MAX_REFERENCE_BIBLE_VERSIONS).map(
        (v) => v.id,
      ),
    })
    renderSettings()
    const beyondCap = REFERENCE_BIBLE_VERSIONS[MAX_REFERENCE_BIBLE_VERSIONS]
    fireEvent.click(screen.getByTestId(`settings-reference-bible-${REFERENCE_BIBLE_VERSIONS[0].id}`))
    expect(screen.getByTestId(`settings-reference-bible-${beyondCap.id}`)).not.toHaveAttribute(
      "aria-disabled",
      "true",
    )
  })
})

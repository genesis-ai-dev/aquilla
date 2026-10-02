// PR1 leftover #2 — Project Settings must show the project's STORED shared
// settings on a direct load or reload, the same as when it is opened from the
// editor's gear.
//
// Why these tests exist: this page passes `includeSettings: false` to
// `useProject` (it owns the editable settings hook itself), so on a cold load
// the `project` it receives is `minimalProjectRecord`, which carries none of
// the shared settings. The form was seeded once from that record, so every
// shared field showed its default: self-validation ON when the project had it
// OFF, one validator when it needed two, and so on. Worse, a stored OFF shown
// as ON could not be turned ON, because the toggle equalled the wrong baseline
// and Save sent nothing. Only languages (AQU-1115) and Bible resources
// (AQU-460) were ever re-synced.
//
// `read-validation-count` is deliberately NOT mocked here, so the counts go
// through the real reader.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { ProjectSettings } from "./ProjectSettings"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { ProjectWideSettings } from "@/lib/sync/project-settings"
import { overlayProjectSettings } from "@/lib/sync/overlay-project-settings"

vi.mock("@/components/org/OrgSidebar", () => ({
  OrgSidebar: () => <div data-testid="org-sidebar">sidebar</div>,
}))
vi.mock("@/components/org/OrgBreadcrumb", () => ({
  OrgBreadcrumb: ({ section }: { section?: string }) => <div data-testid="org-breadcrumb">{section}</div>,
}))

const PROJECT_ID = "proj-shared-settings-hydration"

/** Mirrors `minimalProjectRecord`: the server summary carries no shared
 *  settings, so the record this page sees on a cold load has none of them. */
function makeProject(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: PROJECT_ID,
    name: "Shared Settings Hydration Project",
    files: [],
    sourceLanguage: "",
    targetLanguage: "",
    syncRole: { level: 700, source: "creator" },
    ...overrides,
  } as unknown as ProjectRecord
}

/** Every value differs from the page's default for that field. */
const STORED: ProjectWideSettings = {
  allowSelfValidation: false,
  validationCount: 2,
  validationRoleFloorAudio: "maintainer",
  allowSelfValidationAudio: false,
  validationNamedUsersAudio: ["dev", "alice"],
  allowTrackEditing: true,
  timingLocked: false,
  cellEditingFloor: "contributor",
  harmonize_min_role: "maintainer",
}

const patch = vi.fn()
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
    patch,
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

vi.mock("@/hooks/useProjectMembers", () => ({
  useProjectMembers: () => ({
    members: [],
    isLoading: false,
    error: null,
    rosterHidden: false,
    refresh: vi.fn(),
    add: vi.fn(),
    addMany: vi.fn().mockResolvedValue([]),
    remove: vi.fn(),
    changeRole: vi.fn(),
  }),
}))

// A FRESH element every call: `rerender()` with a referentially identical
// element lets React bail out of reconciliation, so the second hydration phase
// would never be observed.
const tree = (pane: string) => (
  <MemoryRouter initialEntries={[`/project/${PROJECT_ID}/settings/${pane}`]}>
    <Routes>
      <Route path="/project/:id/settings" element={<ProjectSettings />} />
      <Route path="/project/:id/settings/:section" element={<ProjectSettings />} />
    </Routes>
  </MemoryRouter>
)

const isOn = (el: HTMLElement) =>
  el.getAttribute("aria-checked") === "true" || el.getAttribute("data-state") === "checked"
const selfValidation = () => screen.getByRole("switch", { name: /^allow self-validation$/i })
const saveButton = () => screen.queryByRole("button", { name: /save changes/i })

/** The validation pane: both validation policies and the harmonize floor. */
function expectStoredValidationPane() {
  expect(isOn(selfValidation())).toBe(false)
  expect((screen.getByLabelText(/required validators \(text\)/i) as HTMLInputElement).value).toBe("2")
  expect(document.getElementById("validation-role-floor-audio")).toHaveTextContent("Maintainer")
  expect(isOn(document.getElementById("allow-self-validation-audio") as HTMLElement)).toBe(false)
  expect(document.getElementById("validation-named-users-audio")).toHaveTextContent("dev, alice")
  expect(document.getElementById("harmonize-min-role")).toHaveTextContent("Maintainer")
}

beforeEach(() => {
  vi.clearAllMocks()
  patch.mockResolvedValue({ kind: "ok" })
  currentProject = makeProject()
  currentSettings = {}
  currentHasFetched = true
})

describe("ProjectSettings — stored shared settings on a direct load (PR1 leftover #2)", () => {
  it("shows the stored values when the settings are already fetched at mount", () => {
    currentSettings = STORED
    render(tree("validation"))
    expectStoredValidationPane()
    expect(saveButton()).toBeNull()
  })

  it("shows the stored timeline and cell-editing values on their panes", () => {
    currentSettings = STORED
    const { unmount } = render(tree("audio-media"))
    expect(isOn(screen.getByTestId("settings-allow-track-editing"))).toBe(true)
    expect(isOn(screen.getByTestId("settings-timing-locked"))).toBe(false)
    expect(saveButton()).toBeNull()
    unmount()

    render(tree("general"))
    expect(screen.getByTestId("settings-cell-editing-floor")).toHaveTextContent("Contributor")
    expect(saveButton()).toBeNull()
  })

  it("settles to the stored values when the settings arrive after the record", () => {
    // Phase 1: the record resolved, the settings GET has not: defaults show.
    currentHasFetched = false
    const { rerender } = render(tree("validation"))
    expect(isOn(selfValidation())).toBe(true)

    // Phase 2: the GET lands with the stored policy.
    currentSettings = STORED
    currentHasFetched = true
    rerender(tree("validation"))

    expectStoredValidationPane()
    // Settling to the stored values is not an edit.
    expect(saveButton()).toBeNull()
  })

  it("keeps a value the user changed before the settings arrived", () => {
    currentHasFetched = false
    const { rerender } = render(tree("validation"))
    const textCount = () => screen.getByLabelText(/required validators \(text\)/i) as HTMLInputElement
    // The default shows 1; the user asks for 3 before the GET lands.
    fireEvent.change(textCount(), { target: { value: "3" } })
    expect(textCount().value).toBe("3")

    // The GET lands with a stored 2.
    currentSettings = STORED
    currentHasFetched = true
    rerender(tree("validation"))

    // The user's 3 wins, and it is a real change against the stored 2.
    expect(textCount().value).toBe("3")
    expect(saveButton()).toBeTruthy()
    // Untouched fields still settled.
    expect(isOn(selfValidation())).toBe(false)
    expect(document.getElementById("harmonize-min-role")).toHaveTextContent("Maintainer")
  })

  it("leaves the gear path unchanged: the record already carries the stored values", () => {
    currentProject = overlayProjectSettings(makeProject(), STORED)
    currentSettings = STORED
    currentHasFetched = false
    const { rerender } = render(tree("validation"))
    expectStoredValidationPane()

    currentHasFetched = true
    rerender(tree("validation"))
    expectStoredValidationPane()
    expect(saveButton()).toBeNull()
  })

  it("turning a stored OFF back ON saves exactly that one field", async () => {
    currentHasFetched = false
    const { rerender } = render(tree("validation"))
    currentSettings = STORED
    currentHasFetched = true
    rerender(tree("validation"))
    expect(isOn(selfValidation())).toBe(false)

    fireEvent.click(selfValidation())
    expect(isOn(selfValidation())).toBe(true)
    fireEvent.click(saveButton() as HTMLElement)

    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1))
    expect(patch.mock.calls[0]?.[0]).toEqual({ allowSelfValidation: true })
  })
})

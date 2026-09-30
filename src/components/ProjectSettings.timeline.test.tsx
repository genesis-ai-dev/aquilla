// AQU-646 stage 2 — the Timeline card's three checkboxes.
//
// THESE ARE THE FIRST TESTS ANY OF THEM HAVE EVER HAD. `settings-timing-locked`
// and `settings-allow-line-creation` both shipped uncovered, and
// `settings-allow-track-editing` is the switch a whole stage of work hangs on:
// with it off, every control stage 2 adds is absent from the timeline. So all
// three are pinned here together rather than only the new one.
//
// What matters about a settings checkbox is not that it renders — it is the
// SEVEN-SITE wiring behind it. A box can look perfect and still be inert
// because someone added it to the baseline type and the JSX but not to the
// dirty check, or not to the save diff. Each of the tests below fails on a
// different one of those omissions:
//   · reads the project's value       → buildBaseline + applyBaseline
//   · toggling offers to save         → the dirty check AND its dep array
//   · saving sends the field          → the save diff
//
// The dep-array case is the sneaky one: without `allowTrackEditing` in it, the
// dirty memo keeps a stale closure and the Save button never appears — the box
// ticks and nothing else happens.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { ProjectSettings } from "./ProjectSettings"

vi.mock("@/components/org/OrgSidebar", () => ({
  OrgSidebar: () => <div data-testid="org-sidebar">sidebar</div>,
}))
vi.mock("@/components/org/OrgBreadcrumb", () => ({
  OrgBreadcrumb: () => <div data-testid="org-breadcrumb" />,
}))

import type { ProjectRecord } from "@/lib/parsers/types"

const PROJECT_ID = "proj-timeline-settings"

function makeProject(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: PROJECT_ID,
    name: "Timeline Settings Test Project",
    files: [],
    sourceLanguage: "English",
    targetLanguage: "Spanish",
    syncRole: { level: 700, source: "creator" },
    ...overrides,
  } as unknown as ProjectRecord
}

let currentProject: ProjectRecord = makeProject()
const patch = vi.fn().mockResolvedValue({ kind: "ok" })

vi.mock("@/hooks/useProject", () => ({
  useProject: () => ({ project: currentProject, loading: false, refresh: vi.fn() }),
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

/** The Timeline card lives in the "Audio media" pane; deep-link straight to it
 *  rather than clicking through the settings index. */
function renderSettings() {
  return render(
    <MemoryRouter initialEntries={[`/project/${PROJECT_ID}/settings/audio-media`]}>
      <Routes>
        <Route path="/project/:id/settings" element={<ProjectSettings />} />
        <Route path="/project/:id/settings/:section" element={<ProjectSettings />} />
      </Routes>
    </MemoryRouter>,
  )
}

const box = (testid: string) => screen.getByTestId(testid) as HTMLElement
const isChecked = (el: HTMLElement) =>
  el.getAttribute("aria-checked") === "true" || el.getAttribute("data-state") === "checked"

const saveButton = () => screen.queryByRole("button", { name: /save changes/i })

beforeEach(() => {
  vi.clearAllMocks()
  currentProject = makeProject()
})

// AQU-1068 retired the third box (add lines into the timeline's silences).
// Its successor is the "who can add and remove cells" tier, covered in
// ProjectSettings.cellEditing.test.tsx — which asserts this box is gone.
describe("ProjectSettings — the Timeline card renders both boxes", () => {
  it("shows the timing lock and the track-editing box", () => {
    renderSettings()
    expect(box("settings-timing-locked")).toBeTruthy()
    expect(box("settings-allow-track-editing")).toBeTruthy()
  })
})

describe("ProjectSettings — allowTrackEditing (AQU-646 stage 2)", () => {
  // The default is the whole point of the setting: a project that never turns
  // it on should not be able to tell multi-track was built.
  it("reads OFF on a project that has never heard of it", () => {
    currentProject = makeProject({ allowTrackEditing: undefined })
    renderSettings()
    expect(isChecked(box("settings-allow-track-editing"))).toBe(false)
    // Rendering a default must not look like an unsaved change.
    expect(saveButton()).toBeNull()
  })

  it("reads ON from a project that has opted in", () => {
    currentProject = makeProject({ allowTrackEditing: true })
    renderSettings()
    expect(isChecked(box("settings-allow-track-editing"))).toBe(true)
    expect(saveButton()).toBeNull()
  })

  // Fails if `allowTrackEditing` is missing from the dirty check OR from its
  // dependency array — in the second case the memo holds a stale closure and
  // the box ticks with no Save button, which is the exact shape of an inert
  // setting.
  it("offers to save once it is toggled", () => {
    renderSettings()
    fireEvent.click(box("settings-allow-track-editing"))
    expect(isChecked(box("settings-allow-track-editing"))).toBe(true)
    expect(saveButton()).toBeTruthy()
  })

  // Fails if the field is missing from the save diff — the box would tick, the
  // Save button would appear, the save would succeed, and nothing would change.
  it("sends the field to the server when saved", async () => {
    renderSettings()
    fireEvent.click(box("settings-allow-track-editing"))
    fireEvent.click(saveButton() as HTMLElement)
    await waitFor(() => expect(patch).toHaveBeenCalled())
    const sent = patch.mock.calls[0]?.[0] as Record<string, unknown>
    expect(sent.allowTrackEditing).toBe(true)
  })

  // The boxes are independent switches, not one policy. Turning track editing
  // on must not disturb the timing lock, which is a different question (may
  // timings MOVE) with a different default (on), nor the cell-editing tier
  // AQU-1068 put in the retired add-lines box's place.
  it("does not disturb its neighbours", async () => {
    currentProject = makeProject({ timingLocked: true, cellEditingFloor: "none" })
    renderSettings()
    fireEvent.click(box("settings-allow-track-editing"))
    fireEvent.click(saveButton() as HTMLElement)
    await waitFor(() => expect(patch).toHaveBeenCalled())
    const sent = patch.mock.calls[0]?.[0] as Record<string, unknown>
    expect(sent.allowTrackEditing).toBe(true)
    expect(sent).not.toHaveProperty("timingLocked")
    expect(sent).not.toHaveProperty("cellEditingFloor")
  })
})

describe("ProjectSettings — the timing lock, which shipped uncovered", () => {
  // Absent means LOCKED here, not unlocked: every project that predates the
  // setting must start ticked. The opposite reading would have quietly unlocked
  // every imported timing in the app.
  it("the timing lock reads ON when the project has never set it", () => {
    currentProject = makeProject({ timingLocked: undefined })
    renderSettings()
    expect(isChecked(box("settings-timing-locked"))).toBe(true)
  })

  it("the timing lock saves an explicit unlock", async () => {
    currentProject = makeProject({ timingLocked: undefined })
    renderSettings()
    fireEvent.click(box("settings-timing-locked"))
    fireEvent.click(saveButton() as HTMLElement)
    await waitFor(() => expect(patch).toHaveBeenCalled())
    expect((patch.mock.calls[0]?.[0] as Record<string, unknown>).timingLocked).toBe(false)
  })
})

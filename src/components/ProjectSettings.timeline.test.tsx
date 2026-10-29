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
import userEvent from "@testing-library/user-event"
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
/** AQU-1768: the org's media defaults the settings response carries. */
let orgMedia: Record<string, unknown> = {}
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
    orgMediaDefaults: orgMedia,
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
  orgMedia = {}
})

/** AQU-1768: a box follows the organization until "Set for this project". */
async function setForThisProject(sourceTestId: string) {
  await userEvent.click(screen.getByTestId(sourceTestId))
  await userEvent.click(await screen.findByRole("option", { name: "Set for this project" }))
}

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
  // AQU-2214 FLIPPED THIS DEFAULT, and the pair below is the regression guard.
  // It shipped off-by-default — a project that never turned it on was not
  // supposed to be able to tell multi-track was built — and Sam reversed that
  // after the ETEN demo: adding a track is the ordinary case. What the flip
  // must NOT do is overwrite a project that already answered, which is why the
  // explicit-off case is asserted beside the unset one.
  it("reads ON on a project that has never heard of it", () => {
    currentProject = makeProject({ allowTrackEditing: undefined })
    renderSettings()
    expect(isChecked(box("settings-allow-track-editing"))).toBe(true)
    // Rendering a default must not look like an unsaved change.
    expect(saveButton()).toBeNull()
  })

  it("reads OFF on a project that turned it off", () => {
    currentProject = makeProject({ allowTrackEditing: false })
    renderSettings()
    expect(isChecked(box("settings-allow-track-editing"))).toBe(false)
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
  // setting. Post-AQU-2214 the box starts ON, so the toggle under test is the
  // one that turns it OFF.
  it("offers to save once it is toggled", async () => {
    renderSettings()
    await setForThisProject("allow-track-editing-source")
    fireEvent.click(box("settings-allow-track-editing"))
    expect(isChecked(box("settings-allow-track-editing"))).toBe(false)
    expect(saveButton()).toBeTruthy()
  })

  // Fails if the field is missing from the save diff — the box would tick, the
  // Save button would appear, the save would succeed, and nothing would change.
  it("sends the field to the server when saved", async () => {
    renderSettings()
    await setForThisProject("allow-track-editing-source")
    fireEvent.click(box("settings-allow-track-editing"))
    fireEvent.click(saveButton() as HTMLElement)
    await waitFor(() => expect(patch).toHaveBeenCalled())
    const sent = patch.mock.calls[0]?.[0] as Record<string, unknown>
    expect(sent.allowTrackEditing).toBe(false)
  })

  // AQU-2214: "Set for this project" on its own pins the default as the
  // project's OWN answer — which is what an org-wide change must not be able
  // to take away afterwards. Without the box being touched at all.
  it("saves an explicit yes when the project only stops following the default", async () => {
    renderSettings()
    await setForThisProject("allow-track-editing-source")
    expect(isChecked(box("settings-allow-track-editing"))).toBe(true)
    fireEvent.click(saveButton() as HTMLElement)
    await waitFor(() => expect(patch).toHaveBeenCalled())
    expect((patch.mock.calls[0]?.[0] as Record<string, unknown>).allowTrackEditing).toBe(true)
  })

  // The boxes are independent switches, not one policy. Changing track editing
  // must not disturb the timing lock, which is a different question (may
  // timings MOVE), nor the cell-editing tier AQU-1068 put in the retired
  // add-lines box's place.
  it("does not disturb its neighbours", async () => {
    currentProject = makeProject({ timingLocked: true, cellEditingFloor: "none" })
    renderSettings()
    await setForThisProject("allow-track-editing-source")
    fireEvent.click(box("settings-allow-track-editing"))
    fireEvent.click(saveButton() as HTMLElement)
    await waitFor(() => expect(patch).toHaveBeenCalled())
    const sent = patch.mock.calls[0]?.[0] as Record<string, unknown>
    expect(sent.allowTrackEditing).toBe(false)
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
    await setForThisProject("timing-locked-source")
    fireEvent.click(box("settings-timing-locked"))
    fireEvent.click(saveButton() as HTMLElement)
    await waitFor(() => expect(patch).toHaveBeenCalled())
    expect((patch.mock.calls[0]?.[0] as Record<string, unknown>).timingLocked).toBe(false)
  })
})

describe("ProjectSettings — media settings follow the organization (AQU-1768)", () => {
  it("shows the organization's choice, disabled, while the project sets none", () => {
    orgMedia = { timingLocked: false, allowTrackEditing: true }
    currentProject = makeProject({ timingLocked: undefined, allowTrackEditing: undefined })
    renderSettings()
    expect(isChecked(box("settings-timing-locked"))).toBe(false)
    expect(isChecked(box("settings-allow-track-editing"))).toBe(true)
    const lock = box("settings-timing-locked")
    expect(lock.hasAttribute("disabled") || lock.getAttribute("aria-disabled") === "true" || lock.hasAttribute("data-disabled")).toBe(true)
    expect(box("timing-locked-source").textContent).toContain("Organization default (off)")
    expect(box("allow-track-editing-source").textContent).toContain("Organization default (on)")
    expect(saveButton()).toBeNull()
  })

  it("'Set for this project' starts from the organization's value and saves only once edited", async () => {
    orgMedia = { allowTrackEditing: true }
    renderSettings()
    await setForThisProject("allow-track-editing-source")
    expect(isChecked(box("settings-allow-track-editing"))).toBe(true)
    fireEvent.click(box("settings-allow-track-editing"))
    fireEvent.click(saveButton() as HTMLElement)
    await waitFor(() => expect(patch).toHaveBeenCalled())
    expect((patch.mock.calls[0]?.[0] as Record<string, unknown>).allowTrackEditing).toBe(false)
  })

  it("going back to the organization's default clears the project's own value", async () => {
    currentProject = makeProject({ timingLocked: false })
    renderSettings()
    await userEvent.click(box("timing-locked-source"))
    await userEvent.click(await screen.findByRole("option", { name: "Organization default (on)" }))
    fireEvent.click(saveButton() as HTMLElement)
    await waitFor(() => expect(patch).toHaveBeenCalled())
    const sent = patch.mock.calls[0]?.[0] as Record<string, unknown>
    expect("timingLocked" in sent && sent.timingLocked === undefined).toBe(true)
  })
})

// AQU-1758 (Sam's decision 7): the Sources menu in the media view's top bar,
// the film first in it, behind one setting beside track editing. Unset, a project of
// books and documents hides them and any other shows them.
describe("ProjectSettings — film and sources (AQU-1758)", () => {
  const bookFiles = [{ id: "f1", name: "Ruth", type: "usfm", orderedBy: "sequence" }]
  const filmFiles = [{ id: "f2", name: "Episode 1.vtt", type: "vtt", orderedBy: "time" }]

  it("reads OFF on a book project that never chose", () => {
    currentProject = makeProject({ files: bookFiles as unknown as ProjectRecord["files"] })
    renderSettings()
    expect(isChecked(box("settings-film-and-sources"))).toBe(false)
    expect(box("settings-film-and-sources-info")).toHaveAttribute("aria-label", "About the film and sources tools")
    expect(saveButton()).toBeNull()
  })

  it("reads ON on any other project that never chose", () => {
    currentProject = makeProject({ files: filmFiles as unknown as ProjectRecord["files"] })
    renderSettings()
    expect(isChecked(box("settings-film-and-sources"))).toBe(true)
  })

  // AQU-1758: on this layout there is no Film button; the film is the first
  // item in the Sources menu in the media view's top bar, and the (i) says so.
  // Sam, Oct 28: an (i) is a button that opens its text in place beneath the
  // title on a click, and closes it on another — never a hover.
  it("its (i) opens, on a click, the film being the first item in the top bar's Sources menu", () => {
    currentProject = makeProject({ files: filmFiles as unknown as ProjectRecord["files"] })
    renderSettings()
    const info = box("settings-film-and-sources-info")
    const text = document.getElementById("settings-film-and-sources-explanation") as HTMLElement
    expect(info).toHaveAttribute("aria-expanded", "false")
    expect(info).toHaveAttribute("aria-controls", "settings-film-and-sources-explanation")
    expect(text.dataset.open).toBe("false")
    fireEvent.click(info)
    expect(info).toHaveAttribute("aria-expanded", "true")
    expect(text.dataset.open).toBe("true")
    expect(text).toHaveTextContent("Shows the Sources menu in the media view's top bar.")
    expect(text).toHaveTextContent("Its first item is the film, for linking a video")
    expect(text).not.toHaveTextContent(/Film button/)
    // Clicking the (i) beside the label never ticks its box.
    expect(isChecked(box("settings-film-and-sources"))).toBe(true)
    fireEvent.click(info)
    expect(text.dataset.open).toBe("false")
  })

  it("saves the choice a maintainer makes", async () => {
    currentProject = makeProject({ files: bookFiles as unknown as ProjectRecord["files"] })
    renderSettings()
    fireEvent.click(box("settings-film-and-sources"))
    expect(isChecked(box("settings-film-and-sources"))).toBe(true)
    fireEvent.click(saveButton() as HTMLElement)
    await waitFor(() => expect(patch).toHaveBeenCalled())
    expect((patch.mock.calls[0]?.[0] as Record<string, unknown>).filmAndSources).toBe(true)
  })
})

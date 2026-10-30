// AQU-646 stage 2 — the Timeline card's three checkboxes.
//
// THESE ARE THE FIRST TESTS ANY OF THEM HAVE EVER HAD. `settings-timing-locked`
// and `settings-allow-line-creation` both shipped uncovered, and
// `settings-allow-track-editing` is the switch a whole stage of work hangs on:
// with it off, every control stage 2 adds is absent from the timeline. So all
// three are pinned here together rather than only the new one.
//
// What matters about a settings checkbox is not that it renders — it is the
// wiring behind it. A box can look perfect and still be inert. Each of the
// tests below fails on a different omission:
//   · reads the project's value       → readSavedSettings
//   · toggling saves the field        → the box's own write (AQU-2262: every
//                                       setting saves the moment it changes)
//   · the write carries only that field, so it cannot disturb its neighbours

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
/** The shared settings as the hook reads them: the server's copy over this
 *  browser's, so a project's own value is in here too. */
let currentSettings: Record<string, unknown> = {}
const patch = vi.fn().mockResolvedValue({ kind: "ok" })

vi.mock("@/hooks/useProject", () => ({
  useProject: () => ({ project: currentProject, loading: false, refresh: vi.fn() }),
}))

// AQU-2262: a write shows on the page, as the real hook's overlay does.
vi.mock("@/hooks/useProjectSettings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/useProjectSettings")>()
  const { useLiveProjectSettings } = await import("@/test-utils/live-project-settings")
  return {
    ...actual,
    useProjectSettings: () => useLiveProjectSettings(() => ({ settings: currentSettings, patch, orgMediaDefaults: orgMedia })),
  }
})

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
  patchProject: vi.fn().mockResolvedValue(null),
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

/** The Timeline card lives in the "Media" pane; deep-link straight to it
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

/** What each write sent, in order. */
const sent = () => patch.mock.calls.map((c) => c[0] as Record<string, unknown>)

beforeEach(() => {
  vi.clearAllMocks()
  currentProject = makeProject()
  orgMedia = {}
  currentSettings = {}
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
    // Rendering a default must not write anything.
    expect(patch).not.toHaveBeenCalled()
  })

  it("reads OFF on a project that turned it off", () => {
    currentProject = makeProject({ allowTrackEditing: false })
    renderSettings()
    expect(isChecked(box("settings-allow-track-editing"))).toBe(false)
    expect(patch).not.toHaveBeenCalled()
  })

  it("reads ON from a project that has opted in", () => {
    currentProject = makeProject({ allowTrackEditing: true })
    renderSettings()
    expect(isChecked(box("settings-allow-track-editing"))).toBe(true)
    expect(patch).not.toHaveBeenCalled()
  })

  // Fails if the box's change never reaches the server — the box would tick
  // and nothing would change, the exact shape of an inert setting. It saves
  // the moment it is toggled; there is no Save bar (AQU-2262). Post-AQU-2214
  // the box starts ON, so the toggle under test is the one that turns it OFF.
  it("sends the field to the server the moment it is toggled", async () => {
    renderSettings()
    await setForThisProject("allow-track-editing-source")
    fireEvent.click(box("settings-allow-track-editing"))
    await waitFor(() => expect(sent().at(-1)).toEqual({ allowTrackEditing: false }))
    expect(isChecked(box("settings-allow-track-editing"))).toBe(false)
    expect(screen.queryByRole("button", { name: /save changes/i })).toBeNull()
  })

  // AQU-2214: "Set for this project" on its own pins the default as the
  // project's OWN answer — which is what an org-wide change must not be able
  // to take away afterwards. Without the box being touched at all.
  it("saves an explicit yes when the project only stops following the default", async () => {
    renderSettings()
    await setForThisProject("allow-track-editing-source")
    expect(isChecked(box("settings-allow-track-editing"))).toBe(true)
    await waitFor(() => expect(sent()).toEqual([{ allowTrackEditing: true }]))
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
    await waitFor(() => expect(sent().at(-1)).toEqual({ allowTrackEditing: false }))
    for (const write of sent()) {
      expect(write).not.toHaveProperty("timingLocked")
      expect(write).not.toHaveProperty("cellEditingFloor")
    }
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
    await waitFor(() => expect(sent().at(-1)).toEqual({ timingLocked: false }))
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
    expect(patch).not.toHaveBeenCalled()
  })

  // "Set for this project" saves the organization's value as the project's
  // own (AQU-2214), then the box saves what it is changed to.
  it("'Set for this project' starts from the organization's value", async () => {
    orgMedia = { allowTrackEditing: true }
    renderSettings()
    await setForThisProject("allow-track-editing-source")
    expect(isChecked(box("settings-allow-track-editing"))).toBe(true)
    await waitFor(() => expect(sent()).toEqual([{ allowTrackEditing: true }]))
    fireEvent.click(box("settings-allow-track-editing"))
    await waitFor(() => expect(sent()).toEqual([{ allowTrackEditing: true }, { allowTrackEditing: false }]))
  })

  it("going back to the organization's default clears the project's own value", async () => {
    currentProject = makeProject({ timingLocked: false })
    currentSettings = { timingLocked: false }
    renderSettings()
    await userEvent.click(box("timing-locked-source"))
    await userEvent.click(await screen.findByRole("option", { name: "Organization default (on)" }))
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1))
    const write = sent()[0]
    expect("timingLocked" in write && write.timingLocked === undefined).toBe(true)
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
    expect(screen.queryByRole("button", { name: /save changes/i })).toBeNull()
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

  // AQU-2262: it saves the moment it is ticked; there is no Save bar.
  it("saves the choice a maintainer makes", async () => {
    currentProject = makeProject({ files: bookFiles as unknown as ProjectRecord["files"] })
    renderSettings()
    fireEvent.click(box("settings-film-and-sources"))
    await waitFor(() => expect(sent()).toEqual([{ filmAndSources: true }]))
    expect(isChecked(box("settings-film-and-sources"))).toBe(true)
  })
})

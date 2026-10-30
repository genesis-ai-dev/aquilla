// Project Settings must show what the server has stored, after a reload.
//
// This page loads the project WITHOUT the synced-settings overlay
// (`useProject(..., { includeSettings: false })`) because it owns its own
// `useProjectSettings` instance. So every setting that lives only in the shared
// settings blob is absent from `project` here, and a baseline seeded from
// `project.*` alone shows the default even when the server has the setting on.
// The user then sees a lie, and may "re-enable" a setting that is already on.
//
// What these tests hold: for each blob-backed setting, a stored non-default
// value in the settings blob (NOT on the project record — earlier tests put it
// there and so could not see this bug) reads back into its control; and the
// re-sync never stomps an edit the user has already started. AQU-2262: every
// setting saves as it changes, so "an edit started" is a typing field still
// being typed in, or a language row open for editing.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { fireEvent, screen } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { ProjectSettings } from "./ProjectSettings"
import { renameProject } from "@/lib/sync/cloud-projects"
import type { ProjectRecord } from "@/lib/parsers/types"
import { renderWithTooltips } from "@/test-utils/tooltip"
import { TooltipProvider } from "@/components/ui/tooltip"
import { STALL_WATCHDOG_MS } from "@/test-utils/timeouts"

const PROJECT_ID = "proj-blob-readback"

function makeProject(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: PROJECT_ID,
    name: "Blob Readback Test Project",
    files: [],
    sourceLanguage: "",
    targetLanguage: "",
    syncRole: { level: 600, source: "member" },
    ...overrides,
  } as unknown as ProjectRecord
}

const patchSpy = vi.fn().mockResolvedValue({ kind: "ok" })

type SettingsLane = {
  id: string
  role: "source" | "target"
  language: string | null
  name: string | null
  langCode: string | null
  legacyTag: string | null
  position: number
  archivedAt: null
}

function lanesFor(source: string, target: string): SettingsLane[] {
  return [
    { id: "source-lane", role: "source", language: source, name: null, langCode: null, legacyTag: null, position: 0, archivedAt: null },
    { id: "target-lane", role: "target", language: target, name: null, langCode: null, legacyTag: "", position: 1, archivedAt: null },
  ]
}

let currentProject: ProjectRecord = makeProject()
let currentSettings: Record<string, unknown> = {}
let currentHasFetched = true
let currentLanes: SettingsLane[] = lanesFor("", "")

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
    canEditLanguages: true,
    reasonCannotEditLanguages: null,
    patch: patchSpy,
    lanes: currentLanes,
    renameLane: vi.fn().mockResolvedValue("ok"),
    createLane: vi.fn().mockResolvedValue({ kind: "ok" }),
    setLaneArchived: vi.fn().mockResolvedValue({ kind: "ok" }),
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

vi.mock("@/hooks/useProjectMembers", () => ({
  useProjectMembers: () => ({
    members: [
      { userId: 1, username: "alice", role: { level: 700, name: "owner", source: "creator" as const }, secondarySources: [] },
      { userId: 2, username: "bob", role: { level: 300, name: "reviewer", source: "override" as const }, secondarySources: [] },
    ],
    isLoading: false, error: null, rosterHidden: false,
    refresh: async () => {}, add: async () => null, addMany: async () => [],
    remove: async () => {}, changeRole: async () => null,
  }),
}))

vi.mock("@/hooks/useOrg", () => ({
  useOrg: () => ({ org: null }),
}))

vi.mock("@/components/org/OrgSidebar", () => ({
  OrgSidebar: () => <div data-testid="org-sidebar">sidebar</div>,
}))
vi.mock("@/components/org/OrgBreadcrumb", () => ({
  OrgBreadcrumb: ({ section, trail }: { section: string; trail?: { label: string }[] }) => (
    <div data-testid="org-breadcrumb">
      {section}
      {(trail ?? []).map((t: { label: string }) => ` › ${t.label}`).join("")}
    </div>
  ),
}))

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "tok", username: "tester", email: "t@example.com" }, loading: false }),
}))

vi.mock("@/hooks/useAccounts", () => ({
  useAccounts: () => ({ active: null, sessions: [], loading: false, add: vi.fn(), activate: vi.fn(), remove: vi.fn() }),
}))

vi.mock("@/components/AccountSwitcher", () => ({
  AccountSwitcher: () => <div data-testid="account-switcher" />,
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
  getProject: vi.fn(async () => currentProject),
  updateProject: vi.fn().mockResolvedValue(undefined),
  // This browser's copy of the project, which the page's project read follows.
  patchProject: vi.fn(async (_id: string, fn: (p: ProjectRecord) => ProjectRecord) => (currentProject = fn(currentProject))),
}))

vi.mock("@/lib/sync/cloud-projects", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sync/cloud-projects")>()
  return {
    ...actual,
    renameProject: vi.fn(async (_jwt: string, id: string, name: string) => ({ id, name })),
  }
})

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

function settingsTree(pane: string) {
  return (
    <MemoryRouter initialEntries={[`/project/${PROJECT_ID}/settings/${pane}`]}>
      <Routes>
        <Route path="/project/:id/settings" element={<ProjectSettings />} />
        <Route path="/project/:id/settings/:section" element={<ProjectSettings />} />
      </Routes>
    </MemoryRouter>
  )
}

function renderSettings(pane: string) {
  return renderWithTooltips(settingsTree(pane))
}

beforeEach(() => {
  vi.clearAllMocks()
  patchSpy.mockResolvedValue({ kind: "ok" })
  currentProject = makeProject()
  currentSettings = {}
  currentHasFetched = true
  currentLanes = lanesFor("", "")
})

describe("ProjectSettings — blob-only settings read back after a reload", () => {
  it("importExcludeFrontMatter", () => {
    currentSettings = { importExcludeFrontMatter: true }
    renderSettings("general")
    expect(screen.getByRole("switch", { name: "Exclude USFM front matter" })).toBeChecked()
  })

  it("cellEditingFloor", () => {
    currentSettings = { cellEditingFloor: "maintainer" }
    renderSettings("general")
    expect(screen.getByTestId("settings-cell-editing-floor")).toHaveTextContent("Maintainer")
  })

  it("shows lane languages and does not read sourceLanguage / targetLanguage keys", () => {
    currentLanes = lanesFor("Greek", "Tok Pisin")
    currentSettings = { sourceLanguage: "Spanish", targetLanguage: "German" }
    renderSettings("general")
    // Media redesign (design B): the source is one line, a target's language
    // is plain text in the table.
    expect(screen.getByTestId("source-language-line")).toHaveTextContent("Greek")
    expect(screen.getByTestId("lane-language-cell-target-lane")).toHaveTextContent("Tok Pisin")
    expect(screen.queryByText("Spanish")).toBeNull()
    expect(screen.queryByText("German")).toBeNull()
    expect(screen.queryByDisplayValue("Spanish")).toBeNull()
    expect(screen.queryByDisplayValue("German")).toBeNull()
  })

  it("timingLocked (absent means locked, so a stored false must show unlocked)", () => {
    currentSettings = { timingLocked: false }
    renderSettings("audio-media")
    expect(screen.getByTestId("settings-timing-locked")).not.toBeChecked()
  })

  it("allowTrackEditing (absent means ON since AQU-2214, so a stored false must show off)", () => {
    currentSettings = { allowTrackEditing: false }
    renderSettings("audio-media")
    expect(screen.getByTestId("settings-allow-track-editing")).not.toBeChecked()
  })

  it("draftContext.precedingTargetCells", () => {
    currentSettings = { draftContext: { precedingTargetCells: 7 } }
    renderSettings("ai")
    expect(screen.getByRole("spinbutton", { name: "Preceding committed-target cells" })).toHaveValue(7)
  })

  it("termMatching", () => {
    currentSettings = { termMatching: { prefixes: ["ge"], suffixes: [] } }
    renderSettings("ai")
    expect(screen.getByRole("button", { name: "Remove ge" })).toBeInTheDocument()
  })

  it("validationCount", () => {
    currentSettings = { validationCount: 3 }
    renderSettings("validation")
    expect(screen.getByRole("spinbutton", { name: "Required validators (text)" })).toHaveValue(3)
  })

  it("validationCountAudio", () => {
    currentSettings = { validationCountAudio: 4 }
    renderSettings("validation")
    expect(screen.getByRole("spinbutton", { name: "Required validators (audio)" })).toHaveValue(4)
  })

  it("validationRoleFloor", () => {
    currentSettings = { validationRoleFloor: "maintainer" }
    renderSettings("validation")
    expect(screen.getByRole("combobox", { name: "Minimum validator role" })).toHaveTextContent("Maintainer")
  })

  it("validationRoleFloorAudio", () => {
    currentSettings = { validationRoleFloorAudio: "maintainer" }
    renderSettings("validation")
    expect(screen.getByRole("combobox", { name: "Minimum role to validate recordings" })).toHaveTextContent("Maintainer")
  })

  it("allowSelfValidation (absent means allowed, so a stored false must show off)", () => {
    currentSettings = { allowSelfValidation: false }
    renderSettings("validation")
    expect(screen.getByRole("switch", { name: "Allow self-validation (text)" })).not.toBeChecked()
  })

  it("allowSelfValidationAudio", () => {
    currentSettings = { allowSelfValidationAudio: false }
    renderSettings("validation")
    expect(screen.getByRole("switch", { name: "Allow validating your own recordings" })).not.toBeChecked()
  })

  // With nobody named, the trigger lists every eligible member, so "contains
  // bob" alone would pass on the bug. Only bob — no alice — is the read-back.
  it("validationNamedUsers", () => {
    currentSettings = { validationNamedUsers: ["bob"] }
    renderSettings("validation")
    const trigger = screen.getByRole("combobox", { name: "Named validators" })
    expect(trigger).toHaveTextContent("bob")
    expect(trigger).not.toHaveTextContent("alice")
  })

  it("validationNamedUsersAudio", () => {
    currentSettings = { validationNamedUsersAudio: ["bob"] }
    renderSettings("validation")
    const trigger = screen.getByRole("combobox", { name: /Named recording validators/i })
    expect(trigger).toHaveTextContent("bob")
    expect(trigger).not.toHaveTextContent("alice")
  })

  it("harmonize_min_role", () => {
    currentSettings = { harmonize_min_role: "maintainer" }
    renderSettings("validation")
    expect(screen.getByRole("combobox", { name: "Minimum role to run a harmonization sweep" })).toHaveTextContent("Maintainer")
  })
})

describe("ProjectSettings — the re-sync does not stomp an in-progress edit", () => {
  it("keeps a number still being typed when the settings GET resolves, and saves only that", async () => {
    currentSettings = { validationCount: 1 }
    const view = renderSettings("validation")
    const count = () => screen.getByRole("spinbutton", { name: "Required validators (text)" })
    fireEvent.change(count(), { target: { value: "2" } })
    expect(count()).toHaveValue(2)

    // A re-sync lands while the box is still being typed in, with a different
    // stored count and a setting the user never touched.
    currentSettings = { validationCount: 3, allowSelfValidation: false }
    view.rerender(<TooltipProvider delay={0}>{settingsTree("validation")}</TooltipProvider>)

    // The user's typing survives; the untouched field adopts the server value.
    expect(count()).toHaveValue(2)
    expect(screen.getByRole("switch", { name: "Allow self-validation (text)" })).not.toBeChecked()
    expect(patchSpy).not.toHaveBeenCalled()

    // Leaving the box saves it (AQU-2262): only the user's change is sent.
    fireEvent.blur(count())
    await vi.waitFor(() => expect(patchSpy).toHaveBeenCalledTimes(1))
    expect(patchSpy.mock.calls[0][0]).toEqual({ validationCount: 2 })
  })
})

/** The source language's Language box, once Change has opened it. */
const sourceLanguageField = () => screen.getByTestId("lane-language-source-lane")

describe("ProjectSettings — a settings GET that lands after the name saved", () => {
  it("does not revert a language being edited, or the saved name (AQU-1744)", async () => {
    currentHasFetched = false
    const view = renderSettings("general")

    const renamed = "Blob Readback Test Project renamed"
    const nameField = screen.getByLabelText("Project name")
    fireEvent.change(nameField, { target: { value: renamed } })
    // The name saves when you leave it (AQU-2262).
    fireEvent.blur(nameField)
    await vi.waitFor(() => expect(renameProject).toHaveBeenCalledWith("tok", PROJECT_ID, renamed))
    expect(await screen.findByTestId("save-status-name")).toHaveTextContent("Saved")
    // The source line's Change opens its fields.
    fireEvent.click(screen.getByTestId("source-language-change"))
    fireEvent.change(sourceLanguageField(), { target: { value: "English (US)" } })
    expect(sourceLanguageField()).toHaveValue("English (US)")
    // Neither the name nor a language is a settings-blob write.
    expect(patchSpy).not.toHaveBeenCalled()

    // The GET resolves after the rename. A stale settings key must not revert
    // the language the user is typing. An untouched blob field still adopts
    // the server value.
    currentSettings = { sourceLanguage: "Greek", smartQuotes: true }
    currentHasFetched = true
    view.rerender(<TooltipProvider delay={0}>{settingsTree("general")}</TooltipProvider>)

    expect(sourceLanguageField()).toHaveValue("English (US)")
    expect(screen.getByLabelText("Project name")).toHaveValue(renamed)
    // The untouched field adopts the server value, and that is not an edit.
    expect(screen.getByRole("switch", { name: "Smart quotes" })).toBeChecked()
    expect(patchSpy).not.toHaveBeenCalled()
  })

  it("keeps the language being edited when the stale GET resolves during the rename (AQU-1744)", async () => {
    currentHasFetched = false
    const view = renderSettings("general")

    // The source line's Change opens its fields.
    fireEvent.click(screen.getByTestId("source-language-change"))
    fireEvent.change(sourceLanguageField(), { target: { value: "English (US)" } })

    // Hold the rename open so the stale GET lands while it is in flight.
    let resolveRename: (value: { id: string; name: string }) => void = () => {}
    vi.mocked(renameProject).mockImplementationOnce(
      () => new Promise((resolve) => { resolveRename = resolve }),
    )
    const nameField = screen.getByLabelText("Project name")
    fireEvent.change(nameField, { target: { value: "Blob Readback Test Project renamed" } })
    fireEvent.blur(nameField)
    await vi.waitFor(() => expect(renameProject).toHaveBeenCalled(), { timeout: STALL_WATCHDOG_MS })

    // The GET was in flight before the rename finished. Its sourceLanguage key
    // is stale, and it carries a blob field the user never touched.
    currentSettings = { sourceLanguage: "Greek", smartQuotes: true }
    currentHasFetched = true
    view.rerender(<TooltipProvider delay={0}>{settingsTree("general")}</TooltipProvider>)

    resolveRename({ id: PROJECT_ID, name: "Blob Readback Test Project renamed" })

    expect(await screen.findByTestId("save-status-name")).toHaveTextContent("Saved")
    expect(patchSpy).not.toHaveBeenCalled()
    expect(sourceLanguageField()).toHaveValue("English (US)")
    expect(screen.getByRole("switch", { name: "Smart quotes" })).toBeChecked()
  })
})

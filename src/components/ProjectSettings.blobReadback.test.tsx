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
// re-sync never stomps an edit the user has already started.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { fireEvent, screen } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { ProjectSettings } from "./ProjectSettings"
import type { ProjectRecord } from "@/lib/parsers/types"
import { renderWithTooltips } from "@/test-utils/tooltip"
import { TooltipProvider } from "@/components/ui/tooltip"
import userEvent from "@testing-library/user-event"

// AQU-1573: the Reference Bible card lists the server's Bibles when the General
// pane renders on a cloud project; answer locally (none installed).
vi.mock("@/lib/frontier/reference-bibles", () => ({
  fetchReferenceBibles: vi.fn(async () => []),
  fetchReferencePassages: vi.fn(async () => null),
}))

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

let currentProject: ProjectRecord = makeProject()
let currentSettings: Record<string, unknown> = {}
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
    patch: patchSpy,
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
  currentProject = makeProject()
  currentSettings = {}
  currentHasFetched = true
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

  it("sourceLanguage / targetLanguage", () => {
    currentSettings = { sourceLanguage: "Greek", targetLanguage: "Tok Pisin" }
    renderSettings("general")
    expect(screen.getByDisplayValue("Greek")).toBeInTheDocument()
    expect(screen.getByDisplayValue("Tok Pisin")).toBeInTheDocument()
  })

  it("timingLocked (absent means locked, so a stored false must show unlocked)", () => {
    currentSettings = { timingLocked: false }
    renderSettings("audio-media")
    expect(screen.getByTestId("settings-timing-locked")).not.toBeChecked()
  })

  it("allowTrackEditing", () => {
    currentSettings = { allowTrackEditing: true }
    renderSettings("audio-media")
    expect(screen.getByTestId("settings-allow-track-editing")).toBeChecked()
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
    expect(screen.getByRole("switch", { name: "Allow self-validation" })).not.toBeChecked()
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
    const trigger = screen.getByRole("combobox", { name: "Named validators (optional)" })
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
  it("keeps a value the user typed before the settings GET resolved, and saves only that", async () => {
    const user = userEvent.setup()
    currentHasFetched = false
    const view = renderSettings("validation")
    const count = () => screen.getByRole("spinbutton", { name: "Required validators (text)" })
    // The field clamps an empty value back to 1, so set it in one change.
    fireEvent.change(count(), { target: { value: "2" } })
    expect(count()).toHaveValue(2)

    // The GET resolves with a different stored count than both the seed and
    // the user's edit, plus a setting the user never touched.
    currentSettings = { validationCount: 3, allowSelfValidation: false }
    currentHasFetched = true
    // Same tree as renderWithTooltips, so React keeps the mounted page.
    view.rerender(<TooltipProvider delay={0}>{settingsTree("validation")}</TooltipProvider>)

    // The user's edit survives; the untouched field adopts the server value.
    expect(count()).toHaveValue(2)
    expect(screen.getByRole("switch", { name: "Allow self-validation" })).not.toBeChecked()

    // Settling to the server value is not an edit: only the user's change is sent.
    await user.click(screen.getByRole("button", { name: /save changes/i }))
    expect(patchSpy).toHaveBeenCalledTimes(1)
    expect(patchSpy.mock.calls[0][0]).toEqual({ validationCount: 2 })
  })
})

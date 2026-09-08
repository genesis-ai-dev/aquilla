// AQU-1068 — the "who can add and remove cells" tier, in Project Settings.
//
// The setting it replaces was a checkbox in the Timeline card, which put a
// project-wide permission behind an audio-shaped heading. It now governs
// ordinary text files too, so it sits in General with the everyday settings.
//
// What these tests hold: the control renders "No one" for a project that has
// never set it (the default is refusal, not a rank); a stored tier round-trips
// into the control; changing it patches `cellEditingFloor` and nothing else;
// and the retired checkbox is gone from the Timeline card.
//
// The tier list is the product's standard permission ladder (Matthew's review,
// approved by Sam 2026-09-08), not the bespoke phrases it shipped with, so the
// labels asserted here are the same words the Members panel uses. Two of the
// rungs — Commenter and Reviewer — are only real because the static floor for
// source.cell.create/delete/reorder dropped to COMMENTER underneath the tier
// gate; see sync-worker/src/__tests__/authorize-cell-editing.test.ts.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { screen } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { ProjectSettings } from "./ProjectSettings"
import type { ProjectRecord } from "@/lib/parsers/types"
import { renderWithTooltips } from "@/test-utils/tooltip"
import userEvent from "@testing-library/user-event"

const PROJECT_ID = "proj-cell-editing"

function makeProject(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: PROJECT_ID,
    name: "Cell Editing Settings Test Project",
    files: [],
    sourceLanguage: "English",
    targetLanguage: "French",
    syncRole: { level: 600, source: "member" },
    ...overrides,
  } as unknown as ProjectRecord
}

const patchSpy = vi.fn().mockResolvedValue({ kind: "ok" })

let currentProject: ProjectRecord = makeProject()
let currentCanEdit = true
let currentReasonCannotEdit: "offline" | "role" | null = null

vi.mock("@/hooks/useProject", () => ({
  useProject: () => ({
    project: currentProject,
    loading: false,
    refresh: vi.fn(),
  }),
}))

vi.mock("@/hooks/useProjectSettings", () => ({
  useProjectSettings: () => ({
    canEdit: currentCanEdit,
    reasonCannotEdit: currentReasonCannotEdit,
    patch: patchSpy,
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

function renderSettings(path = `/project/${PROJECT_ID}/settings`) {
  return renderWithTooltips(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/project/:id/settings" element={<ProjectSettings />} />
        <Route path="/project/:id/settings/:section" element={<ProjectSettings />} />
      </Routes>
    </MemoryRouter>,
  )
}

const PANE = `/project/${PROJECT_ID}/settings/general`

beforeEach(() => {
  vi.clearAllMocks()
  currentProject = makeProject()
  currentCanEdit = true
  currentReasonCannotEdit = null
})

describe("ProjectSettings — who can add and remove cells (AQU-1068)", () => {
  it("shows No one for a project that never set it — the default is refusal, not a rank", () => {
    renderSettings(PANE)
    // "No one" is not a role, so it has no FLOOR_LABEL entry and the trigger
    // falls back to the full row text — which is where the "default" note is.
    expect(screen.getByTestId("settings-cell-editing-floor")).toHaveTextContent("No one — default")
  })

  it("reads back a stored tier", () => {
    currentProject = makeProject({ cellEditingFloor: "project_lead" } as Partial<ProjectRecord>)
    renderSettings(PANE)
    expect(screen.getByTestId("settings-cell-editing-floor")).toHaveTextContent("Project lead")
  })

  it("reads back a tier below contributor — the rungs the static floor drop made real", () => {
    currentProject = makeProject({ cellEditingFloor: "commenter" } as Partial<ProjectRecord>)
    renderSettings(PANE)
    expect(screen.getByTestId("settings-cell-editing-floor")).toHaveTextContent("Commenter")
  })

  it("saves the chosen tier as cellEditingFloor, and touches nothing else", async () => {
    const user = userEvent.setup()
    renderSettings(PANE)

    await user.click(screen.getByTestId("settings-cell-editing-floor"))
    await user.click(await screen.findByRole("option", { name: "Maintainer (600)" }))
    await user.click(screen.getByRole("button", { name: /save changes/i }))

    expect(patchSpy).toHaveBeenCalledTimes(1)
    const sent = patchSpy.mock.calls[0][0] as Record<string, unknown>
    expect(sent.cellEditingFloor).toBe("maintainer")
    expect(Object.keys(sent)).toEqual(["cellEditingFloor"])
  })

  it("saves a below-contributor tier — the new rungs reach the wire, not just the list", async () => {
    const user = userEvent.setup()
    renderSettings(PANE)

    await user.click(screen.getByTestId("settings-cell-editing-floor"))
    await user.click(await screen.findByRole("option", { name: "Reviewer (300)" }))
    await user.click(screen.getByRole("button", { name: /save changes/i }))

    const sent = patchSpy.mock.calls[0][0] as Record<string, unknown>
    expect(sent.cellEditingFloor).toBe("reviewer")
  })

  it("offers the six tiers in order, reset default first then up the ladder", async () => {
    const user = userEvent.setup()
    renderSettings(PANE)
    await user.click(screen.getByTestId("settings-cell-editing-floor"))
    const labels = (await screen.findAllByRole("option")).map((o) => o.textContent)
    expect(labels).toEqual([
      "No one — default",
      "Commenter (200)",
      "Reviewer (300)",
      "Contributor (400)",
      "Project lead (500)",
      "Maintainer (600)",
    ])
  })

  it("shows the short role word in the closed trigger, the ladder line in the open row", async () => {
    // The two-tier labelling copied from RosterProgressSection: FLOOR_LABEL for
    // the trigger, the message key for the row. Collapse the two and the
    // trigger reads "Contributor (400)" in a 16rem box.
    const user = userEvent.setup()
    currentProject = makeProject({ cellEditingFloor: "contributor" } as Partial<ProjectRecord>)
    renderSettings(PANE)

    const trigger = screen.getByTestId("settings-cell-editing-floor")
    expect(trigger).toHaveTextContent("Contributor")
    expect(trigger.textContent).not.toContain("(400)")

    await user.click(trigger)
    expect(await screen.findByRole("option", { name: "Contributor (400)" })).toBeInTheDocument()
  })

  it("locks the control for a member below the settings floor", () => {
    currentProject = makeProject({ syncRole: { level: 400, source: "member" } } as Partial<ProjectRecord>)
    currentCanEdit = false
    currentReasonCannotEdit = "role"
    renderSettings(PANE)
    expect(screen.getByTestId("settings-cell-editing-floor")).toBeDisabled()
  })

  it("no longer offers the retired add-lines checkbox in the Timeline card", () => {
    // It moved out of the audio area entirely: the tier governs ordinary text
    // files now, so an audio-shaped heading was the wrong home for it.
    renderSettings(`/project/${PROJECT_ID}/settings/audio-media`)
    expect(screen.queryByTestId("settings-allow-line-creation")).toBeNull()
  })
})

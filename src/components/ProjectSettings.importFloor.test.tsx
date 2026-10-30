// AQU-2305: who can import a new source file into THIS project, in Project
// settings → Import. The organization sets the floor (AQU-2304) and a project
// may only make it stricter, so the row is the "Organization default (…) /
// Set for this project" pair beside the role select, and the row must never
// OFFER a role the server would refuse.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { screen } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { ProjectSettings } from "./ProjectSettings"
import type { ProjectRecord } from "@/lib/parsers/types"
import { renderWithTooltips } from "@/test-utils/tooltip"
import userEvent from "@testing-library/user-event"

const PROJECT_ID = "proj-import-floor"

function makeProject(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: PROJECT_ID,
    name: "Import Floor Test Project",
    files: [],
    sourceLanguage: "English",
    targetLanguage: "French",
    syncRole: { level: 700, source: "member" },
    ...overrides,
  } as unknown as ProjectRecord
}

const patchSpy = vi.fn().mockResolvedValue({ kind: "ok" })

let currentProject: ProjectRecord = makeProject()
let currentCanEdit = true
let currentReasonCannotEdit: "offline" | "role" | null = null
let currentBlob: Record<string, unknown> = {}
let currentImportFloor = { org: 500, project: null as number | null, effective: 500 }

vi.mock("./ProjectSettings/MembersSection", () => ({
  MembersSection: () => <div data-testid="members-table-stub" />,
}))

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
    settings: currentBlob,
    hasFetched: true,
    orgPolicy: {
      rosterViewMinRole: 600, memberProgressViewMinRole: 500, allowSelfAssignment: false,
      allowScopedLaneAssignment: false, assignmentMinRole: 500, autoPropagateRepetitions: true,
      exportMinRole: null, importMinRole: currentImportFloor.org,
    },
    visibilityFloors: {
      rosterViewMinRole: { org: 600, project: null, effective: 600 },
      memberProgressViewMinRole: { org: 500, project: null, effective: 500 },
    },
    // AQU-2305: the floor the server resolved for this project.
    importFloor: currentImportFloor,
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
  OrgBreadcrumb: ({ section, trail }: { section?: string; trail?: { label: string }[] }) => (
    <div data-testid="org-breadcrumb">
      {section}
      {(trail ?? []).map((t) => ` › ${t.label}`).join("")}
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

/** The Import card lives in the General group. */
function renderGeneral() {
  return renderWithTooltips(
    <MemoryRouter initialEntries={[`/project/${PROJECT_ID}/settings/general`]}>
      <Routes>
        <Route path="/project/:id/settings/:section" element={<ProjectSettings />} />
      </Routes>
    </MemoryRouter>,
  )
}


const source = () => screen.getByTestId("project-import-floor-source")
const roleSelect = () => screen.getByTestId("project-import-floor")

beforeEach(() => {
  vi.clearAllMocks()
  currentProject = makeProject()
  currentCanEdit = true
  currentReasonCannotEdit = null
  currentBlob = {}
  currentImportFloor = { org: 500, project: null, effective: 500 }
})

describe("Project settings → Import: who can import files (AQU-2305)", () => {
  it("shows the row following the organization, with the role select disabled at the org's value", () => {
    renderGeneral()
    expect(screen.getByText("Who can import files")).toBeInTheDocument()
    expect(source()).toHaveTextContent("Organization default (Project lead)")
    expect(roleSelect()).toHaveTextContent("Project lead")
    expect(roleSelect()).toBeDisabled()
  })

  it("names the organization's own choice in the option, so Maintainer reads as the default", () => {
    currentImportFloor = { org: 600, project: null, effective: 600 }
    renderGeneral()
    expect(source()).toHaveTextContent("Organization default (Maintainer)")
    expect(roleSelect()).toHaveTextContent("Maintainer")
  })

  it("opens the role select on \"Set for this project\" without writing anything", async () => {
    renderGeneral()
    await userEvent.click(source())
    await userEvent.click(await screen.findByRole("option", { name: "Set for this project" }))
    expect(roleSelect()).toBeEnabled()
    // Nothing has changed yet: the value in force is still the org's.
    expect(patchSpy).not.toHaveBeenCalled()
  })

  it("stores Maintainer for this project", async () => {
    renderGeneral()
    await userEvent.click(source())
    await userEvent.click(await screen.findByRole("option", { name: "Set for this project" }))
    await userEvent.click(roleSelect())
    await userEvent.click(await screen.findByRole("option", { name: "Maintainer" }))
    expect(patchSpy).toHaveBeenCalledExactlyOnceWith({ importMinRole: 600 })
  })

  it("disables every role below the organization's floor, with the reason on the option", async () => {
    // The org is at Maintainer, so the project cannot loosen it: the UI never
    // offers the choice the server refuses.
    currentImportFloor = { org: 600, project: null, effective: 600 }
    renderGeneral()
    await userEvent.click(source())
    await userEvent.click(await screen.findByRole("option", { name: "Set for this project" }))
    await userEvent.click(roleSelect())
    const lower = await screen.findByRole("option", { name: /^Project lead —/ })
    expect(lower).toHaveTextContent("a project can only be stricter")
    expect(lower).toHaveAttribute("aria-disabled", "true")
    expect(await screen.findByRole("option", { name: "Maintainer" })).not.toHaveAttribute("aria-disabled", "true")
  })

  it("clears the project's value on \"Organization default\"", async () => {
    currentBlob = { importMinRole: 600 }
    currentImportFloor = { org: 500, project: 600, effective: 600 }
    renderGeneral()
    expect(source()).toHaveTextContent("Set for this project")
    expect(roleSelect()).toHaveTextContent("Maintainer")
    await userEvent.click(source())
    await userEvent.click(await screen.findByRole("option", { name: "Organization default (Project lead)" }))
    expect(patchSpy).toHaveBeenCalledExactlyOnceWith({ importMinRole: undefined })
  })

  it("reads a stored value the organization has overtaken as following the organization", () => {
    // Inert: a 500 under an org now at 600 is not "this project set its own",
    // and the floor in force is the org's.
    currentBlob = { importMinRole: 500 }
    currentImportFloor = { org: 600, project: null, effective: 600 }
    renderGeneral()
    expect(source()).toHaveTextContent("Organization default (Maintainer)")
    expect(roleSelect()).toHaveTextContent("Maintainer")
  })

  it("is disabled for a project lead, who cannot write shared project settings", () => {
    currentProject = makeProject({ syncRole: { level: 500, source: "member" } } as Partial<ProjectRecord>)
    currentCanEdit = false
    currentReasonCannotEdit = "role"
    renderGeneral()
    expect(source()).toBeDisabled()
    expect(roleSelect()).toBeDisabled()
  })

  it("is absent on a local project, which has no organization and no server floor", () => {
    currentProject = makeProject({ syncRole: undefined } as Partial<ProjectRecord>)
    renderGeneral()
    expect(screen.queryByTestId("project-import-floor")).not.toBeInTheDocument()
  })
})

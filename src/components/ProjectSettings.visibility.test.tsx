// AQU-2263: who can see a project's member list and each member's progress is
// the organization's policy, and a project may only make it stricter. It is set
// on the dashboard's badges, and now in Project settings → Members as well.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { screen } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { ProjectSettings } from "./ProjectSettings"
import type { ProjectRecord } from "@/lib/parsers/types"
import { renderWithTooltips } from "@/test-utils/tooltip"
import userEvent from "@testing-library/user-event"

const PROJECT_ID = "proj-visibility"

function makeProject(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: PROJECT_ID,
    name: "Cell Editing Settings Test Project",
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
let currentFloors = {
  rosterViewMinRole: { org: 600, project: null as number | null, effective: 600 },
  memberProgressViewMinRole: { org: 500, project: null as number | null, effective: 500 },
}

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
      allowScopedLaneAssignment: false, assignmentMinRole: 500, autoPropagateRepetitions: true, exportMinRole: null,
    },
    visibilityFloors: currentFloors,
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
  usePostEditMetrics: () => ({
    metrics: null,
    isLoading: false,
    isError: false,
    revalidate: vi.fn(),
  }),
}))

function renderMembers() {
  return renderWithTooltips(
    <MemoryRouter initialEntries={[`/project/${PROJECT_ID}/settings/members`]}>
      <Routes>
        <Route path="/project/:id/settings/:section" element={<ProjectSettings />} />
      </Routes>
    </MemoryRouter>,
  )
}

const roster = () => screen.getByTestId("project-roster-visibility")
const progress = () => screen.getByTestId("project-progress-visibility")

beforeEach(() => {
  vi.clearAllMocks()
  currentProject = makeProject()
  currentCanEdit = true
  currentReasonCannotEdit = null
  currentBlob = {}
  currentFloors = {
    rosterViewMinRole: { org: 600, project: null, effective: 600 },
    memberProgressViewMinRole: { org: 500, project: null, effective: 500 },
  }
})

describe("Project settings → Members: who can see the member list and progress (AQU-2263)", () => {
  it("shows both, following the organization, under the member list", () => {
    renderMembers()
    expect(screen.getByTestId("members-table-stub")).toBeInTheDocument()
    expect(screen.getByText("Who can see the member list")).toBeInTheDocument()
    expect(roster()).toHaveTextContent("Organization default (Maintainers and owners)")
    expect(progress()).toHaveTextContent("Organization default (Project leads and up)")
  })

  it("offers only the organization's level and stricter ones", async () => {
    renderMembers()
    await userEvent.click(roster())
    const labels = (await screen.findAllByRole("option")).map((o) => o.textContent)
    expect(labels).toEqual(["Organization default (Maintainers and owners)", "Owners only"])
  })

  it("choosing a stricter level stores it for this project", async () => {
    renderMembers()
    await userEvent.click(progress())
    await userEvent.click(await screen.findByRole("option", { name: "Owners only" }))
    // The write says what the person saw, so someone else's newer change to
    // the same setting is kept (AQU-2262).
    expect(patchSpy).toHaveBeenCalledExactlyOnceWith(
      { memberProgressViewMinRole: 700 },
      { expect: [{ key: "memberProgressViewMinRole", value: undefined }] },
    )
  })

  it("choosing the organization's level removes the project's own value", async () => {
    currentBlob = { rosterViewMinRole: 700 }
    currentFloors.rosterViewMinRole = { org: 600, project: 700, effective: 700 }
    renderMembers()
    expect(roster()).toHaveTextContent("Owners only")
    await userEvent.click(roster())
    await userEvent.click(await screen.findByRole("option", { name: "Organization default (Maintainers and owners)" }))
    expect(patchSpy).toHaveBeenCalledExactlyOnceWith(
      { rosterViewMinRole: undefined },
      { expect: [{ key: "rosterViewMinRole", value: 700 }] },
    )
  })

  it("a maintainer cannot loosen an Owners-only value, and is told who can", async () => {
    currentProject = makeProject({ syncRole: { level: 600, source: "member" } } as Partial<ProjectRecord>)
    currentBlob = { memberProgressViewMinRole: 700 }
    currentFloors.memberProgressViewMinRole = { org: 500, project: 700, effective: 700 }
    renderMembers()
    expect(screen.getByTestId("project-progress-visibility-binds")).toHaveTextContent("Only Owners can make this less strict.")
    await userEvent.click(progress())
    const lead = await screen.findByRole("option", { name: "Organization default (Project leads and up)" })
    expect(lead).toHaveAttribute("aria-disabled", "true")
  })

  it("is locked below the project settings floor", () => {
    currentCanEdit = false
    currentReasonCannotEdit = "role"
    renderMembers()
    expect(roster()).toBeDisabled()
    expect(progress()).toBeDisabled()
  })
})

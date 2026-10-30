// AQU-2263: Project settings → AI says which key drafts and voices use right
// now, for the AI provider and for the Gemini voice key alike.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { screen } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { ProjectSettings } from "./ProjectSettings"
import type { ProjectRecord } from "@/lib/parsers/types"
import { renderWithTooltips } from "@/test-utils/tooltip"

const PROJECT_ID = "proj-key-in-use"

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
  return { ...actual, fetchModels: vi.fn().mockResolvedValue([]) }
})

vi.mock("@/lib/store/project-index", () => ({
  getProject: vi.fn().mockResolvedValue(null),
  updateProject: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("@/lib/progress/read-validation-count", () => ({
  readValidationCount: vi.fn(() => 1),
  readValidationCountAudio: vi.fn(() => 1),
}))

let userKeys: Record<string, string | undefined> = {}
let override: { endpoint: string; apiKey?: string } | null = null
vi.mock("@/lib/store/user-api-keys", () => ({
  setUserApiKey: vi.fn(),
  useUserApiKey: (purpose: string) => userKeys[purpose],
}))
vi.mock("@/lib/store/user-provider-override", () => ({
  useUserProviderOverride: () => override,
  getUserProviderOverride: () => override,
}))

vi.mock("@/lib/metrics/use-post-edit-metrics", () => ({
  usePostEditMetrics: () => ({
    metrics: null,
    isLoading: false,
    isError: false,
    revalidate: vi.fn(),
  }),
}))

function renderAi() {
  return renderWithTooltips(
    <MemoryRouter initialEntries={[`/project/${PROJECT_ID}/settings/ai`]}>
      <Routes>
        <Route path="/project/:id/settings/:section" element={<ProjectSettings />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  currentProject = makeProject()
  currentCanEdit = true
  currentReasonCannotEdit = null
  userKeys = {}
  override = null
})

describe("Project settings → AI: which key is in use (AQU-2263)", () => {
  it("drafts use Aquilla with no key, and there is no Gemini key yet", async () => {
    renderAi()
    expect(await screen.findByTestId("completion-key-in-use")).toHaveTextContent("Using Aquilla. No key needed.")
    expect(screen.getByTestId("gemini-key-in-use")).toHaveTextContent("No Gemini key yet.")
  })

  it("your Preferences override is what drafts use while the project has no provider of its own", async () => {
    override = { endpoint: "https://openrouter.ai/api/v1", apiKey: "sk-mine" }
    renderAi()
    expect(await screen.findByTestId("completion-key-in-use")).toHaveTextContent("Using your own key (Preferences).")
  })

  it("a project with its own provider and key uses this project's key", async () => {
    currentProject = makeProject({
      completionSettings: { provider: "custom", endpoint: "https://openrouter.ai/api/v1", apiKey: "sk-project" },
    } as Partial<ProjectRecord>)
    renderAi()
    expect(await screen.findByTestId("completion-key-in-use")).toHaveTextContent("Using this project's key (this device only).")
  })

  it("voices use your own Gemini key saved in this browser when the project has none", async () => {
    userKeys = { "gemini-tts": "AIza-mine" }
    renderAi()
    expect(await screen.findByTestId("gemini-key-in-use")).toHaveTextContent("Using your own key (saved in this browser).")
  })

  it("voices use this project's Gemini key first", async () => {
    userKeys = { "gemini-tts": "AIza-mine" }
    currentProject = makeProject({ ttsSettings: { provider: "gemini", apiKey: "AIza-project" } } as Partial<ProjectRecord>)
    renderAi()
    expect(await screen.findByTestId("gemini-key-in-use")).toHaveTextContent("Using this project's key (this device only).")
  })
})

// AQU-2263 (second pass): the project's assistant language is the team's
// fallback for the assistant's answers, and is named for it.
describe("Project settings → AI: the team's assistant language", () => {
  it("is called 'The assistant answers the team in' and says when it applies", async () => {
    renderAi()
    expect(await screen.findByLabelText("The assistant answers the team in")).toBeInTheDocument()
    expect(screen.getByText(/hasn't chosen their own in Preferences/)).toBeInTheDocument()
  })
})

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { ProjectSettings } from "./ProjectSettings"


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

import type { ProjectRecord, CompletionSettings } from "@/lib/parsers/types"

const PROJECT_ID = "proj-model-search"

// An OpenRouter-sized list: far too long to scroll through.
const { MODELS } = vi.hoisted(() => ({ MODELS: [
  "openai/gpt-4o", "openai/gpt-4o-mini", "openai/o3", "anthropic/claude-opus-5-5", "anthropic/claude-sonnet-5-5",
  "anthropic/claude-haiku-5-5", "google/gemini-2.5-pro", "google/gemini-2.5-flash", "meta-llama/llama-4-maverick",
  "meta-llama/llama-4-scout", "mistralai/mistral-large", "mistralai/mistral-small", "qwen/qwen3-235b",
  "deepseek/deepseek-v3", "deepseek/deepseek-r1", "x-ai/grok-4", "cohere/command-a", "nvidia/nemotron-70b",
] }))



function makeProject(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: PROJECT_ID,
    name: "AI Settings Test Project",
    files: [],
    sourceLanguage: "English",
    targetLanguage: "French",
    syncRole: { level: 700, source: "creator" },
    completionSettings: {
      provider: "custom",
      endpoint: "https://llm.test/v1",
      model: "openai/gpt-4o",
      maxTokens: 512,
      temperature: 0.3,
      systemPrompt: "Existing instructions",
      top_k: 15,
      contextSize: "medium",
      useOnlyValidatedExamples: false,
      main_chat_language: "",
      fewShotExampleFormat: "source-and-target",
    } satisfies CompletionSettings,
    ...overrides,
  } as unknown as ProjectRecord
}

vi.mock("@/hooks/useProject", () => ({
  useProject: () => ({
    project: makeProject(),
    loading: false,
    refresh: vi.fn(),
  }),
}))

const patchSharedMock = vi.fn().mockResolvedValue({ kind: "ok" })
vi.mock("@/hooks/useProjectSettings", () => ({
  useProjectSettings: () => ({
    canEdit: true,
    reasonCannotEdit: null,
    patch: patchSharedMock,
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

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "tok", username: "tester" }, loading: false }),
}))

vi.mock("@/hooks/useAccounts", () => ({
  useAccounts: () => ({ active: null, sessions: [], loading: false, add: vi.fn(), activate: vi.fn(), remove: vi.fn() }),
}))

// Intentionally NOT mocked: we want the real buildCompletionSettings so a
// regression in the merge logic itself fails this test.

vi.mock("@/lib/completion/completion-service", async (importOriginal) => {
  // Partial mock: other modules in the render tree (e.g. lib/ab/feedback.ts)
  // import constants like FRONTIER_CHAT_URL from this module — keep the real
  // exports and stub only the network-touching functions.
  const actual = await importOriginal<typeof import("@/lib/completion/completion-service")>()
  return {
    ...actual,
    fetchModels: vi.fn().mockResolvedValue(MODELS),
    resolveProvider: vi.fn(() => "custom"),
  }
})

vi.mock("@/lib/store/project-index", () => ({
  getProject: vi.fn(async () => makeProject()),
  updateProject: vi.fn(async (_p: ProjectRecord) => {}),
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


function renderSettings() {
  return render(
    <MemoryRouter initialEntries={[`/project/${PROJECT_ID}/settings/ai`]}>
      <Routes>
        <Route path="/project/:id/settings" element={<ProjectSettings />} />
        <Route path="/project/:id/settings/:section" element={<ProjectSettings />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  patchSharedMock.mockResolvedValue({ kind: "ok" })
})

// AQU-2290: the model list grows with the provider (OpenRouter lists hundreds),
// so it gets the same search box as every other list that grows with your
// data (AQU-2260).
describe("ProjectSettings — the AI model list can be searched (AQU-2290)", () => {
  it("narrows the model list as you type, and picking one sets the model", async () => {
    const user = userEvent.setup()
    renderSettings()
    const trigger = await screen.findByRole("combobox", { name: /^Model$/ }, { timeout: 4000 })
    expect(trigger).toHaveTextContent("openai/gpt-4o")
    await user.click(trigger)
    const search = await screen.findByRole("combobox", { name: "Search the list" })
    await user.type(search, "claude")
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(3))
    expect(screen.getByRole("option", { name: "anthropic/claude-sonnet-5-5" })).toBeInTheDocument()
    await user.click(screen.getByRole("option", { name: "anthropic/claude-sonnet-5-5" }))
    await waitFor(() => expect(trigger).toHaveTextContent("anthropic/claude-sonnet-5-5"))
  })
})

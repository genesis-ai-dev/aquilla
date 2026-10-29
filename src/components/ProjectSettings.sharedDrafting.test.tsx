// AQU-2259: the drafting settings in the "AI Instructions" card, the model
// choice and the Health penalty are the TEAM's settings. They used to be saved
// only into this browser's copy of the project (`updateProject`), while the
// page said changes apply to everyone. Save must send them to the server's
// shared settings; the AI key stays exactly where it was, on this device.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { ProjectSettings } from "./ProjectSettings"
import type { ProjectRecord, CompletionSettings } from "@/lib/parsers/types"
import type { ProjectWideSettings } from "@/lib/sync/project-settings"

vi.mock("@/components/org/OrgSidebar", () => ({
  OrgSidebar: () => <div data-testid="org-sidebar">sidebar</div>,
}))
vi.mock("@/components/org/OrgBreadcrumb", () => ({
  OrgBreadcrumb: () => <div data-testid="org-breadcrumb" />,
}))

const PROJECT_ID = "proj-shared-drafting"

const LOCAL_COMPLETION = {
  provider: "frontier",
  endpoint: "",
  apiKey: "sk-local-only",
  model: "",
  maxTokens: 16384,
  temperature: 0.3,
  systemPrompt: "Existing instructions",
  llmHealthPenalty: 0.1,
  top_k: 15,
  contextSize: "medium",
  useOnlyValidatedExamples: true,
  main_chat_language: "",
  fewShotExampleFormat: "source-and-target",
} satisfies CompletionSettings

let roleLevel = 700
function makeProject(): ProjectRecord {
  return {
    id: PROJECT_ID,
    name: "Shared drafting",
    files: [],
    sourceLanguage: "English",
    targetLanguage: "French",
    syncRole: { level: roleLevel, source: "creator" },
    completionSettings: LOCAL_COMPLETION,
  } as unknown as ProjectRecord
}

vi.mock("@/hooks/useProject", () => ({
  useProject: () => ({ project: makeProject(), loading: false, refresh: vi.fn() }),
}))

const patchSharedMock = vi.fn().mockResolvedValue({ kind: "ok" })
let sharedBlob: ProjectWideSettings = {}
let canEdit = true
vi.mock("@/hooks/useProjectSettings", () => ({
  useProjectSettings: () => ({
    canEdit,
    reasonCannotEdit: canEdit ? null : "role",
    patch: patchSharedMock,
    version: 3,
    updatedAt: null,
    updatedBy: null,
    conflict: false,
    dismissConflict: vi.fn(),
    settings: sharedBlob,
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
vi.mock("@/lib/completion/completion-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/completion/completion-service")>()
  return { ...actual, fetchModels: vi.fn().mockResolvedValue([]) }
})

const updateProjectMock = vi.fn(async (_p: ProjectRecord) => {})
vi.mock("@/lib/store/project-index", () => ({
  getProject: vi.fn(async () => makeProject()),
  updateProject: (p: ProjectRecord) => updateProjectMock(p),
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

function renderSettings() {
  return render(
    <MemoryRouter initialEntries={[`/project/${PROJECT_ID}/settings/ai`]}>
      <Routes>
        <Route path="/project/:id/settings/:section" element={<ProjectSettings />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  patchSharedMock.mockResolvedValue({ kind: "ok" })
  sharedBlob = {}
  canEdit = true
  roleLevel = 700
})

describe("ProjectSettings — the team's drafting settings (AQU-2259)", () => {
  it("sends the drafting settings to the server, never the AI key", async () => {
    renderSettings()
    fireEvent.change(screen.getByLabelText(/examples retrieved/i), { target: { value: "17" } })
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }))

    await waitFor(() => expect(patchSharedMock).toHaveBeenCalled())
    const sent = patchSharedMock.mock.calls[0][0] as ProjectWideSettings
    expect(sent.draftingSettings).toMatchObject({ top_k: 17, contextSize: "medium", temperature: 0.3 })
    expect(JSON.stringify(sent)).not.toContain("sk-local-only")
    // Nothing about drafting is written into this browser's copy any more.
    for (const call of updateProjectMock.mock.calls) {
      expect((call[0].completionSettings as CompletionSettings | undefined)?.top_k).not.toBe(17)
    }
  })

  it("shows the team's values, not this browser's", async () => {
    sharedBlob = { draftingSettings: { top_k: 6, model: "team/model", temperature: 0.55 } }
    renderSettings()
    await waitFor(() => expect(screen.getByLabelText(/examples retrieved/i)).toHaveValue(6))
  })

  it("keeps the project's AI key on this device", async () => {
    renderSettings()
    // Switch to the custom provider to reach the key field.
    fireEvent.click(screen.getByRole("radio", { name: /custom/i }))
    const keyInput = await waitFor(() => {
      const el = document.querySelector<HTMLInputElement>(".font-mono input[autocomplete=off]")
      if (!el) throw new Error("no key field yet")
      return el
    })
    fireEvent.change(keyInput, { target: { value: "sk-new-local" } })
    fireEvent.blur(keyInput)
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }))
    await waitFor(() => expect(updateProjectMock).toHaveBeenCalled())
    const local = updateProjectMock.mock.calls.at(-1)![0].completionSettings as CompletionSettings
    expect(local.apiKey).toBe("sk-new-local")
    const sent = patchSharedMock.mock.calls.map((c) => JSON.stringify(c[0])).join("\n")
    expect(sent).not.toContain("sk-new-local")
  })

  it("locks the drafting settings for someone who can't change project settings", async () => {
    canEdit = false
    roleLevel = 400
    renderSettings()
    expect(screen.getByLabelText(/examples retrieved/i)).toBeDisabled()
  })
})

// AQU-2259: "User → Username" was a person's own setting, so it moved to
// Preferences; its old place keeps a note pointing there until it expires.
describe("ProjectSettings — the username moved to Preferences (AQU-2259)", () => {
  it("leaves a note in the old place instead of the field", async () => {
    render(
      <MemoryRouter initialEntries={[`/project/${PROJECT_ID}/settings/general`]}>
        <Routes>
          <Route path="/project/:id/settings/:section" element={<ProjectSettings />} />
        </Routes>
      </MemoryRouter>,
    )
    expect(await screen.findByText(/This setting moved to Preferences → General/)).toBeInTheDocument()
    expect(screen.queryByPlaceholderText("local")).toBeNull()
    expect(screen.getByRole("link", { name: /go to it/i })).toHaveAttribute(
      "href",
      "/preferences?highlight=pref-author-name",
    )
  })
})

// AQU-2259: the drafting settings in the "AI Instructions" card, the model
// choice and the Health penalty are the TEAM's settings. They used to be saved
// only into this browser's copy of the project (`updateProject`), while the
// page said changes apply to everyone. A change must go to the server's shared
// settings; the AI key stays exactly where it was, on this device. AQU-2262:
// each change saves as it is made, one field of the drafting settings at a
// time, merged into the team's copy.

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
// A write shows on the page, as the real hook's overlay does (AQU-2262): the
// provider picked here has to be the one the page then shows.
vi.mock("@/hooks/useProjectSettings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/useProjectSettings")>()
  const { useLiveProjectSettings } = await import("@/test-utils/live-project-settings")
  return {
    ...actual,
    useProjectSettings: () =>
      useLiveProjectSettings(() => ({
        settings: sharedBlob,
        patch: patchSharedMock,
        canEdit,
        reasonCannotEdit: canEdit ? null : "role",
        version: 3,
      })),
  }
})

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
/** This browser's copy after each patch. */
const patchProjectMock = vi.fn(async (_id: string, fn: (p: ProjectRecord) => ProjectRecord) => fn(makeProject()))
vi.mock("@/lib/store/project-index", () => ({
  getProject: vi.fn(async () => makeProject()),
  updateProject: (p: ProjectRecord) => updateProjectMock(p),
  patchProject: (id: string, fn: (p: ProjectRecord) => ProjectRecord) => patchProjectMock(id, fn),
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
    const box = screen.getByLabelText(/examples retrieved/i)
    fireEvent.change(box, { target: { value: "17" } })
    fireEvent.blur(box)

    await waitFor(() => expect(patchSharedMock).toHaveBeenCalled())
    const sent = patchSharedMock.mock.calls[0][0] as ProjectWideSettings
    // Just that field, merged into the team's drafting settings.
    expect(sent).toEqual({ draftingSettings: { top_k: 17 } })
    expect(patchSharedMock.mock.calls[0][1]).toMatchObject({ mergeKeys: ["draftingSettings"] })
    expect(JSON.stringify(sent)).not.toContain("sk-local-only")
    // Nothing about drafting is written into this browser's copy any more.
    for (const call of updateProjectMock.mock.calls) {
      expect((call[0].completionSettings as CompletionSettings | undefined)?.top_k).not.toBe(17)
    }
    for (const result of patchProjectMock.mock.results) {
      expect(((await result.value) as ProjectRecord).completionSettings?.top_k).not.toBe(17)
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
    // The drafting key, not the voices' Gemini key further down.
    const keyInput = await screen.findByPlaceholderText(/Paste your API key|Leave blank for no auth/)
    fireEvent.change(keyInput, { target: { value: "sk-new-local" } })
    // Leaving the field saves it into this browser's copy (AQU-2262).
    fireEvent.blur(keyInput)
    const savedKeys = async () =>
      (await Promise.all(patchProjectMock.mock.results.map((r) => r.value as Promise<ProjectRecord>)))
        .map((p) => (p.completionSettings as CompletionSettings | undefined)?.apiKey)
    await waitFor(async () => expect(await savedKeys()).toContain("sk-new-local"))
    const sent = patchSharedMock.mock.calls.map((c) => JSON.stringify(c[0])).join("\n")
    expect(sent).not.toContain("sk-new-local")
  })

  // Oct 29 second pass: nothing has read the Health penalty since the old
  // health engine went, so the slider that set it is gone.
  it("has no Health penalty slider", () => {
    renderSettings()
    expect(screen.getByLabelText(/examples retrieved/i)).toBeInTheDocument()
    expect(screen.queryByText(/health penalty/i)).toBeNull()
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

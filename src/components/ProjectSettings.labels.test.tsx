// Oct 29 second pass: "Gemini TTS" (the voice card) and "Auto-sync" (Git
// sync) were typed straight into Project settings in English. Rendered
// through a marking translator: a label that skips t() comes out unmarked.
import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { translate } from "@/lib/i18n/translate"
import { ProjectSettings } from "./ProjectSettings"
import type { ProjectRecord, CompletionSettings } from "@/lib/parsers/types"
import type { ProjectWideSettings } from "@/lib/sync/project-settings"

vi.mock("@/lib/i18n/I18nProvider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/i18n/I18nProvider")>()
  const marked = (key: string, vars?: Record<string, unknown>) =>
    `⟦${translate(undefined, key as never, vars as never)}⟧`
  return { ...actual, useT: () => marked }
})

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
    origin: { kind: "git", cloneUrl: "https://example.org/team/bible.git", branch: "main" },
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
// The Source & sync pane lists linkable projects; keep that read on the machine.
vi.mock("@/lib/sync/cloud-projects", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sync/cloud-projects")>()),
  fetchAccessibleProjectsResult: vi.fn(async () => ({ ok: true as const, projects: [] })),
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


function renderPane(section: string) {
  return render(
    <MemoryRouter initialEntries={[`/project/${PROJECT_ID}/settings/${section}`]}>
      <Routes>
        <Route path="/project/:id/settings/:section" element={<ProjectSettings />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe("Project settings labels go through translation", () => {
  it("labels the Gemini voice row from the catalog", () => {
    renderPane("ai")
    expect(screen.getByText("⟦Gemini TTS⟧")).toBeInTheDocument()
    expect(screen.queryByText("Gemini TTS")).toBeNull()
  })

  it("labels Git auto-sync from the catalog", () => {
    renderPane("source-sync")
    expect(screen.getByText("⟦Auto-sync⟧")).toBeInTheDocument()
    expect(screen.getByRole("switch", { name: "⟦Auto-sync⟧" })).toBeInTheDocument()
  })
})

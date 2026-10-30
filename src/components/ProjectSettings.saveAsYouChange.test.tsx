// AQU-2262 (settings cleanup 4, option A): every setting saves the moment it
// changes, with a quiet "Saved" beside it, and the app's Undo takes the change
// back. There is no Save bar. Typing fields save when you leave them or pause,
// never on every keystroke. When someone else changed the same setting first,
// the setting says so and keeps their value.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { screen, waitFor, act } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import userEvent from "@testing-library/user-event"
import { ProjectSettings } from "./ProjectSettings"
import type { ProjectRecord } from "@/lib/parsers/types"
import { renderWithTooltips } from "@/test-utils/tooltip"
import { historyReady, historyView, resetHistoryForTests } from "@/lib/history/history"
import { clearHistoryStoreForTests } from "@/lib/history/history-store"
import { registerSettingsAccessor } from "@/lib/history/settings-access"

const PROJECT_ID = "proj-save-as-you-change"

function makeProject(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: PROJECT_ID,
    name: "Ruth",
    files: [],
    sourceLanguage: "English",
    targetLanguage: "French",
    syncRole: { level: 600, source: "member" },
    ...overrides,
  } as unknown as ProjectRecord
}

const patchSpy = vi.fn()
let currentProject: ProjectRecord = makeProject()
let currentSettings: Record<string, unknown> = {}

vi.mock("@/hooks/useProject", () => ({
  useProject: () => ({ project: currentProject, loading: false, refresh: vi.fn() }),
}))
vi.mock("@/hooks/useProjectSettings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/useProjectSettings")>()
  return {
    ...actual,
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
      hasFetched: true,
      isOnline: true,
      refresh: vi.fn(),
    }),
  }
})
vi.mock("@/hooks/useOrg", () => ({ useOrg: () => ({ org: null }) }))
vi.mock("@/components/org/OrgSidebar", () => ({ OrgSidebar: () => <div /> }))
vi.mock("@/components/org/OrgBreadcrumb", () => ({ OrgBreadcrumb: () => <div /> }))
vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "tok", username: "tester", email: "t@example.com" }, loading: false }),
}))
vi.mock("@/hooks/useAccounts", () => ({
  useAccounts: () => ({ active: null, sessions: [], loading: false, add: vi.fn(), activate: vi.fn(), remove: vi.fn() }),
}))
vi.mock("@/components/AccountSwitcher", () => ({ AccountSwitcher: () => <div /> }))
vi.mock("@/lib/completion/completion-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/completion/completion-service")>()
  return { ...actual, fetchModels: vi.fn().mockResolvedValue([]) }
})
const store = vi.hoisted(() => ({ record: null as Record<string, unknown> | null }))
// As the real store: no copy in this browser means patchProject does nothing.
vi.mock("@/lib/store/project-index", () => ({
  getProject: vi.fn(async () => store.record),
  updateProject: vi.fn(async (p: Record<string, unknown>) => {
    store.record = p
  }),
  patchProject: vi.fn(async (_id: string, fn: (p: Record<string, unknown>) => Record<string, unknown>) => {
    if (!store.record) return undefined
    store.record = fn(store.record)
    return store.record
  }),
}))
vi.mock("@/lib/store/user-api-keys", () => ({ setUserApiKey: vi.fn(), useUserApiKey: vi.fn(() => null) }))
vi.mock("@/lib/metrics/use-post-edit-metrics", () => ({
  usePostEditMetrics: () => ({ metrics: null, isLoading: false, isError: false, revalidate: vi.fn() }),
}))
const renameProject = vi.hoisted(() => vi.fn(async (_jwt: string, id: string, name: string) => ({ id, name })))
vi.mock("@/lib/sync/cloud-projects", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sync/cloud-projects")>()
  return { ...actual, renameProject }
})

function renderSettings(section: string) {
  return renderWithTooltips(
    <MemoryRouter initialEntries={[`/project/${PROJECT_ID}/settings/${section}`]}>
      <Routes>
        <Route path="/project/:id/settings/:section" element={<ProjectSettings />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(async () => {
  vi.clearAllMocks()
  resetHistoryForTests()
  await clearHistoryStoreForTests()
  currentProject = makeProject()
  currentSettings = {}
  store.record = { ...currentProject }
  patchSpy.mockImplementation(async (partial: Record<string, unknown>) => {
    currentSettings = { ...currentSettings, ...partial }
    return { kind: "ok" }
  })
})

describe("Project settings save as you change them", () => {
  it("has no Save bar: flipping a switch saves it at once and says Saved beside it", async () => {
    const user = userEvent.setup()
    renderSettings("general")
    expect(screen.queryByRole("button", { name: /save changes/i })).toBeNull()
    await user.click(screen.getByRole("switch", { name: "Smart quotes" }))
    expect(patchSpy).toHaveBeenCalledTimes(1)
    expect(patchSpy.mock.calls[0][0]).toEqual({ smartQuotes: true })
    expect(patchSpy.mock.calls[0][1]).toMatchObject({ expect: [{ key: "smartQuotes", value: undefined }] })
    expect(await screen.findByTestId("save-status-smartQuotes")).toHaveTextContent("Saved")
  })

  it("the change is one Undo step named for the setting, and Undo puts the old value back", async () => {
    const user = userEvent.setup()
    const leave = registerSettingsAccessor(PROJECT_ID, {
      read: () => currentSettings,
      write: async (p) => { await patchSpy(p) },
    })
    renderSettings("general")
    await historyReady()
    await user.click(screen.getByRole("switch", { name: "Smart quotes" }))
    await waitFor(() => expect(historyView().nextUndo?.labelKey).toBe("editor.history.stepChangeSetting"))
    expect(historyView().nextUndo?.labelParams).toMatchObject({ setting: "Smart quotes", settingKey: "projectSettings.info.smartQuotesLabel" })
    await user.click(screen.getByTestId("settings-undo"))
    await waitFor(() => expect(patchSpy).toHaveBeenLastCalledWith({ smartQuotes: null }))
    leave()
  })

  it("a typing field saves when you leave it, not on each keystroke, and only its own field", async () => {
    const user = userEvent.setup()
    renderSettings("ai")
    const field = screen.getByRole("textbox", { name: "The assistant answers the team in" })
    await user.type(field, "Français")
    expect(patchSpy).not.toHaveBeenCalled()
    await user.tab()
    await waitFor(() => expect(patchSpy).toHaveBeenCalledTimes(1))
    expect(patchSpy.mock.calls[0][0]).toEqual({ draftingSettings: { main_chat_language: "Français" } })
    expect(patchSpy.mock.calls[0][1]).toMatchObject({ mergeKeys: ["draftingSettings"] })
  })

  it("says plainly when someone else changed the same setting first", async () => {
    const user = userEvent.setup()
    patchSpy.mockResolvedValueOnce({
      kind: "conflict",
      latest: { version: 3, updatedAt: "now", updatedBy: { id: 9, username: "alex" }, settings: { smartQuotes: false } },
    })
    renderSettings("general")
    await user.click(screen.getByRole("switch", { name: "Smart quotes" }))
    expect(await screen.findByTestId("save-status-smartQuotes")).toHaveTextContent(
      "alex changed this first, so their change is kept.",
    )
    expect(historyView().canUndo).toBe(false)
  })

  it("a setting kept only on this device saves to this browser's copy, as an Undo step for this browser", async () => {
    const user = userEvent.setup()
    renderSettings("audio-media")
    await user.click(screen.getByRole("button", { name: /Eager/ }))
    await waitFor(() => expect(store.record?.audioMediaStrategy).toBe("eager"))
    expect(patchSpy).not.toHaveBeenCalled()
    await act(async () => { await historyReady() })
    expect(historyView().nextUndo?.labelParams).toMatchObject({ setting: "Audio loading" })
  })

  it("the project name saves when you leave the field, as one change", async () => {
    const user = userEvent.setup()
    renderSettings("general")
    const field = screen.getByRole("textbox", { name: "Project name" })
    await user.clear(field)
    await user.type(field, "Ruth (draft 2)")
    expect(store.record?.name).toBe("Ruth")
    await user.tab()
    await waitFor(() => expect(store.record?.name).toBe("Ruth (draft 2)"))
    // The server's name is the one every surface reads; one rename, not one per letter.
    expect(renameProject).toHaveBeenCalledTimes(1)
    expect(renameProject).toHaveBeenCalledWith("tok", PROJECT_ID, "Ruth (draft 2)")
    await waitFor(() => expect(historyView().nextUndo?.labelParams).toMatchObject({ setting: "Project name" }))
  })

  // A project opened straight at its settings in a browser that has never
  // opened it has no copy here yet; its settings still save (as the old Save
  // did, from the page's own copy of the project).
  it("saves the name and this device's settings in a browser with no copy of the project yet", async () => {
    store.record = null
    const user = userEvent.setup()
    const view = renderSettings("general")
    const field = screen.getByRole("textbox", { name: "Project name" })
    await user.clear(field)
    await user.type(field, "Ruth (draft 2)")
    await user.tab()
    expect(await screen.findByTestId("save-status-name")).toHaveTextContent("Saved")
    expect(renameProject).toHaveBeenCalledWith("tok", PROJECT_ID, "Ruth (draft 2)")
    expect((store.record as Record<string, unknown> | null)?.name).toBe("Ruth (draft 2)")
    view.unmount()

    store.record = null
    renderSettings("audio-media")
    await user.click(screen.getByRole("button", { name: /Eager/ }))
    await waitFor(() => expect(store.record?.audioMediaStrategy).toBe("eager"))
  })
})

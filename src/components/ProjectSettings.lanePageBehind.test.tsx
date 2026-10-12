// AQU-1816 — a lane added in Project Settings shows up behind the dialog
// without a reload.
//
// Project Settings is a route modal over the still-mounted overview or
// workspace, and each resolves the project's settings (lane rows included)
// through its own `useProjectSettings`. The lane-row endpoints write around the
// hook's `patch`, which is the only path that broadcast "the row moved" to the
// other instances in the tab — so the dialog's own list updated while the page
// behind kept its old lanes (and the overview, which only shows its Languages
// card past one active lane, showed nothing at all) until a reload. Every layer
// was green on its own; the bug lived in the composition. So this renders the
// real settings page next to a real settings consumer standing in for the page
// behind, with the server answering the settings read before and after the
// create.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { ProjectLaneView, ProjectSettingsResponse } from "@/lib/sync/project-settings"
import {
  useProjectSettings,
  PROJECT_SETTINGS_UPDATED_EVENT,
  type ProjectSettingsUpdatedDetail,
} from "@/hooks/useProjectSettings"
import { ProjectSettings } from "./ProjectSettings"

const PROJECT_ID = "proj-lane-page-behind"

const SOURCE: ProjectLaneView = {
  id: "ln-src", role: "source", language: "Greek", name: null, langCode: null,
  legacyTag: null, position: 0, archivedAt: null,
}
const FRENCH: ProjectLaneView = {
  id: "ln-fr", role: "target", language: "French", name: null, langCode: null,
  legacyTag: "French", position: 1, archivedAt: null,
}
const SPANISH: ProjectLaneView = {
  id: "ln-es", role: "target", language: "Spanish", name: null, langCode: null,
  legacyTag: "Spanish", position: 2, archivedAt: null,
}

/** What the server holds for the project's lanes. The create flips it; every
 *  settings GET answers from it, as the auth-worker would. */
let serverLanes: ProjectLaneView[] = [SOURCE, FRENCH]
const fetchProjectSettingsResult = vi.fn(async (): Promise<{ ok: true; value: ProjectSettingsResponse }> => ({
  ok: true,
  value: { version: 1, updatedAt: "x", updatedBy: null, settings: {}, lanes: serverLanes },
}))
const createProjectLane = vi.fn()

vi.mock("@/lib/sync/project-settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sync/project-settings")>()),
  fetchProjectSettingsResult: (...args: unknown[]) => fetchProjectSettingsResult(...(args as [])),
  createProjectLane: (...args: unknown[]) => createProjectLane(...args),
  patchProjectSettings: async () => ({ kind: "error", status: 0, message: "not under test" }),
}))

vi.mock("@/components/org/OrgSidebar", () => ({
  OrgSidebar: () => <div data-testid="org-sidebar">sidebar</div>,
}))
vi.mock("@/components/org/OrgBreadcrumb", () => ({
  OrgBreadcrumb: () => <div data-testid="org-breadcrumb" />,
}))

const project = {
  id: PROJECT_ID,
  name: "One lane so far",
  files: [],
  sourceLanguage: "",
  targetLanguage: "",
  syncRole: { level: 700, source: "creator" },
} as unknown as ProjectRecord

vi.mock("@/hooks/useProject", () => ({
  useProject: () => ({ project, loading: false, status: "ready", refresh: vi.fn() }),
}))
vi.mock("@/hooks/useOrg", () => ({ useOrg: () => ({ org: null }) }))
vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "tok", username: "lead" }, loading: false }),
}))
vi.mock("@/hooks/useAccounts", () => ({
  useAccounts: () => ({ active: null, sessions: [], loading: false, add: vi.fn(), activate: vi.fn(), remove: vi.fn() }),
}))
vi.mock("@/hooks/useCompletionSettings", () => ({
  buildCompletionSettings: vi.fn((existing: unknown, updates: unknown) => ({ ...Object(existing), ...Object(updates) })),
  DEFAULT_SYSTEM_PROMPT: "Translate accurately.",
}))
vi.mock("@/lib/completion/completion-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/completion/completion-service")>()),
  fetchModels: vi.fn().mockResolvedValue([]),
  resolveProvider: vi.fn(() => "frontier"),
}))
vi.mock("@/lib/store/project-index", () => ({
  getProject: vi.fn().mockResolvedValue(null),
  patchProject: vi.fn().mockResolvedValue(undefined),
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
  usePostEditMetrics: () => ({ metrics: null, isLoading: false, isError: false, revalidate: vi.fn() }),
}))
vi.mock("@/lib/posthog", () => ({ default: { capture: vi.fn(), captureException: vi.fn() } }))

/** Stands in for the overview / workspace behind the dialog: its own settings
 *  instance, listing the target lanes that instance currently holds. */
function PageBehind() {
  const { lanes } = useProjectSettings(PROJECT_ID, 700)
  return (
    <ul aria-label="Lanes on the page behind">
      {(lanes ?? []).filter((lane) => lane.role === "target").map((lane) => (
        <li key={lane.id}>{lane.language}</li>
      ))}
    </ul>
  )
}

function renderDialogOverPage() {
  render(
    <I18nProvider>
      <PageBehind />
      <MemoryRouter initialEntries={[`/project/${PROJECT_ID}/settings/general`]}>
        <Routes>
          <Route path="/project/:id/settings/:section" element={<ProjectSettings />} />
        </Routes>
      </MemoryRouter>
    </I18nProvider>,
  )
  return screen.getByRole("list", { name: "Lanes on the page behind" })
}

const originalFetch = global.fetch

beforeEach(() => {
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true })
  serverLanes = [SOURCE, FRENCH]
  fetchProjectSettingsResult.mockClear()
  createProjectLane.mockReset()
  // Nothing under test goes through fetch; anything that does is a stray.
  global.fetch = vi.fn(async () => new Response("not found", { status: 404 })) as unknown as typeof fetch
})

afterEach(() => {
  global.fetch = originalFetch
})

describe("ProjectSettings — a new lane reaches the page behind the dialog (AQU-1816)", () => {
  it("lists the lane on the page behind as soon as the create succeeds", async () => {
    // The server creates the row inside the call: once it answers, every
    // settings GET lists the new lane.
    createProjectLane.mockImplementation(async () => {
      serverLanes = [SOURCE, FRENCH, SPANISH]
      return { kind: "ok", lane: SPANISH }
    })
    const pageBehind = renderDialogOverPage()
    await waitFor(() => expect(within(pageBehind).getByText("French")).toBeTruthy())
    expect(within(pageBehind).queryByText("Spanish")).toBeNull()
    // Both instances have read the one-lane project.
    await waitFor(() => expect(screen.getByTestId("lane-language-ln-fr")).toBeTruthy())

    fireEvent.change(screen.getByTestId("add-target-lang-input"), { target: { value: "Spanish" } })
    fireEvent.click(screen.getByTestId("add-target-lang-btn"))

    await waitFor(() => expect(createProjectLane).toHaveBeenCalledTimes(1))
    expect(createProjectLane.mock.calls[0]?.[2]).toMatchObject({ language: "Spanish" })
    // No reload: the page behind converges on its own.
    expect(await within(pageBehind).findByText("Spanish")).toBeTruthy()
    // The dialog's own list has it too.
    expect(await screen.findByTestId("lane-language-ln-es")).toBeTruthy()
  })

  it("announces the write the way the overview's portfolio reload listens for it", async () => {
    createProjectLane.mockImplementation(async () => {
      serverLanes = [SOURCE, FRENCH, SPANISH]
      return { kind: "ok", lane: SPANISH }
    })
    const seen: ProjectSettingsUpdatedDetail[] = []
    const onUpdated = (event: Event) => {
      seen.push((event as CustomEvent<ProjectSettingsUpdatedDetail>).detail)
    }
    window.addEventListener(PROJECT_SETTINGS_UPDATED_EVENT, onUpdated)
    try {
      const pageBehind = renderDialogOverPage()
      await waitFor(() => expect(screen.getByTestId("lane-language-ln-fr")).toBeTruthy())
      expect(seen).toEqual([])

      fireEvent.change(screen.getByTestId("add-target-lang-input"), { target: { value: "Spanish" } })
      fireEvent.click(screen.getByTestId("add-target-lang-btn"))

      await within(pageBehind).findByText("Spanish")
      // ProjectOverview keys `loadRow` (the portfolio row behind its Languages
      // card) on this event's project id, origin or not.
      expect(seen.map((d) => d.projectId)).toEqual([PROJECT_ID])
    } finally {
      window.removeEventListener(PROJECT_SETTINGS_UPDATED_EVENT, onUpdated)
    }
  })

  it("leaves the page behind alone when the create is refused", async () => {
    createProjectLane.mockResolvedValue({ kind: "duplicate" })
    const pageBehind = renderDialogOverPage()
    await waitFor(() => expect(screen.getByTestId("lane-language-ln-fr")).toBeTruthy())
    const reads = fetchProjectSettingsResult.mock.calls.length

    fireEvent.change(screen.getByTestId("add-target-lang-input"), { target: { value: "French" } })
    fireEvent.click(screen.getByTestId("add-target-lang-btn"))

    await waitFor(() => expect(createProjectLane).toHaveBeenCalledTimes(1))
    expect(await screen.findByText(/already/i)).toBeTruthy()
    expect(within(pageBehind).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["French"])
    expect(fetchProjectSettingsResult.mock.calls.length).toBe(reads)
  })
})

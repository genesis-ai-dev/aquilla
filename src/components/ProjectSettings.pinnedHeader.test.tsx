// AQU-2030 — Project settings: the header and save controls stay pinned.
//
// Why these tests exist: the back link, pane title, and the save controls used
// to live inside the pane's scrolling flow, so on a long pane (General,
// Members) they scrolled away with the form. Someone editing a field near the
// bottom had to scroll back to the top to save, or to get back to the settings
// index. The fix lifts that block out of the scrolling stack into a pinned,
// opaque container.
//
// These lock the parts that can actually regress:
//   1. The save controls render inside the pinned container, not in the
//      scrolling content below it — the whole point of the ticket.
//   2. The modal's "‹ Project settings" back link is pinned with them.
//   3. The pinned container is sticky with an opaque background, and the form
//      content is a sibling *after* it, so the form scrolls underneath rather
//      than carrying the header along.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, cleanup } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { ProjectSettings, ProjectSettingsDialog } from "./ProjectSettings"

vi.mock("@/components/org/OrgSidebar", () => ({
  OrgSidebar: () => <div data-testid="org-sidebar">sidebar</div>,
}))
vi.mock("@/components/org/OrgBreadcrumb", () => ({
  OrgBreadcrumb: ({ section, trail }: { section: string; trail?: { label: string }[] }) => (
    <div data-testid="org-breadcrumb">
      {section}
      {(trail ?? []).map((t: { label: string }) => ` › ${t.label}`).join("")}
    </div>
  ),
}))

import type { ProjectRecord } from "@/lib/parsers/types"

const PROJECT_ID = "proj-pinned-header"

function makeProject(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: PROJECT_ID,
    name: "Pinned Header Test Project",
    files: [],
    sourceLanguage: "English",
    targetLanguage: "French",
    // Maintainer-and-above: the save controls only render for roles allowed to
    // edit shared settings.
    syncRole: { level: 700, source: "creator" },
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

vi.mock("@/hooks/useProjectSettings", () => ({
  useProjectSettings: () => ({
    canEdit: true,
    reasonCannotEdit: null,
    patch: vi.fn().mockResolvedValue({ kind: "ok" }),
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

vi.mock("@/hooks/useCompletionSettings", () => ({
  buildCompletionSettings: vi.fn((existing: unknown, updates: unknown) => ({ ...Object(existing), ...Object(updates) })),
  DEFAULT_SYSTEM_PROMPT: "Translate accurately.",
}))

vi.mock("@/lib/completion/completion-service", async (importOriginal) => {
  // Partial mock: modules in this render tree read real constants from here at
  // module-eval time — keep every real export and stub only the network calls.
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

// ─── Render helpers ──────────────────────────────────────────────────────────

function renderPage(section = "general") {
  return render(
    <MemoryRouter initialEntries={[`/project/${PROJECT_ID}/settings/${section}`]}>
      <Routes>
        <Route path="/project/:id/settings" element={<ProjectSettings />} />
        <Route path="/project/:id/settings/:section" element={<ProjectSettings />} />
      </Routes>
    </MemoryRouter>,
  )
}

function renderModal(section = "general") {
  const backgroundLocation = `/projects/${PROJECT_ID}`
  return render(
    <MemoryRouter
      initialEntries={[
        backgroundLocation,
        {
          pathname: `/project/${PROJECT_ID}/settings/${section}`,
          state: { backgroundLocation, projectSettingsModalDepth: 1 },
        },
      ]}
    >
      <Routes>
        <Route path="/projects/:id" element={<div data-testid="project-overview-background" />} />
        <Route path="/project/:id/settings" element={<ProjectSettingsDialog />} />
        <Route path="/project/:id/settings/:section" element={<ProjectSettingsDialog />} />
      </Routes>
    </MemoryRouter>,
  )
}

function pinnedHeader(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-slot="project-settings-pinned-header"]')
  if (!el) throw new Error("pinned header not rendered")
  return el
}

/** Dirty the General pane the way a person does: edit the project title. */
function editProjectTitle(value: string) {
  fireEvent.change(screen.getByLabelText("Project title"), { target: { value } })
}

beforeEach(() => {
  vi.clearAllMocks()
  cleanup()
})

describe("ProjectSettings — pinned header (AQU-2030)", () => {
  it("keeps the save controls in the pinned header, not in the scrolling form", () => {
    renderPage()
    editProjectTitle("Renamed project")

    const save = screen.getByRole("button", { name: /save changes/i })
    expect(pinnedHeader().contains(save)).toBe(true)

    // The save status reads from the same pinned block.
    expect(pinnedHeader()).toHaveTextContent("Unsaved changes")

    // …and the field that was edited is NOT inside it — it scrolls underneath.
    expect(pinnedHeader().contains(screen.getByLabelText("Project title"))).toBe(false)
  })

  it("pins the modal's back link alongside the title", () => {
    renderModal()
    const back = screen.getByRole("button", { name: /project settings/i })
    expect(pinnedHeader().contains(back)).toBe(true)
  })

  it("is a sticky, opaque block that the form content follows as a sibling", () => {
    renderPage()
    const header = pinnedHeader()

    // Sticky + an opaque background (not translucent): form content must never
    // show through the title, back link, or buttons.
    expect(header.className).toContain("sticky")
    expect(header.className).toContain("top-0")
    expect(header.className).toMatch(/\bbg-(background|popover)\b/)

    // The form stack is the next sibling, so it scrolls under the header
    // instead of carrying it along.
    const content = header.nextElementSibling as HTMLElement | null
    expect(content).toBeTruthy()
    expect(content!.contains(screen.getByLabelText("Project title"))).toBe(true)
  })

  it("renders the same pinned block in the modal as on the full-page route", () => {
    renderModal()
    editProjectTitle("Renamed from the modal")
    expect(pinnedHeader().contains(screen.getByRole("button", { name: /save changes/i }))).toBe(true)
  })
})

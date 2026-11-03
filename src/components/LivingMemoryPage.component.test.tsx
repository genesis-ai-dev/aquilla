/**
 * LivingMemoryPage component tests — settings-style index → detail IA.
 *
 * Pure CRUD helper tests live in LivingMemoryPage.test.ts.
 * These tests exercise the rendered component via mocked hooks, on both
 * routes (`/project/:id/memory` and `/project/:id/memory/:section`).
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { expectClickNote } from "@/test-utils/tooltip"
import { LivingMemoryPage } from "./LivingMemoryPage"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { LivingMemoryEntry } from "@/lib/parsers/types"
import type { LivingMemoryCell } from "@/hooks/useLivingMemory"
import { ROLE } from "@/lib/frontier/roles"
import { INSTRUCTIONS_SAVE_DEBOUNCE_MS } from "@/components/living-memory/instructions-merge"

// ── Mocks ──────────────────────────────────────────────────────────────────

// useProjectSettings — the role-gating hook
const mockPatch = vi.fn().mockResolvedValue({ kind: "ok" })
const mockProjectSettingsReturn = {
  settings: {},
  version: 1,
  updatedBy: null,
  updatedAt: null,
  hasFetched: true,
  isOnline: true,
  canEdit: true,
  reasonCannotEdit: null as null | "offline" | "role",
  conflict: false,
  dismissConflict: vi.fn(),
  refresh: vi.fn(),
  patch: mockPatch,
}
vi.mock("@/hooks/useProjectSettings", () => ({
  useProjectSettings: vi.fn(() => mockProjectSettingsReturn),
}))

// useProject — supplies the project record (including syncRole and entries)
const mockProjectBase: ProjectRecord = {
  id: "proj-1",
  name: "Test Project",
  livingMemoryEntries: [],
  syncRole: { level: ROLE.MAINTAINER, source: "override" },
} as unknown as ProjectRecord

vi.mock("@/hooks/useProject", () => ({
  useProject: vi.fn(() => ({
    project: mockProjectBase,
    loading: false,
    status: "ready",
    isError: false,
    isUnreachable: false,
    refresh: vi.fn(),
    patchSettings: mockPatch,
    settingsFetched: true,
  })),
}))

// useLivingMemory — validated cells
vi.mock("@/hooks/useLivingMemory", () => ({
  useLivingMemory: vi.fn(() => ({
    cells: [],
    isLoading: false,
    isEmpty: true,
    isTruncated: false,
    fileCount: 0,
  })),
}))

// useLiveness — liveness indicator
vi.mock("@/hooks/useLiveness", () => ({
  useLiveness: vi.fn(() => ({ state: "live", label: "Live" })),
}))

// useFrontierSession — session
vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: vi.fn(() => ({ session: { username: "alice", jwt: "tok" } })),
}))

vi.mock("@/lib/frontier/knowledge-base", () => ({
  listKnowledgeDocuments: vi.fn(async () => []),
  getKnowledgeDocument: vi.fn(),
  getKnowledgeDocumentContent: vi.fn(),
  getKnowledgeDocumentOriginal: vi.fn(),
  uploadKnowledgeDocument: vi.fn(),
  deleteKnowledgeDocument: vi.fn(),
  reindexKnowledgeDocument: vi.fn(),
}))

// The Checks list owns its own data wiring (org settings, project cells) —
// stub it; the checks pane only needs to mount it with the style binding.
vi.mock("@/components/ProjectSettings/RulesSection", () => ({
  RulesSettingsSection: ({ projectId, style }: { projectId: string; style?: { canManage: boolean } }) => (
    <div data-testid="rules-settings-section" data-project-id={projectId} data-has-style={style ? "yes" : "no"} />
  ),
}))

// Same for the style-rule store — it owns its own useStyleRules fetch; its
// behaviour is covered by living-memory/StyleChecks.test.tsx. The stub hands
// the list a binding, as the real one does.
vi.mock("@/components/living-memory/StyleChecks", () => ({
  StyleChecks: ({ children }: { children: (binding: unknown) => import("react").ReactNode }) =>
    children({ canManage: false, rules: [], applicability: [], reviewQueue: null, documentGenres: null, errorBanner: null }),
}))

import { useProject } from "@/hooks/useProject"
import { useProjectSettings } from "@/hooks/useProjectSettings"
import { useLivingMemory } from "@/hooks/useLivingMemory"

// ── Helpers ────────────────────────────────────────────────────────────────

function renderPage(
  path = "/project/proj-1/memory",
  props: React.ComponentProps<typeof LivingMemoryPage> = {},
) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/project/:id/memory" element={<LivingMemoryPage {...props} />} />
        <Route path="/project/:id/memory/:section" element={<LivingMemoryPage {...props} />} />
      </Routes>
    </MemoryRouter>,
  )
}

type UseProjectReturn = ReturnType<typeof useProject>
type UseProjectSettingsReturn = ReturnType<typeof useProjectSettings>

function mockProject(overrides: Partial<ProjectRecord> = {}, loading = false) {
  vi.mocked(useProject).mockReturnValue({
    project: loading ? null : ({ ...mockProjectBase, ...overrides } as ProjectRecord),
    loading,
    status: loading ? "loading" : "ready",
    isError: false,
    isUnreachable: false,
    refresh: vi.fn(),
    patchSettings: mockPatch,
    settingsFetched: true,
  } as unknown as UseProjectReturn)
}

function mockSettings(overrides: Partial<typeof mockProjectSettingsReturn> = {}) {
  vi.mocked(useProjectSettings).mockReturnValue({
    ...mockProjectSettingsReturn,
    ...overrides,
  } as unknown as UseProjectSettingsReturn)
}

function makeEntry(overrides: Partial<LivingMemoryEntry> = {}): LivingMemoryEntry {
  return {
    id: "e1",
    kind: "instruction",
    text: "Use formal register",
    createdAt: new Date().toISOString(),
    author: "alice",
    ...overrides,
  }
}

function makeCell(overrides: Partial<LivingMemoryCell> = {}): LivingMemoryCell {
  return {
    id: "c1",
    fileId: "f1",
    fileName: "Genesis",
    group: "GEN 1:1",
    original: "In the beginning",
    translated: "Mwanzoni",
    activeValidators: ["alice"],
    status: "validated",
    ...overrides,
  } as unknown as LivingMemoryCell
}

beforeEach(() => {
  vi.clearAllMocks()
  mockPatch.mockResolvedValue({ kind: "ok" })
  mockProject()
  mockSettings()
  vi.mocked(useLivingMemory).mockReturnValue({
    cells: [],
    isLoading: false,
    isEmpty: true,
    isTruncated: false,
    fileCount: 0,
  })
})

// ── Tests ──────────────────────────────────────────────────────────────────

describe("LivingMemoryPage — index", () => {
  // AQU-2342: the brief, the system prompt and the instruction entries were
  // four answers to one question. The index now has ONE row for it, and that
  // row says plainly that every AI draft reads it.
  it("points the Instructions row at the one text every AI draft reads", () => {
    renderPage()

    const row = screen.getByRole("link", { name: /Instructions/ })
    expect(row).toHaveTextContent(/Every AI draft reads this/)
    expect(row).toHaveAttribute("href", "/project/proj-1/memory/instructions")
    expect(screen.queryByRole("link", { name: /Brief/ })).not.toBeInTheDocument()
  })

  it("does not load the complete cell corpus before Examples is opened", () => {
    renderPage()

    expect(vi.mocked(useLivingMemory)).toHaveBeenLastCalledWith(expect.objectContaining({
      enabled: false,
      project: mockProjectBase,
    }))
  })

  it("renders from the workspace-owned project while the standalone query is unresolved", () => {
    mockProject({}, true)
    const workspaceProject = {
      ...mockProjectBase,
      name: "Workspace-owned project",
    } as ProjectRecord

    renderPage("/project/proj-1/memory", {
      project: workspaceProject,
      projectSettings: mockProjectSettingsReturn as unknown as UseProjectSettingsReturn,
    })

    expect(screen.getByRole("heading", { name: /Living Memory/i })).toBeInTheDocument()
    expect(vi.mocked(useProject)).toHaveBeenLastCalledWith("proj-1", expect.objectContaining({
      enabled: false,
      includeSettings: false,
    }))
    expect(vi.mocked(useProjectSettings)).toHaveBeenLastCalledWith(null, ROLE.MAINTAINER)
  })

  it("shows the Living Memory heading and the intro copy", () => {
    renderPage()
    expect(screen.getByRole("heading", { name: /Living Memory/i })).toBeInTheDocument()
    expect(screen.getByText(/Your team's encoded voice/i)).toBeInTheDocument()
  })

  it("lists Instructions, Terminology, Examples, Checks, then Source documents", () => {
    renderPage()
    const rows = screen.getAllByRole("link").filter((l) => /\/(memory|terminology)/.test(l.getAttribute("href") ?? ""))
    expect(rows).toHaveLength(5)
    expect(rows[0]).toHaveAccessibleName(/^Instructions/)
    expect(rows[1]).toHaveAccessibleName(/^Terminology/)
    expect(rows[2]).toHaveAccessibleName(/^Examples/)
    expect(rows[3]).toHaveAccessibleName(/^Checks/)
    expect(rows[4]).toHaveAccessibleName(/^Source documents/)
    // Terminology leaves for the terminology page, carrying the editor return.
    expect(rows[1].getAttribute("href")).toMatch(/^\/project\/proj-1\/terminology/)
    // Source documents never claim to reach drafting prompts.
    expect(rows[4]).toHaveTextContent(/not added to drafting prompts/)
  })

  it("says the instructions are not written yet, until they are", () => {
    const { unmount } = renderPage()
    expect(screen.getByRole("link", { name: /Instructions/ })).toHaveTextContent("Not written yet")
    unmount()

    mockSettings({ settings: { translationInstructions: "Plain register." } })
    renderPage()
    expect(screen.getByRole("link", { name: /Instructions/ })).not.toHaveTextContent("Not written yet")
  })

  it("shows no pane controls on the index (no textarea)", () => {
    renderPage()
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
  })

  it("falls back to the index for an unknown section", () => {
    renderPage("/project/proj-1/memory/nope")
    expect(screen.getByText(/Your team's encoded voice/i)).toBeInTheDocument()
    expect(screen.getByRole("link", { name: /^Checks/ })).toBeInTheDocument()
    // No pane content leaked through.
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
  })

  it("redirects the retired brief section to the instructions pane", () => {
    renderPage("/project/proj-1/memory/brief")
    expect(screen.getByRole("heading", { level: 2, name: "Instructions" })).toBeInTheDocument()
    expect(screen.getByRole("textbox", { name: "Instructions" })).toBeInTheDocument()
  })

  it("keeps the Terminology cross-link with its aria-label", () => {
    renderPage()
    expect(screen.getByRole("button", { name: /Go to Terminology page/i })).toBeInTheDocument()
  })
})

describe("LivingMemoryPage — instructions pane", () => {
  it("is one heading, one sentence, one text box and one secondary button", () => {
    renderPage("/project/proj-1/memory/instructions")
    expect(screen.getByRole("heading", { level: 2, name: "Instructions" })).toBeInTheDocument()
    expect(screen.getByText(/How the AI should translate this project\. Every AI draft reads this/)).toBeInTheDocument()
    expect(screen.getAllByRole("textbox")).toHaveLength(1)
    expect(screen.getByRole("button", { name: "Help me write this" })).toBeInTheDocument()
    // The retired surfaces are gone.
    expect(screen.queryByRole("button", { name: /System prompt/i })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /^Add/i })).not.toBeInTheDocument()
    expect(screen.queryByTestId("rules-settings-section")).not.toBeInTheDocument()
  })

  it("BackLink returns to the index", () => {
    renderPage("/project/proj-1/memory/instructions")
    const back = screen.getByRole("link", { name: /Living Memory/i })
    fireEvent.click(back)
    expect(screen.getByText(/Your team's encoded voice/i)).toBeInTheDocument()
    expect(screen.getByRole("link", { name: /^Checks/ })).toBeInTheDocument()
  })

  it("prefills the migrated text from the old sources when nothing is stored", () => {
    mockProject({ livingMemoryEntries: [makeEntry({ text: "Formal tone" })] })
    mockSettings({ settings: { systemPrompt: "Keep divine names as in the 1999 Bible." } })
    renderPage("/project/proj-1/memory/instructions")

    const field = screen.getByRole("textbox", { name: "Instructions" })
    expect(field).toHaveValue("Keep divine names as in the 1999 Bible.\n\nFormal tone")
    // Nothing is written back until someone edits it.
    expect(mockPatch).not.toHaveBeenCalled()
  })

  it("shows the stored instructions, ignoring the old sources", () => {
    mockProject({ livingMemoryEntries: [makeEntry({ text: "Formal tone" })] })
    mockSettings({ settings: { translationInstructions: "Plain register for youth." } })
    renderPage("/project/proj-1/memory/instructions")

    expect(screen.getByRole("textbox", { name: "Instructions" })).toHaveValue("Plain register for youth.")
  })

  it("auto-saves the edited text to translationInstructions", async () => {
    vi.useFakeTimers()
    try {
      renderPage("/project/proj-1/memory/instructions")
      fireEvent.change(screen.getByRole("textbox", { name: "Instructions" }), {
        target: { value: "Short sentences." },
      })
      expect(mockPatch).not.toHaveBeenCalled()
      await act(async () => {
        vi.advanceTimersByTime(INSTRUCTIONS_SAVE_DEBOUNCE_MS)
      })
      expect(mockPatch).toHaveBeenCalledTimes(1)
      expect(mockPatch).toHaveBeenCalledWith({ translationInstructions: "Short sentences." })
    } finally {
      vi.useRealTimers()
    }
  })

  it("saves at once when the field loses focus", async () => {
    renderPage("/project/proj-1/memory/instructions")
    const field = screen.getByRole("textbox", { name: "Instructions" })
    fireEvent.change(field, { target: { value: "Use informal you." } })
    fireEvent.blur(field)
    await waitFor(() =>
      expect(mockPatch).toHaveBeenCalledWith({ translationInstructions: "Use informal you." }),
    )
    expect(await screen.findByText("Saved")).toBeInTheDocument()
  })

  it("counts characters against the 8000-character limit", () => {
    mockSettings({ settings: { translationInstructions: "Plain." } })
    renderPage("/project/proj-1/memory/instructions")
    expect(screen.getByRole("textbox", { name: "Instructions" })).toHaveAttribute("maxLength", "8000")
    expect(screen.getByText("6 / 8,000 characters")).toBeInTheDocument()
  })

  it("opens the brief interview from 'Help me write this'", () => {
    renderPage("/project/proj-1/memory/instructions")
    fireEvent.click(screen.getByRole("button", { name: "Help me write this" }))
    expect(screen.getByRole("dialog", { name: "Help writing the instructions" })).toBeInTheDocument()
  })
})

describe("LivingMemoryPage — role-gated edit affordances", () => {
  it("shows the instructions read-only, with a note, below Maintainer", async () => {
    mockProject({
      syncRole: { level: ROLE.CONTRIBUTOR, source: "override" },
    } as unknown as Partial<ProjectRecord>)
    mockSettings({
      canEdit: false,
      reasonCannotEdit: "role",
      settings: { translationInstructions: "Plain register." },
    })
    renderPage("/project/proj-1/memory/instructions")

    const field = screen.getByRole("textbox", { name: "Instructions" })
    expect(field).toHaveAttribute("readonly")
    expect(field).toHaveValue("Plain register.")
    expect(screen.queryByRole("button", { name: "Help me write this" })).not.toBeInTheDocument()
    expect(screen.getByText("Editing requires the Maintainer role or above.")).toBeInTheDocument()
    fireEvent.change(field, { target: { value: "Changed" } })
    fireEvent.blur(field)
    expect(mockPatch).not.toHaveBeenCalled()
  })

  it("mounts the one Checks list, fed the style rules, on the checks pane", () => {
    renderPage("/project/proj-1/memory/checks")
    expect(screen.queryByRole("heading", { name: "Standards" })).not.toBeInTheDocument()
    expect(screen.getByTestId("rules-settings-section")).toHaveAttribute("data-has-style", "yes")
  })

  it("redirects the retired quality section to the checks pane", () => {
    renderPage("/project/proj-1/memory/quality")
    expect(screen.getByTestId("rules-settings-section")).toBeInTheDocument()
  })
})

describe("LivingMemoryPage — examples pane", () => {
  it("starts the validated-cell query only for the Examples pane", () => {
    renderPage("/project/proj-1/memory/examples")

    expect(vi.mocked(useLivingMemory)).toHaveBeenLastCalledWith(expect.objectContaining({
      enabled: true,
      project: mockProjectBase,
    }))
  })

  // AQU-2001: the page already knows the editor's lane (AQU-1509) and hands it
  // to the Rules pane. The Examples query has to get it too — read at the
  // default lane, a project translated into a named lane has no target rows to
  // aggregate, so the pane showed "no validated translations" no matter how
  // much the team had validated.
  it("reads validated examples in the lane the page is viewing", () => {
    renderPage("/project/proj-1/memory/examples", { activeLane: "de" })

    expect(vi.mocked(useLivingMemory)).toHaveBeenLastCalledWith(expect.objectContaining({
      enabled: true,
      lane: "de",
    }))
  })

  it("asks for the default lane when the page has no active lane", () => {
    renderPage("/project/proj-1/memory/examples")

    expect(vi.mocked(useLivingMemory)).toHaveBeenLastCalledWith(expect.objectContaining({
      lane: "",
    }))
  })

  // AQU-921: the pane is an inspection surface, so its body starts collapsed.
  it("collapses Recent Examples by default, leaving the disclosure control visible", () => {
    renderPage("/project/proj-1/memory/examples")

    expect(
      document.querySelector('section[aria-label="Recent examples"]'),
    ).toBeInTheDocument()

    const trigger = screen.getByRole("button", { name: /Recent examples/i })
    expect(trigger).toBeVisible()
    expect(trigger).toHaveAttribute("aria-expanded", "false")

    // The body — description and empty state — is not exposed until expanded.
    expect(screen.getByText(/No validated translations yet/i)).not.toBeVisible()
  })

  it("keeps the Recent Examples section and role=status empty state once expanded", () => {
    renderPage("/project/proj-1/memory/examples")
    fireEvent.click(screen.getByRole("button", { name: /Recent examples/i }))

    expect(
      screen.getByRole("button", { name: /Recent examples/i }),
    ).toHaveAttribute("aria-expanded", "true")
    expect(
      screen.getByRole("status", { name: /No validated translations/i }),
    ).toBeInTheDocument()
    expect(screen.getByText(/No validated translations yet/i)).toBeVisible()
  })

  it("renders validated cells grouped by file when populated and expanded", () => {
    vi.mocked(useLivingMemory).mockReturnValue({
      cells: [makeCell()],
      isLoading: false,
      isEmpty: false,
      isTruncated: false,
      fileCount: 1,
    })
    renderPage("/project/proj-1/memory/examples")

    // Collapsed first: the cell list is rendered but not exposed.
    expect(screen.getByText("In the beginning")).not.toBeVisible()

    fireEvent.click(screen.getByRole("button", { name: /Recent examples/i }))
    expect(screen.getByText("Genesis")).toBeVisible()
    expect(screen.getByText("In the beginning")).toBeVisible()
    expect(screen.getByText("Mwanzoni")).toBeVisible()
    expect(
      screen.queryByRole("status", { name: /No validated translations/i }),
    ).not.toBeInTheDocument()
  })

  it("keeps fetching validated cells while collapsed", () => {
    renderPage("/project/proj-1/memory/examples")

    // Collapsing is presentational only — the query still runs for the pane.
    expect(vi.mocked(useLivingMemory)).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: true }),
    )
    expect(
      screen.getByRole("button", { name: /Recent examples/i }),
    ).toHaveAttribute("aria-expanded", "false")
  })
})

describe("LivingMemoryPage — knowledge pane", () => {
  it("shows manage affordances for PROJECT_LEAD and above", async () => {
    renderPage("/project/proj-1/memory/knowledge")
    // Settles the mocked listKnowledgeDocuments fetch.
    await screen.findByText(/No knowledge documents yet/i)
    expect(
      screen.getByRole("button", { name: /Upload document/i }),
    ).toBeInTheDocument()
    // AQU-2342: knowledge documents never reach a drafting prompt — no switch claims they do.
    expect(screen.queryByRole("switch")).not.toBeInTheDocument()
  })

  it("shows a read-only surface below PROJECT_LEAD", async () => {
    mockProject({
      syncRole: { level: ROLE.CONTRIBUTOR, source: "override" },
    } as unknown as Partial<ProjectRecord>)
    mockSettings({ canEdit: false, reasonCannotEdit: "role" })
    renderPage("/project/proj-1/memory/knowledge")

    await screen.findByText("Read-only")
    expect(
      screen.queryByRole("button", { name: /Upload document/i }),
    ).not.toBeInTheDocument()
  })
})

// AQU-2260 (Sam, Oct 29): the coloured liveness dot is a mark, not a button,
// so what it means opens on click, never on hover.
describe("LivingMemoryPage — liveness dot", () => {
  it("says the memory's state on click", async () => {
    renderPage()
    await expectClickNote(screen.getByRole("button", { name: "Live" }), "Live")
  })
})

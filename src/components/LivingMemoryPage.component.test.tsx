/**
 * LivingMemoryPage component tests — settings-style index → detail IA.
 *
 * Pure CRUD helper tests live in LivingMemoryPage.test.ts.
 * These tests exercise the rendered component via mocked hooks, on both
 * routes (`/project/:id/memory` and `/project/:id/memory/:section`).
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { LivingMemoryPage } from "./LivingMemoryPage"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { LivingMemoryEntry } from "@/lib/parsers/types"
import type { LivingMemoryCell } from "@/hooks/useLivingMemory"
import { ROLE } from "@/lib/frontier/roles"
import { DEFAULT_SYSTEM_PROMPT } from "@/lib/completion/completion-service"

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

// The Rules surface owns its own data wiring (org settings, project cells) —
// stub it; the quality pane only needs to mount it.
vi.mock("@/components/ProjectSettings/RulesSection", () => ({
  RulesSettingsSection: ({ projectId }: { projectId: string }) => (
    <div data-testid="rules-settings-section" data-project-id={projectId} />
  ),
}))

import { useProject } from "@/hooks/useProject"
import { useProjectSettings } from "@/hooks/useProjectSettings"
import { useLivingMemory } from "@/hooks/useLivingMemory"

// ── Helpers ────────────────────────────────────────────────────────────────

function renderPage(path = "/project/proj-1/memory") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/project/:id/memory" element={<LivingMemoryPage />} />
        <Route path="/project/:id/memory/:section" element={<LivingMemoryPage />} />
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
  it("shows the Living Memory heading and the intro copy", () => {
    renderPage()
    expect(screen.getByRole("heading", { name: /Living Memory/i })).toBeInTheDocument()
    expect(screen.getByText(/Your team's encoded voice/i)).toBeInTheDocument()
  })

  it("lists the five section rows by accessible name", () => {
    renderPage()
    expect(screen.getByRole("link", { name: /Brief/ })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: /Instructions/ })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: /Translation quality/ })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: /Knowledge base/i })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: /Examples/ })).toBeInTheDocument()
  })

  it("shows no pane controls on the index (no Add buttons, no textarea)", () => {
    renderPage()
    expect(screen.queryAllByRole("button", { name: /^Add/i })).toHaveLength(0)
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
  })

  it("falls back to the index for an unknown section", () => {
    renderPage("/project/proj-1/memory/nope")
    expect(screen.getByText(/Your team's encoded voice/i)).toBeInTheDocument()
    expect(screen.getByRole("link", { name: /Translation quality/ })).toBeInTheDocument()
    // No pane content leaked through.
    expect(screen.queryByText(/No instructions yet\./i)).not.toBeInTheDocument()
  })

  it("keeps the Terminology cross-link with its aria-label", () => {
    renderPage()
    expect(screen.getByRole("button", { name: /Go to Terminology page/i })).toBeInTheDocument()
  })
})

describe("LivingMemoryPage — instructions pane", () => {
  it("deep link renders the instructions section but not standards or rules", () => {
    renderPage("/project/proj-1/memory/instructions")
    expect(screen.getByRole("heading", { level: 2, name: "Instructions" })).toBeInTheDocument()
    expect(screen.getByText(/No instructions yet\./i)).toBeInTheDocument()
    expect(screen.queryByRole("heading", { name: "Standards" })).not.toBeInTheDocument()
    expect(screen.queryByText(/No standards yet\./i)).not.toBeInTheDocument()
    expect(screen.queryByTestId("rules-settings-section")).not.toBeInTheDocument()
  })

  it("BackLink returns to the index", () => {
    renderPage("/project/proj-1/memory/instructions")
    const back = screen.getByRole("link", { name: /Living Memory/i })
    fireEvent.click(back)
    expect(screen.getByText(/Your team's encoded voice/i)).toBeInTheDocument()
    expect(screen.getByRole("link", { name: /Translation quality/ })).toBeInTheDocument()
  })

  it("shows entries with edit/delete controls when canEdit=true", () => {
    mockProject({ livingMemoryEntries: [makeEntry({ text: "Formal tone" })] })
    renderPage("/project/proj-1/memory/instructions")
    expect(screen.getByText("Formal tone")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Edit entry/i })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Delete entry/i })).toBeInTheDocument()
  })
})

describe("LivingMemoryPage — prediction prompt block", () => {
  it("is collapsed by default and expands via the aria-expanded trigger", () => {
    renderPage("/project/proj-1/memory/instructions")
    expect(
      screen.queryByRole("textbox", { name: "System prompt" }),
    ).not.toBeInTheDocument()

    const trigger = screen.getByRole("button", { name: /System prompt/i })
    expect(trigger).toHaveAttribute("aria-expanded", "false")

    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute("aria-expanded", "true")
    const textarea = screen.getByRole("textbox", { name: "System prompt" })
    expect(textarea).toHaveValue(DEFAULT_SYSTEM_PROMPT)
  })

  it("shows the Default badge for the default prompt and no reset button", () => {
    renderPage("/project/proj-1/memory/instructions")
    expect(screen.getByText("Default")).toBeInTheDocument()
    expect(screen.queryByText("Custom")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: /System prompt/i }))
    expect(
      screen.queryByRole("button", { name: /Reset to default/i }),
    ).not.toBeInTheDocument()
  })

  it("shows the Custom badge and reset button for a custom stored prompt", () => {
    mockSettings({ settings: { systemPrompt: "Translate like a pirate." } })
    renderPage("/project/proj-1/memory/instructions")
    expect(screen.getByText("Custom")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: /System prompt/i }))
    expect(screen.getByRole("textbox", { name: "System prompt" })).toHaveValue(
      "Translate like a pirate.",
    )
    expect(screen.getByRole("button", { name: /Reset to default/i })).toBeInTheDocument()
  })

  it("saves an edited prompt via patch", async () => {
    renderPage("/project/proj-1/memory/instructions")
    fireEvent.click(screen.getByRole("button", { name: /System prompt/i }))
    const textarea = screen.getByRole("textbox", { name: "System prompt" })
    const save = screen.getByRole("button", { name: "Save" })
    expect(save).toBeDisabled()

    fireEvent.change(textarea, { target: { value: "New prompt text" } })
    expect(save).toBeEnabled()
    fireEvent.click(save)
    await waitFor(() =>
      expect(mockPatch).toHaveBeenCalledWith({ systemPrompt: "New prompt text" }),
    )
  })
})

describe("LivingMemoryPage — role-gated edit affordances", () => {
  it("hides Add buttons and the prompt editor's save when canEdit=false", () => {
    mockProject({
      syncRole: { level: ROLE.CONTRIBUTOR, source: "override" },
    } as unknown as Partial<ProjectRecord>)
    mockSettings({ canEdit: false, reasonCannotEdit: "role" })
    renderPage("/project/proj-1/memory/instructions")

    expect(screen.queryAllByRole("button", { name: /^Add/i })).toHaveLength(0)

    fireEvent.click(screen.getByRole("button", { name: /System prompt/i }))
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument()
    expect(screen.getByRole("textbox", { name: "System prompt" })).toBeDisabled()
  })

  it("hides the Add button on the quality pane when canEdit=false", () => {
    mockProject({
      syncRole: { level: ROLE.REVIEWER, source: "override" },
    } as unknown as Partial<ProjectRecord>)
    mockSettings({ canEdit: false, reasonCannotEdit: "role" })
    renderPage("/project/proj-1/memory/quality")

    expect(screen.getByRole("heading", { name: "Standards" })).toBeInTheDocument()
    expect(screen.queryAllByRole("button", { name: /^Add/i })).toHaveLength(0)
  })

  it("shows standards Add button and mounts the Rules surface when canEdit=true", () => {
    renderPage("/project/proj-1/memory/quality")
    expect(screen.getByRole("heading", { name: "Standards" })).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: /Add standards entry/i }),
    ).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Rules" })).toBeInTheDocument()
    expect(screen.getByTestId("rules-settings-section")).toBeInTheDocument()
  })
})

describe("LivingMemoryPage — examples pane", () => {
  it("keeps the Recent Examples section and role=status empty state", () => {
    renderPage("/project/proj-1/memory/examples")
    expect(
      document.querySelector('section[aria-label="Recent Examples"]'),
    ).toBeInTheDocument()
    expect(
      screen.getByRole("status", { name: /No validated translations/i }),
    ).toBeInTheDocument()
    expect(screen.getByText(/No validated translations yet/i)).toBeInTheDocument()
  })

  it("renders validated cells grouped by file when populated", () => {
    vi.mocked(useLivingMemory).mockReturnValue({
      cells: [makeCell()],
      isLoading: false,
      isEmpty: false,
      isTruncated: false,
      fileCount: 1,
    })
    renderPage("/project/proj-1/memory/examples")
    expect(screen.getByText("Genesis")).toBeInTheDocument()
    expect(screen.getByText("In the beginning")).toBeInTheDocument()
    expect(screen.getByText("Mwanzoni")).toBeInTheDocument()
    expect(
      screen.queryByRole("status", { name: /No validated translations/i }),
    ).not.toBeInTheDocument()
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
    expect(
      screen.getByRole("switch", { name: /Use knowledge base in drafting/i }),
    ).toBeInTheDocument()
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

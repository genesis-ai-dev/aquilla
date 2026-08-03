/**
 * LivingMemoryPage component tests — role-gated affordances + empty states.
 *
 * Pure CRUD helper tests live in LivingMemoryPage.test.ts.
 * These tests exercise the rendered component via mocked hooks.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { LivingMemoryPage } from "./LivingMemoryPage"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { LivingMemoryEntry } from "@/lib/parsers/types"
import { ROLE } from "@/lib/frontier/roles"

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

import { useProject } from "@/hooks/useProject"
import { useProjectSettings } from "@/hooks/useProjectSettings"

// ── Helpers ────────────────────────────────────────────────────────────────

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/project/proj-1/memory"]}>
      <LivingMemoryPage />
    </MemoryRouter>,
  )
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

// ── Tests ──────────────────────────────────────────────────────────────────

describe("LivingMemoryPage — purpose copy", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(useProject).mockReturnValue({
      project: mockProjectBase,
      loading: false,
      status: "ready",
      isError: false,
      isUnreachable: false,
      roleLevel: null,
      pm: null,      refresh: vi.fn(),
      patchSettings: mockPatch,
    })
    vi.mocked(useProjectSettings).mockReturnValue({ ...mockProjectSettingsReturn })
  })

  it("shows the Living Memory heading", () => {
    renderPage()
    expect(screen.getByRole("heading", { name: /Living Memory/i })).toBeInTheDocument()
  })

  it("shows the cross-link to Terminology", () => {
    renderPage()
    // Toolbar button matches Rules/Glossary cross-link pattern
    expect(screen.getByRole("button", { name: /Go to Terminology page/i })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Terminology/i })).toBeInTheDocument()
  })
})

describe("LivingMemoryPage — empty states", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(useProject).mockReturnValue({
      project: { ...mockProjectBase, livingMemoryEntries: [] },
      loading: false,
      status: "ready",
      isError: false,
      isUnreachable: false,
      roleLevel: null,
      pm: null,      refresh: vi.fn(),
      patchSettings: mockPatch,
    })
    vi.mocked(useProjectSettings).mockReturnValue({
      ...mockProjectSettingsReturn,
      canEdit: true,
      reasonCannotEdit: null,
    })
  })

  it("Instructions empty state shows coaching copy and an example", () => {
    renderPage()
    // The empty state placeholder text
    expect(screen.getByText(/No instructions yet\./i)).toBeInTheDocument()
    // Example prefix is shown
    expect(screen.getAllByText(/Example:/i).length).toBeGreaterThan(0)
  })

  it("Standards empty state shows coaching copy", () => {
    renderPage()
    expect(screen.getByText(/No standards yet\./i)).toBeInTheDocument()
  })

  it("Recent Examples empty state explains why pairs appear here", () => {
    renderPage()
    expect(screen.getByText(/No validated translations yet/i)).toBeInTheDocument()
    // Should mention that AI draws on these
    expect(screen.getByText(/AI draws on these pairs/i)).toBeInTheDocument()
  })
})

describe("LivingMemoryPage — role-gated edit affordances", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("shows Add buttons when canEdit=true (Maintainer+)", () => {
    vi.mocked(useProject).mockReturnValue({
      project: { ...mockProjectBase, livingMemoryEntries: [] },
      loading: false,
      status: "ready",
      isError: false,
      isUnreachable: false,
      roleLevel: null,
      pm: null,      refresh: vi.fn(),
      patchSettings: mockPatch,
    })
    vi.mocked(useProjectSettings).mockReturnValue({
      ...mockProjectSettingsReturn,
      canEdit: true,
      reasonCannotEdit: null,
    })
    renderPage()
    const addButtons = screen.getAllByRole("button", { name: /^Add/i })
    // One Add button per section that can be edited (instructions + standards)
    expect(addButtons.length).toBeGreaterThanOrEqual(2)
  })

  it("hides Add buttons when canEdit=false (below Maintainer)", () => {
    vi.mocked(useProject).mockReturnValue({
      project: {
        ...mockProjectBase,
        livingMemoryEntries: [],
        syncRole: { level: ROLE.CONTRIBUTOR, name: "contributor", source: "override", fetchedAt: "" },
      },
      loading: false,
      status: "ready",
      isError: false,
      isUnreachable: false,
      roleLevel: null,
      pm: null,      refresh: vi.fn(),
      patchSettings: mockPatch,
    })
    vi.mocked(useProjectSettings).mockReturnValue({
      ...mockProjectSettingsReturn,
      canEdit: false,
      reasonCannotEdit: "role",
    })
    renderPage()
    // No Add buttons should appear for below-floor users
    expect(screen.queryAllByRole("button", { name: /^Add/i })).toHaveLength(0)
  })

  it("shows edit/delete controls for existing entries when canEdit=true", () => {
    const entries = [makeEntry({ id: "e1", kind: "instruction", text: "Formal tone" })]
    vi.mocked(useProject).mockReturnValue({
      project: { ...mockProjectBase, livingMemoryEntries: entries },
      loading: false,
      status: "ready",
      isError: false,
      isUnreachable: false,
      roleLevel: null,
      pm: null,      refresh: vi.fn(),
      patchSettings: mockPatch,
    })
    vi.mocked(useProjectSettings).mockReturnValue({
      ...mockProjectSettingsReturn,
      canEdit: true,
      reasonCannotEdit: null,
    })
    renderPage()
    expect(screen.getByText("Formal tone")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Edit entry/i })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Delete entry/i })).toBeInTheDocument()
  })

  it("hides edit/delete controls for existing entries when canEdit=false", () => {
    const entries = [makeEntry({ id: "e1", kind: "instruction", text: "Formal tone" })]
    vi.mocked(useProject).mockReturnValue({
      project: {
        ...mockProjectBase,
        livingMemoryEntries: entries,
        syncRole: { level: ROLE.REVIEWER, name: "reviewer", source: "override", fetchedAt: "" },
      },
      loading: false,
      status: "ready",
      isError: false,
      isUnreachable: false,
      roleLevel: null,
      pm: null,      refresh: vi.fn(),
      patchSettings: mockPatch,
    })
    vi.mocked(useProjectSettings).mockReturnValue({
      ...mockProjectSettingsReturn,
      canEdit: false,
      reasonCannotEdit: "role",
    })
    renderPage()
    expect(screen.getByText("Formal tone")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Edit entry/i })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Delete entry/i })).not.toBeInTheDocument()
  })

  it("does not show Add buttons while project is still loading", () => {
    vi.mocked(useProject).mockReturnValue({
      project: null,
      loading: true,
      status: "loading",
      isError: false,
      isUnreachable: false,
      roleLevel: null,
      pm: null,      refresh: vi.fn(),
      patchSettings: mockPatch,
    })
    vi.mocked(useProjectSettings).mockReturnValue({
      ...mockProjectSettingsReturn,
      canEdit: false,
      reasonCannotEdit: "role",
    })
    renderPage()
    expect(screen.queryAllByRole("button", { name: /^Add/i })).toHaveLength(0)
  })
})

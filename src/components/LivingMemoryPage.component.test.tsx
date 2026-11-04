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
import { expectClickNote } from "@/test-utils/tooltip"
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

// Same for the style-rule library section — it owns its own useStyleRules
// fetch; its behaviour is covered by living-memory/QualityStyleRules.test.tsx.
vi.mock("@/components/living-memory/QualityStyleRules", () => ({
  QualityStyleRules: ({ projectId }: { projectId: string }) => (
    <div data-testid="quality-style-rules" data-project-id={projectId} />
  ),
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
  // AQU-912: Mariette (Biblica GP, 2026-08-12) and Josseline (ETT, 2026-08-13)
  // each read the translation brief and the AI instructions as the same thing,
  // one day apart, and ETT writes no briefs at all. This index is where the two
  // sit side by side, so it is where the distinction has to be legible without
  // support: the brief row says it is OPTIONAL and describes the translation's
  // purpose; the instructions row says it governs how the AI drafts.
  it("distinguishes the optional brief from the AI instructions", () => {
    renderPage()

    expect(
      screen.getByText(/optional — who this translation is for and what it must achieve/i),
    ).toBeTruthy()
    expect(screen.getByText(/how the AI should behave when drafting/i)).toBeTruthy()
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
    expect(screen.getByTestId("quality-style-rules")).toBeInTheDocument()
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

// AQU-2260 (Sam, Oct 29): the coloured liveness dot is a mark, not a button,
// so what it means opens on click, never on hover.
describe("LivingMemoryPage — liveness dot", () => {
  it("says the memory's state on click", async () => {
    renderPage()
    await expectClickNote(screen.getByRole("button", { name: "Live" }), "Live")
  })
})

// ── Per-lane Living Memory (AQU-2348) ──────────────────────────────────────
//
// The page's half of the feature: criteria #1 (picker only on a multi-lane
// project), #2 (each section inherited until customized), #3 (a lane's edit
// does not reach the project or another lane) and #11 (role gating).
//
// The chrome's own states are covered in living-memory/LaneMemorySection.test.tsx
// and the patch rules in lib/living-memory/lane-sections.test.ts. What is only
// provable HERE is the wiring between them: that the page resolves the lane the
// picker is showing, and that a write made in a lane view is addressed to that
// lane's copy rather than to the project's value.

const LANE_FR = "11112222"
const LANE_ES = "33334444"

/** A real `TranslationBrief` — `BriefSection` reads `parameters`, so a loose
 *  stand-in would fail on the render rather than on the behaviour under test. */
function makeBrief(variety: string): import("@/lib/brief/types").TranslationBrief {
  return {
    version: 1,
    updatedAt: "2026-11-03T00:00:00.000Z",
    updatedBy: "alice",
    parameters: { purpose: variety },
    freeformNotes: "",
    l2Markdown: "",
    l1Summary: null,
    l1GeneratedAt: null,
    l1ModelId: null,
  }
}

/** A project with two target lanes, each with an id and a legacy tag. */
function twoLaneProject(): Partial<ProjectRecord> {
  return {
    targetLanguage: "French",
    targetLanes: ["", "es"],
    lanes: [
      { id: LANE_FR, role: "target", legacyTag: "", name: "French" },
      { id: LANE_ES, role: "target", legacyTag: "es", name: "Spanish" },
      { id: "source01", role: "source", legacyTag: "", name: "Greek" },
    ],
  } as unknown as Partial<ProjectRecord>
}

describe("LivingMemoryPage — lane picker", () => {
  it("shows no lane picker on a single-lane project", () => {
    // Criterion #1: the page is unchanged. A single-lane project never had a
    // lane to choose and must not grow a control that cannot do anything.
    renderPage()
    expect(screen.queryByTestId("living-memory-lane-scope")).not.toBeInTheDocument()
  })

  it("shows the picker once the project has two target lanes", () => {
    mockProject(twoLaneProject())
    renderPage()
    expect(screen.getByTestId("living-memory-lane-scope")).toBeInTheDocument()
  })

  it("does not count the SOURCE lane towards needing a picker", () => {
    // Every project has a source lane. Counting it would put a picker on every
    // single-lane project in the product.
    mockProject({
      targetLanguage: "French",
      targetLanes: [""],
      lanes: [
        { id: LANE_FR, role: "target", legacyTag: "", name: "French" },
        { id: "source01", role: "source", legacyTag: "", name: "Greek" },
      ],
    } as unknown as Partial<ProjectRecord>)
    renderPage()
    expect(screen.queryByTestId("living-memory-lane-scope")).not.toBeInTheDocument()
  })

  it("shows the picker on every pane, not only the index", () => {
    // Editing one lane's brief while believing you are in another is the one
    // mistake this feature makes possible, so the lane in force is never off-screen.
    mockProject(twoLaneProject())
    renderPage("/project/proj-1/memory/brief")
    expect(screen.getByTestId("living-memory-lane-scope")).toBeInTheDocument()
  })
})

describe("LivingMemoryPage — per-section inherit / customize", () => {
  it("reads as inherited on a lane that owns nothing", () => {
    // Criterion #2. The lane resolves the project's brief, which is NOT the
    // same as owning it.
    mockProject(twoLaneProject())
    mockSettings({ settings: { translationBrief: makeBrief("Formal") } as never })
    renderPage("/project/proj-1/memory/brief")

    const control = screen.getByTestId("lane-override-control")
    expect(control.dataset.laneState).toBe("inherited")
    expect(screen.getByRole("button", { name: "Customize for this language lane" })).toBeInTheDocument()
  })

  it("reads as customized, naming the lane, once that lane owns a copy", () => {
    mockProject(twoLaneProject())
    mockSettings({
      settings: {
        translationBrief: makeBrief("Formal"),
        translationBriefByLane: { [LANE_FR]: makeBrief("Colloquial") },
      } as never,
    })
    renderPage("/project/proj-1/memory/brief")

    expect(screen.getByTestId("lane-override-control").dataset.laneState).toBe("customized")
    expect(screen.getByText("Customized for French")).toBeInTheDocument()
  })

  it("customizing writes a COPY of the project's value into the lane's key", async () => {
    // Criterion #2's "copies the project value": a lane that starts owning the
    // brief starts from the project's answers, not from a blank form.
    mockProject(twoLaneProject())
    mockSettings({ settings: { translationBrief: makeBrief("Formal") } as never })
    renderPage("/project/proj-1/memory/brief")

    fireEvent.click(screen.getByRole("button", { name: "Customize for this language lane" }))

    await waitFor(() =>
      expect(mockPatch).toHaveBeenCalledWith({
        translationBriefByLane: { [LANE_FR]: makeBrief("Formal") },
      }),
    )
    // The project's own brief is not in the patch at all.
    expect(mockPatch.mock.calls[0]![0]).not.toHaveProperty("translationBrief")
  })

  it("reverting removes only this lane's copy and keeps the other lane's", async () => {
    // Criterion #3's second half.
    mockProject(twoLaneProject())
    mockSettings({
      settings: {
        translationBrief: makeBrief("Formal"),
        translationBriefByLane: {
          [LANE_FR]: makeBrief("Colloquial"),
          [LANE_ES]: makeBrief("Liturgical"),
        },
      } as never,
    })
    renderPage("/project/proj-1/memory/brief")

    fireEvent.click(screen.getByRole("button", { name: "Revert to project" }))
    const confirms = screen.getAllByRole("button", { name: "Revert to project" })
    fireEvent.click(confirms[confirms.length - 1]!)

    await waitFor(() =>
      expect(mockPatch).toHaveBeenCalledWith({
        translationBriefByLane: { [LANE_ES]: makeBrief("Liturgical") },
      }),
    )
  })

  it("offers no customize/revert control at all on a single-lane project", () => {
    mockSettings({ settings: { translationBrief: makeBrief("Formal") } as never })
    renderPage("/project/proj-1/memory/brief")
    expect(screen.queryByTestId("lane-override-control")).not.toBeInTheDocument()
  })

  it("locks the controls below MAINTAINER", () => {
    // Criterion #11: the state stays readable, the actions do not.
    mockProject({ ...twoLaneProject(), syncRole: { level: ROLE.CONTRIBUTOR, source: "override" } } as never)
    mockSettings({ canEdit: false, reasonCannotEdit: "role" })
    renderPage("/project/proj-1/memory/brief")

    expect(screen.getByTestId("lane-override-control")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Customize for this language lane" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Revert to project" })).not.toBeInTheDocument()
  })
})

describe("LivingMemoryPage — lane-owned entries", () => {
  it("shows the project's entries plus this lane's, and never another lane's", () => {
    // The UNION rule. A lane adds to the project's standards; it does not
    // replace them, and it must not see the neighbouring audience's.
    mockProject(twoLaneProject())
    mockSettings({
      settings: {
        livingMemoryEntries: [
          makeEntry({ id: "p1", text: "Project instruction" }),
          makeEntry({ id: "fr1", text: "French instruction", laneId: LANE_FR }),
          makeEntry({ id: "es1", text: "Spanish instruction", laneId: LANE_ES }),
        ],
      } as never,
    })
    renderPage("/project/proj-1/memory/instructions")

    expect(screen.getByText("Project instruction")).toBeInTheDocument()
    expect(screen.getByText("French instruction")).toBeInTheDocument()
    expect(screen.queryByText("Spanish instruction")).not.toBeInTheDocument()
  })

  it("explains the union rather than borrowing the inherit/revert vocabulary", () => {
    // There is no lane COPY of a list, so there is nothing to revert — the
    // override control must not appear over the entries.
    mockProject(twoLaneProject())
    renderPage("/project/proj-1/memory/instructions")
    expect(screen.getByTestId("lane-list-note")).toBeInTheDocument()
  })

  it("stamps the viewed lane on an entry added in a lane view, keeping every other entry", async () => {
    // The mutator writes the WHOLE list back, so starting from the lane-resolved
    // view instead of the stored list would delete the other lane's entries on
    // the first edit a maintainer made.
    mockProject(twoLaneProject())
    mockSettings({
      settings: {
        livingMemoryEntries: [makeEntry({ id: "es1", text: "Spanish instruction", laneId: LANE_ES })],
      } as never,
    })
    renderPage("/project/proj-1/memory/instructions")

    fireEvent.click(screen.getByRole("button", { name: /add instructions/i }))
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "French only note" } })
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }))

    await waitFor(() => expect(mockPatch).toHaveBeenCalled())
    const written = mockPatch.mock.calls.at(-1)![0].livingMemoryEntries as LivingMemoryEntry[]
    expect(written.find((e) => e.text === "French only note")?.laneId).toBe(LANE_FR)
    // The other lane's entry survived.
    expect(written.find((e) => e.id === "es1")?.laneId).toBe(LANE_ES)
  })
})

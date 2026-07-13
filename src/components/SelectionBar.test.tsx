/**
 * AQU-365 — Tests that SelectionBar (the multi-select "dynamic island")
 * doesn't appear at all for a viewer / any role below every action it offers
 * (translate = contributor 400, validate = reviewer 300). Mirrors the
 * CommentsDrawer AQU-427 role-gating test pattern.
 */
import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { SelectionBar } from "./SelectionBar"
import type { ProjectRecord } from "@/lib/parsers/types"
import { CellStore } from "@/hooks/useActiveCellStore"
import type { CellData } from "@/hooks/useCells"
import type { CellRow } from "@/lib/sync/cells-read-types"
import type { CellAuditStats } from "@/hooks/useCellsAuditStats"
import { ROLE } from "@/lib/frontier/roles"
import * as selectionModule from "@/lib/audio/selection"

function makeProject(roleLevel: number | null): ProjectRecord {
  const base: ProjectRecord = {
    id: "proj-1",
    name: "Test Project",
    sourceLanguage: "en",
    targetLanguage: "fr",
    createdAt: new Date().toISOString(),
    files: [],
    members: [],
  }
  if (roleLevel !== null) {
    return {
      ...base,
      syncRole: { level: roleLevel, name: "test", source: "server", fetchedAt: new Date().toISOString() },
    }
  }
  return base
}

function makeCell(over: Partial<CellData> = {}): CellData {
  return {
    id: "cell-1",
    fileId: "file-1",
    original: "Hello",
    translated: "",
    context: "GEN 1:1",
    group: "g1",
    type: "text",
    status: "unvalidated",
    validationStatus: "none",
    activeValidators: [],
    validationHistory: [],
    history: [],
    threads: [],
    ...over,
  }
}

const CELLS = [makeCell({ id: "cell-1" }), makeCell({ id: "cell-2" })]

function makeRows(cells: CellData[]): CellRow[] {
  return cells.flatMap((cell, index) => {
    const canonicalRef = cell.context || cell.group || null
    const anchorCellId = index > 0 ? cells[index - 1].id : null
    return [
      {
        cellId: cell.id,
        side: "source",
        value: cell.original,
        valueHtml: cell.originalHtml ?? null,
        type: cell.type,
        canonicalRef,
        anchorCellId,
        eventId: `${cell.id}-source`,
        sourceEventId: null,
        lastEditor: null,
        lastEditAt: 1,
        validated: false,
        wordCount: cell.original.trim().split(/\s+/).filter(Boolean).length,
      },
      {
        cellId: cell.id,
        side: "target",
        value: cell.translated,
        valueHtml: cell.translatedHtml ?? null,
        type: cell.type,
        canonicalRef,
        anchorCellId,
        eventId: `${cell.id}-target`,
        sourceEventId: `${cell.id}-source`,
        lastEditor: "alice",
        lastEditAt: 2,
        validated: false,
        aiDrafted: cell.aiDrafted ?? false,
        wordCount: cell.translated.trim().split(/\s+/).filter(Boolean).length,
      },
    ]
  })
}

// activeValidators reach the store through the auditStats map, keyed by cellId
// (see CellStore.getCellView). Mirror each cell's activeValidators there so a
// makeCell({ activeValidators: [...] }) override actually surfaces on the
// rendered CellData.
function makeAuditStats(cells: CellData[]): Map<string, CellAuditStats> {
  const stats = new Map<string, CellAuditStats>()
  for (const cell of cells) {
    if (cell.activeValidators.length === 0) continue
    stats.set(cell.id, {
      cellId: cell.id,
      editCount: 1,
      contentHash: "",
      lastEditAt: 2,
      lastEditEventId: `${cell.id}-target`,
      activeValidators: cell.activeValidators,
      waivers: [],
    })
  }
  return stats
}

function makeStore(cells: CellData[]): CellStore {
  const store = new CellStore()
  store.setRuntime({
    projectId: "proj-1",
    fileId: "file-1",
    username: "alice",
    requiredValidations: 1,
    auditStats: makeAuditStats(cells),
  })
  store.replaceRows(makeRows(cells), { full: true, maxServerSeq: 1 })
  return store
}

function renderBar(project: ProjectRecord, cells: CellData[] = CELLS) {
  return render(
    <SelectionBar
      project={project}
      cellStore={makeStore(cells)}
      session={null}
      username="alice"
      completeBatch={vi.fn()}
    />,
  )
}

describe("SelectionBar — viewer suppression (AQU-365)", () => {
  it("renders nothing for VIEWER (100), even with a live selection", () => {
    vi.spyOn(selectionModule, "useSelectedIds").mockReturnValue(new Set(["cell-1", "cell-2"]))
    const { container } = renderBar(makeProject(ROLE.VIEWER))
    expect(container.firstChild).toBeNull()
    vi.restoreAllMocks()
  })

  it("renders nothing for a low unknown role (50)", () => {
    vi.spyOn(selectionModule, "useSelectedIds").mockReturnValue(new Set(["cell-1"]))
    const { container } = renderBar(makeProject(50))
    expect(container.firstChild).toBeNull()
    vi.restoreAllMocks()
  })

  it("renders the toolbar for REVIEWER (300) with a selection (can validate, not translate)", () => {
    vi.spyOn(selectionModule, "useSelectedIds").mockReturnValue(new Set(["cell-1", "cell-2"]))
    renderBar(makeProject(ROLE.REVIEWER))
    expect(screen.getByRole("toolbar", { name: "Selection actions" })).toBeInTheDocument()
    vi.restoreAllMocks()
  })

  it("renders the toolbar for CONTRIBUTOR (400) with a selection", () => {
    vi.spyOn(selectionModule, "useSelectedIds").mockReturnValue(new Set(["cell-1", "cell-2"]))
    renderBar(makeProject(ROLE.CONTRIBUTOR))
    expect(screen.getByRole("toolbar", { name: "Selection actions" })).toBeInTheDocument()
    vi.restoreAllMocks()
  })

  it("fails open (renders) for a local project with no syncRole", () => {
    vi.spyOn(selectionModule, "useSelectedIds").mockReturnValue(new Set(["cell-1", "cell-2"]))
    renderBar(makeProject(null))
    expect(screen.getByRole("toolbar", { name: "Selection actions" })).toBeInTheDocument()
    vi.restoreAllMocks()
  })

  it("renders nothing when there is no selection, regardless of role", () => {
    vi.spyOn(selectionModule, "useSelectedIds").mockReturnValue(new Set())
    const { container } = renderBar(makeProject(ROLE.CONTRIBUTOR))
    expect(container.firstChild).toBeNull()
    vi.restoreAllMocks()
  })
})

/**
 * Bulk Validate button state + disabled tooltip. The button is enabled only for
 * cells that are eligible AND not already validated by me; when nothing is
 * validatable the tooltip must name the *actual* reason (already validated /
 * untouched AI draft / no translation) rather than always blaming AI drafts.
 */
describe("SelectionBar — bulk Validate eligibility messaging", () => {
  function validateButton() {
    return screen.getByRole("button", { name: /Validate/i })
  }

  it("enables Validate for a translated, human-touched, not-yet-validated cell", () => {
    vi.spyOn(selectionModule, "useSelectedIds").mockReturnValue(new Set(["cell-1"]))
    renderBar(makeProject(ROLE.CONTRIBUTOR), [makeCell({ id: "cell-1", translated: "bonjour" })])
    const btn = validateButton()
    expect(btn).toBeEnabled()
    expect(btn).toHaveAttribute("title", "Validate 1 cell")
    vi.restoreAllMocks()
  })

  it("disables with an 'already validated by you' reason when all selected are self-validated", () => {
    vi.spyOn(selectionModule, "useSelectedIds").mockReturnValue(new Set(["cell-1"]))
    renderBar(makeProject(ROLE.CONTRIBUTOR), [
      makeCell({ id: "cell-1", translated: "bonjour", activeValidators: ["alice"] }),
    ])
    const btn = validateButton()
    expect(btn).toBeDisabled()
    expect(btn).toHaveAttribute("title", "All selected cells are already validated by you")
    vi.restoreAllMocks()
  })

  it("disables with the AI-draft reason for an untouched machine draft", () => {
    vi.spyOn(selectionModule, "useSelectedIds").mockReturnValue(new Set(["cell-1"]))
    renderBar(makeProject(ROLE.CONTRIBUTOR), [
      makeCell({ id: "cell-1", translated: "auto draft", aiDrafted: true }),
    ])
    const btn = validateButton()
    expect(btn).toBeDisabled()
    expect(btn).toHaveAttribute("title", "Nothing eligible — untouched AI drafts require individual review")
    vi.restoreAllMocks()
  })

  it("disables with a 'need a translation' reason for an untranslated cell", () => {
    vi.spyOn(selectionModule, "useSelectedIds").mockReturnValue(new Set(["cell-1"]))
    renderBar(makeProject(ROLE.CONTRIBUTOR), [makeCell({ id: "cell-1", translated: "" })])
    const btn = validateButton()
    expect(btn).toBeDisabled()
    expect(btn).toHaveAttribute("title", "Selected cells need a translation first")
    vi.restoreAllMocks()
  })
})

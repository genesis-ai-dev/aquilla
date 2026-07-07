/**
 * FRO-365 — Tests that SelectionBar (the multi-select "dynamic island")
 * doesn't appear at all for a viewer / any role below every action it offers
 * (translate = contributor 400, validate = reviewer 300). Mirrors the
 * CommentsDrawer FRO-427 role-gating test pattern.
 */
import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { SelectionBar } from "./SelectionBar"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { CellData } from "@/hooks/useCells"
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

function renderBar(project: ProjectRecord) {
  return render(
    <SelectionBar
      project={project}
      cells={CELLS}
      session={null}
      username="alice"
      completeBatch={vi.fn()}
    />,
  )
}

describe("SelectionBar — viewer suppression (FRO-365)", () => {
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

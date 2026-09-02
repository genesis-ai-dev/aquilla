/**
 * AQU-888 — the source cell's add-row "+" (section headings).
 *
 * Biblica ETT writes section headers by adding a row between two verses. The
 * design settled on the 2026-08-12 call: while a source cell is in edit mode,
 * the row grows a "+" at each boundary; pressing one creates the row and the
 * new row opens ready to type.
 *
 * These pin the EDITOR half — when the handles exist, which cell/direction they
 * report, and that a row holding the one-shot edit claim opens its source
 * editor by itself. The event half (create + reorder + paired target commit)
 * is the workspace's, and the anchor-chain rules it depends on are pinned in
 * events-emit.test / useActiveCellStore.timing.test.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { EditorTable } from "./EditorTable"
import { EditorActionsProvider, type EditorActionsContextValue } from "@/context/EditorActionsContext"
import { CellStore } from "@/hooks/useActiveCellStore"
import type { CellData } from "@/hooks/useCells"
import type { CellRow } from "@/lib/sync/cells-read-types"
import type { ProjectRecord } from "@/lib/parsers/types"
import { ROLE } from "@/lib/frontier/roles"
import { requestSourceEdit, clearSourceEditRequest } from "@/lib/editor/pending-source-edit"

vi.mock("@/hooks/useDcsUpstreamCursor", () => ({
  useDcsUpstreamCursor: () => ({ cursor: null, loading: false }),
}))

// happy-dom has no layout engine — render every row (same shim the sibling
// EditorTable suites use).
vi.mock("@legendapp/list/react", async () => {
  const React = await import("react")
  return {
    LegendList: React.forwardRef(function MockLegendList({
      data,
      renderItem,
      keyExtractor,
    }: {
      data: CellData[]
      renderItem: (props: { item: CellData; index: number }) => ReactNode
      keyExtractor?: (item: CellData, index: number) => string
    }, ref) {
      React.useImperativeHandle(ref, () => ({
        getState: () => ({ scroll: 0, positionAtIndex: (i: number) => i * 140, sizeAtIndex: () => 140 }),
        scrollToIndex: async () => undefined,
        scrollToOffset: async () => undefined,
      }))
      return React.createElement(
        "div",
        null,
        data.map((item, index) =>
          React.createElement(
            React.Fragment,
            { key: keyExtractor?.(item, index) ?? item.id },
            renderItem({ item, index }),
          ),
        ),
      )
    }),
  }
})

function withRole(level: number, overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: "proj-1",
    name: "Test Project",
    sourceLanguage: "en",
    targetLanguage: "fr",
    createdAt: "2026-01-01T00:00:00Z",
    files: [],
    members: [],
    syncRole: { level, name: "test", source: "server", fetchedAt: "2026-01-01T00:00:00Z" },
    ...overrides,
  }
}

function makeCell(id: string, translated: string): CellData {
  return {
    id,
    fileId: "file-1",
    original: "hello",
    translated,
    context: "GEN 1:1",
    group: "GEN 1",
    type: "text",
    status: "unvalidated",
    validationStatus: "none",
    activeValidators: [],
    validationHistory: [],
    history: [],
    threads: [],
  }
}

function makeRows(cells: CellData[]): CellRow[] {
  return cells.flatMap((cell, index) => {
    const anchorCellId = index > 0 ? cells[index - 1].id : null
    const base = {
      cellId: cell.id,
      type: cell.type,
      canonicalRef: cell.context,
      anchorCellId,
      lastEditAt: 1,
      validated: false,
    }
    return [
      {
        ...base,
        side: "source" as const,
        value: cell.original,
        valueHtml: null,
        eventId: `${cell.id}-source`,
        sourceEventId: null,
        lastEditor: null,
        wordCount: 1,
      },
      {
        ...base,
        side: "target" as const,
        value: cell.translated,
        valueHtml: null,
        eventId: `${cell.id}-target`,
        sourceEventId: `${cell.id}-source`,
        lastEditor: "lead",
        wordCount: 1,
      },
    ]
  })
}

function renderTable(project: ProjectRecord, actions: EditorActionsContextValue, cells: CellData[]) {
  const store = new CellStore()
  store.setRuntime({
    projectId: project.id,
    fileId: "file-1",
    username: "lead",
    requiredValidations: 1,
    auditStats: new Map(),
  })
  store.replaceRows(makeRows(cells), { full: true, maxServerSeq: 1 })
  const qc = new QueryClient()
  return render(
    <QueryClientProvider client={qc}>
      <EditorActionsProvider value={actions}>
        <EditorTable
          project={project}
          cellStore={store}
          username="lead"
          isCompletionConfigured={false}
          isCompletionAvailable={false}
          completing={new Map()}
          examples={new Map()}
          errors={new Map()}
          previews={new Map()}
          onCompleteSingle={() => {}}
          onCompleteBatch={() => {}}
          healthMap={new Map()}
          lineNumbersEnabled={false}
          cellLabelsEnabled={false}
          sourceTextDirection="ltr"
          targetTextDirection="ltr"
        />
      </EditorActionsProvider>
    </QueryClientProvider>,
  )
}

const ONE_CELL = [makeCell("cell-1", "bonjour")]

afterEach(() => {
  clearSourceEditRequest()
})

describe("EditorTable — source add-row handles (AQU-888)", () => {
  it("shows no handles until the source pencil is open", async () => {
    renderTable(withRole(ROLE.PROJECT_LEAD), { onInsertSourceRow: () => {} }, ONE_CELL)
    await screen.findByText("bonjour")
    expect(screen.queryByRole("button", { name: "Add a row above" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Add a row below" })).not.toBeInTheDocument()
  })

  it("grows a handle on each boundary once the pencil is open", async () => {
    renderTable(withRole(ROLE.PROJECT_LEAD), { onInsertSourceRow: () => {} }, ONE_CELL)
    fireEvent.click(await screen.findByRole("button", { name: "Edit source text" }))
    expect(await screen.findByRole("button", { name: "Add a row above" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Add a row below" })).toBeInTheDocument()
  })

  it("reports the cell and the direction it was pressed on", async () => {
    const onInsertSourceRow = vi.fn()
    renderTable(withRole(ROLE.PROJECT_LEAD), { onInsertSourceRow }, ONE_CELL)
    fireEvent.click(await screen.findByRole("button", { name: "Edit source text" }))

    fireEvent.click(await screen.findByRole("button", { name: "Add a row below" }))
    expect(onInsertSourceRow).toHaveBeenCalledWith("cell-1", "below")

    fireEvent.click(screen.getByRole("button", { name: "Add a row above" }))
    expect(onInsertSourceRow).toHaveBeenLastCalledWith("cell-1", "above")
  })

  it("is ABSENT, not disabled, where the workspace offers no insert action", async () => {
    // A timed file keeps its own insert strip, so the workspace passes nothing
    // — the handles must not appear as a second, dead door onto the same act.
    renderTable(withRole(ROLE.PROJECT_LEAD), {}, ONE_CELL)
    fireEvent.click(await screen.findByRole("button", { name: "Edit source text" }))
    await screen.findByRole("textbox", { name: "Edit source text" })
    expect(screen.queryByRole("button", { name: "Add a row below" })).not.toBeInTheDocument()
  })

  it("keeps the handles away from a contributor, who has no source pencil to open", async () => {
    renderTable(withRole(ROLE.CONTRIBUTOR), { onInsertSourceRow: () => {} }, ONE_CELL)
    await screen.findByText("bonjour")
    expect(screen.queryByRole("button", { name: "Edit source text" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Add a row below" })).not.toBeInTheDocument()
  })
})

describe("EditorTable — the inserted row opens ready to type (AQU-888)", () => {
  beforeEach(() => {
    clearSourceEditRequest()
  })

  it("opens the source editor of the row holding the claim, and only that row", async () => {
    requestSourceEdit("cell-2")
    renderTable(
      withRole(ROLE.PROJECT_LEAD),
      { onInsertSourceRow: () => {} },
      [makeCell("cell-1", "bonjour"), makeCell("cell-2", "")],
    )
    // Exactly one row mounts an editable source surface: the claimed one.
    const editors = await screen.findAllByRole("textbox", { name: "Edit source text" })
    expect(editors).toHaveLength(1)
    // …and it is the claimed row's, which the handles it grew name.
    expect(screen.getByTestId("source-row-insert-below-cell-2")).toBeInTheDocument()
    expect(screen.queryByTestId("source-row-insert-below-cell-1")).not.toBeInTheDocument()
  })

  it("leaves every row closed when no claim is outstanding", async () => {
    renderTable(
      withRole(ROLE.PROJECT_LEAD),
      { onInsertSourceRow: () => {} },
      [makeCell("cell-1", "bonjour"), makeCell("cell-2", "")],
    )
    await screen.findByText("bonjour")
    expect(screen.queryByRole("textbox", { name: "Edit source text" })).not.toBeInTheDocument()
  })
})

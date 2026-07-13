/**
 * AQU-348: the round "select cell" control at the source/target divider
 * (rendered by handleSelectionPointerDown in EditorTable.tsx) silently
 * upgraded a plain click into a range-select whenever *any* other cell was
 * already selected — no Shift needed, no visual confirmation before the
 * range was set. Combined with the range being computed over row INDEXES
 * (`displayCellsRef.current`), this is exactly what QA reported: clicking
 * one cell's control "flipped" a batch that didn't start on the clicked
 * cell and hung 1-2 rows below the intended target, especially once other
 * users' concurrent edits had shifted row order since the previous click
 * set the anchor.
 *
 * The fix makes range-select require an explicit Shift-click. This test
 * encodes the regression: selecting cell A, then a later PLAIN click on
 * cell C, must select exactly C (by id) — never a range from A onward —
 * while a genuine Shift-click still ranges explicitly.
 */

import { afterEach, describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { EditorTable } from "./EditorTable"
import { EditorActionsProvider } from "@/context/EditorActionsContext"
import { CellStore } from "@/hooks/useActiveCellStore"
import type { CellData } from "@/hooks/useCells"
import type { CellRow } from "@/lib/sync/cells-read-types"
import type { ProjectRecord } from "@/lib/parsers/types"
import { clearSelection, getSelectedIds } from "@/lib/audio/selection"

const project: ProjectRecord = {
  id: "proj-1",
  name: "Test Project",
  sourceLanguage: "en",
  targetLanguage: "fr",
  createdAt: "2026-01-01T00:00:00Z",
  files: [],
  members: [],
}

function makeCell(id: string): CellData {
  return {
    id,
    fileId: "file-1",
    original: `source ${id}`,
    translated: `target ${id}`,
    context: `GEN 1:${id}`,
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

// happy-dom has no real layout engine, so the real LegendList may decide no
// rows are visible. Replace it with a trivial "render every row" stand-in,
// matching the pattern in EditorTable.editorActions.test.tsx.
vi.mock("@legendapp/list/react", async () => {
  const React = await import("react")
  return {
    LegendList: React.forwardRef(function MockLegendList({
      data,
      renderItem,
      keyExtractor,
    }: {
      data: string[]
      renderItem: (props: { item: string; index: number }) => React.ReactNode
      keyExtractor?: (item: string, index: number) => string
    }, ref) {
      React.useImperativeHandle(ref, () => ({
        getState: () => ({
          scroll: 0,
          positionAtIndex: (index: number) => index * 140,
          sizeAtIndex: () => 140,
        }),
        scrollToIndex: async () => undefined,
        scrollToOffset: async () => undefined,
      }))
      return React.createElement(
        "div",
        null,
        data.map((item, index) => (
          React.createElement(
            React.Fragment,
            { key: keyExtractor?.(item, index) ?? item },
            renderItem({ item, index }),
          )
        )),
      )
    }),
  }
})

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
        lastEditor: "tester",
        lastEditAt: 2,
        validated: false,
        wordCount: cell.translated.trim().split(/\s+/).filter(Boolean).length,
      },
    ]
  })
}

function makeStore(cells: CellData[]): CellStore {
  const store = new CellStore()
  store.setRuntime({
    projectId: project.id,
    fileId: "file-1",
    username: "tester",
    requiredValidations: 1,
    auditStats: new Map(),
  })
  store.replaceRows(makeRows(cells), { full: true, maxServerSeq: 1 })
  return store
}

function renderTable(cells: CellData[]) {
  const qc = new QueryClient()
  return render(
    <QueryClientProvider client={qc}>
      <EditorActionsProvider value={{}}>
        <EditorTable
          project={project}
          cellStore={makeStore(cells)}
          username="tester"
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

function pointerDown(el: Element, opts: Partial<PointerEventInit> = {}) {
  fireEvent.pointerDown(el, { button: 0, pointerId: 1, clientX: 0, clientY: 0, ...opts })
}

function selectCheckbox(cellId: string) {
  // aria-label flips between the two select-affordance strings depending on
  // isMultiSelected; match on the stable "Select cell" / "Selected cell" prefix
  // scoped to this row via its cell ref text sibling.
  const row = screen.getByLabelText(`GEN 1:${cellId} cell`)
  const btn = row.querySelector('button[role="checkbox"]')
  if (!btn) throw new Error(`select checkbox not found for cell ${cellId}`)
  return btn
}

describe("EditorTable — selection targeting (AQU-348)", () => {
  afterEach(() => {
    clearSelection()
  })

  it("a plain click on an unselected cell selects exactly that cell, never a range from a prior anchor", () => {
    const cells = ["1", "2", "3", "4", "5"].map(makeCell)
    renderTable(cells)

    // First click: select cell 1 (this is also the "already selected"
    // anchor-setting click that used to poison every subsequent plain click).
    pointerDown(selectCheckbox("1"))
    expect([...getSelectedIds()]).toEqual(["1"])

    // Second click, on a DIFFERENT cell, with NO shift key and no modifier —
    // this is the exact gesture QA performed ("clicked the thing in the
    // center column"). It must select exactly cell 4, not a 1..4 range.
    pointerDown(selectCheckbox("4"))
    expect([...getSelectedIds()]).toEqual(["4"])
  })

  it("a plain click on a cell 1-2 rows from a previous selection does not silently batch the rows in between", () => {
    const cells = ["1", "2", "3", "4", "5"].map(makeCell)
    renderTable(cells)

    pointerDown(selectCheckbox("2"))
    expect([...getSelectedIds()]).toEqual(["2"])

    // Click the row just below — under the old implicit-range logic this
    // would select [2,3] or similar depending on anchor bookkeeping, purely
    // because *something* was already selected.
    pointerDown(selectCheckbox("3"))
    expect([...getSelectedIds()]).toEqual(["3"])
  })

  it("an explicit Shift-click still ranges from the anchor (the gesture remains available, just not silent)", () => {
    const cells = ["1", "2", "3", "4", "5"].map(makeCell)
    renderTable(cells)

    pointerDown(selectCheckbox("1"))
    expect([...getSelectedIds()]).toEqual(["1"])

    pointerDown(selectCheckbox("3"), { shiftKey: true })
    expect(new Set(getSelectedIds())).toEqual(new Set(["1", "2", "3"]))
  })

  it("Cmd/Ctrl-click still adds to the selection (unaffected by the range fix)", () => {
    const cells = ["1", "2", "3"].map(makeCell)
    renderTable(cells)

    pointerDown(selectCheckbox("1"))
    pointerDown(selectCheckbox("3"), { metaKey: true })
    expect(new Set(getSelectedIds())).toEqual(new Set(["1", "3"]))
  })
})

/**
 * AQU-2408 — a cell's own label in the editor table. The row side of the
 * contract: `metadata.cellLabel` on the source row reaches the corner label slot
 * (beneath an assigned voice or cast name, obeying "Show cell labels"), and the
 * expansion panel's Label row is editable, read-only or absent by the project's
 * `cellLabelFloor` tier and the viewer's role. The save callback receives the
 * cell and the new label; the parent emits `cell.label.set`.
 *
 * happy-dom has no layout engine, so this asserts structure, not geometry.
 */

import { describe, it, expect, afterEach, vi, type Mock } from "vitest"
import { render, cleanup, within, fireEvent } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { EditorTable } from "./EditorTable"
import { EditorActionsProvider } from "@/context/EditorActionsContext"
import { CellStore } from "@/hooks/useActiveCellStore"
import type { CellData } from "@/hooks/useCells"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { CellRow } from "@/lib/sync/cells-read-types"

type SaveCellLabel = (cell: CellData, label: string | null) => void

/** A full `syncRole` at `level`; the gate reads only `level`. */
function role(level: number): NonNullable<ProjectRecord["syncRole"]> {
  return { level, name: "member", source: "member", fetchedAt: "2026-11-05T00:00:00.000Z" }
}

vi.mock("@legendapp/list/react", async () => {
  const React = await import("react")
  return {
    LegendList: React.forwardRef(function MockLegendList({
      data,
      renderItem,
      keyExtractor,
    }: {
      data: string[]
      renderItem: (props: { item: string; index: number }) => ReactNode
      keyExtractor?: (item: string, index: number) => string
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
          React.createElement(React.Fragment, { key: keyExtractor?.(item, index) ?? item }, renderItem({ item, index })),
        ),
      )
    }),
  }
})

afterEach(cleanup)

function makeProject(over: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: "proj-1",
    name: "Test Project",
    sourceLanguage: "en",
    targetLanguage: "es",
    createdAt: "2026-01-01T00:00:00Z",
    files: [],
    members: [],
    syncRole: role(600),
    ...over,
  } as ProjectRecord
}

function cellRows(id: string, metadata: Record<string, unknown> | null): CellRow[] {
  return [
    {
      cellId: id, side: "source", value: `source ${id}`, valueHtml: null, type: "text",
      canonicalRef: null, anchorCellId: null, eventId: `${id}-source`,
      sourceEventId: null, lastEditor: null, lastEditAt: 1, validated: false, wordCount: 2,
      metadata,
    },
    {
      cellId: id, side: "target", value: `target ${id}`, valueHtml: null, type: "text",
      canonicalRef: null, anchorCellId: null, eventId: `${id}-target`,
      sourceEventId: `${id}-source`, lastEditor: "tester", lastEditAt: 2, validated: false, wordCount: 1,
    },
  ]
}

const ROWS: CellRow[] = [
  ...cellRows("labelled", { cellLabel: "Pericope" }),
  ...cellRows("plain", null),
  ...cellRows("cast", { cellLabel: "Pericope", cast_name: "Mary" }),
]

function renderTable(opts: { project?: ProjectRecord; onSaveCellLabel?: Mock<SaveCellLabel>; cellLabelsEnabled?: boolean } = {}) {
  const project = opts.project ?? makeProject()
  const store = new CellStore()
  store.setRuntime({ projectId: project.id, fileId: "file-1", username: "tester", requiredValidations: 1, auditStats: new Map() })
  store.replaceRows(ROWS, { full: true, maxServerSeq: 1 })
  const qc = new QueryClient()
  return render(
    <QueryClientProvider client={qc}>
      <EditorActionsProvider value={{}}>
        <EditorTable
          project={project}
          cellStore={store}
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
          cellLabelsEnabled={opts.cellLabelsEnabled ?? true}
          sourceTextDirection="ltr"
          targetTextDirection="ltr"
          {...(opts.onSaveCellLabel ? { onSaveCellLabel: opts.onSaveCellLabel } : {})}
        />
      </EditorActionsProvider>
    </QueryClientProvider>,
  )
}

function row(cellId: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-cell-id="${cellId}"]`)
  if (!el) throw new Error(`no row for ${cellId}`)
  return el
}

function expand(cellId: string): HTMLElement {
  fireEvent.click(within(row(cellId)).getByRole("button", { name: "Open cell details" }))
  return row(cellId)
}

describe("cell label — corner slot (AQU-2408)", () => {
  it("shows the typed label in the corner while 'Show cell labels' is on", () => {
    renderTable()
    expect(within(row("labelled")).getByTestId("source-cell-label")).toHaveTextContent("Pericope")
    expect(within(row("plain")).queryByTestId("source-cell-label")).toBeNull()
  })

  it("hides it with the preference off", () => {
    renderTable({ cellLabelsEnabled: false })
    expect(within(row("labelled")).queryByTestId("source-cell-label")).toBeNull()
  })

  it("lets the cast name win on a cast line — a label never displaces a character", () => {
    renderTable()
    expect(within(row("cast")).getByTestId("source-cell-label")).toHaveTextContent("Mary")
  })
})

describe("cell label — the Label row by tier (AQU-2408)", () => {
  it("a maintainer may type it, and saving hands the cell and the new label to the parent", () => {
    const onSaveCellLabel = vi.fn<SaveCellLabel>()
    renderTable({ onSaveCellLabel })
    const r = expand("labelled")
    const input = within(r).getByTestId("cell-label-input")
    expect(input).toHaveValue("Pericope")
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: "Needs consultant" } })
    fireEvent.keyDown(input, { key: "Enter" })
    fireEvent.blur(input)
    expect(onSaveCellLabel).toHaveBeenCalledTimes(1)
    const [cell, label] = onSaveCellLabel.mock.calls[0]
    expect(cell.id).toBe("labelled")
    expect(label).toBe("Needs consultant")
  })

  it("a project lead reads it as plain text while the tier is maintainer, and types it once the project opens the tier", () => {
    const onSaveCellLabel = vi.fn<SaveCellLabel>()
    renderTable({ onSaveCellLabel, project: makeProject({ syncRole: role(500) }) })
    let r = expand("labelled")
    expect(within(r).getByTestId("cell-label-text")).toHaveTextContent("Pericope")
    expect(within(r).queryByTestId("cell-label-input")).toBeNull()
    cleanup()

    renderTable({
      onSaveCellLabel,
      project: makeProject({ syncRole: role(500), cellLabelFloor: "project_lead" }),
    })
    r = expand("labelled")
    expect(within(r).getByTestId("cell-label-input")).toHaveValue("Pericope")
  })

  it("a contributor never gets the field, and sees no row at all on an unlabelled cell", () => {
    renderTable({
      onSaveCellLabel: vi.fn<SaveCellLabel>(),
      project: makeProject({ syncRole: role(400), cellLabelFloor: "project_lead" }),
    })
    const labelled = expand("labelled")
    expect(within(labelled).getByTestId("cell-label-text")).toHaveTextContent("Pericope")
    expect(within(labelled).queryByTestId("cell-label-input")).toBeNull()
    const plain = expand("plain")
    expect(within(plain).queryByTestId("cell-label-row")).toBeNull()
  })

  it("without a save handler the row is read-only even for a maintainer", () => {
    renderTable()
    const r = expand("labelled")
    expect(within(r).getByTestId("cell-label-text")).toHaveTextContent("Pericope")
    expect(within(r).queryByTestId("cell-label-input")).toBeNull()
  })
})

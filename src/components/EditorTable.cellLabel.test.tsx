/**
 * AQU-2408 — a cell's own label in the editor table. The row side of the
 * contract: `metadata.cellLabel` on the source row reaches the corner label slot
 * (beneath an assigned voice or cast name, obeying "Show cell labels"), and the
 * label is typed in that same slot — opened by the Label button in the row's
 * `⋯` menu or by a click on the label — by the project's `cellLabelFloor` tier
 * and the viewer's role. It is never in the details panel. The save callback
 * receives the cell and the new label; the parent emits `cell.label.set`.
 *
 * happy-dom has no layout engine, so this asserts structure, not geometry.
 */

import { describe, it, expect, afterEach, vi, type Mock } from "vitest"
import { render, cleanup, within, fireEvent, screen, waitFor } from "@testing-library/react"
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

// The label is typed where it is read. The row's `⋯` menu has a Label button
// that turns the source corner's slot into a field with the caret in it. The
// popup portals to the document body, so its buttons are read off `screen`.
describe("cell label — typed in the corner slot (AQU-2408)", () => {
  function openOverflow(cellId: string) {
    fireEvent.click(within(row(cellId)).getByRole("button", { name: /^More actions · / }))
  }

  function contextLine(cellId: string): HTMLElement {
    return within(row(cellId)).getByTestId("source-context-line")
  }

  it("'Add label' puts a field in the corner of an unlabelled cell, and saving hands the cell and label to the parent", async () => {
    const onSaveCellLabel = vi.fn<SaveCellLabel>()
    renderTable({ onSaveCellLabel })
    openOverflow("plain")
    fireEvent.click(await screen.findByRole("button", { name: "Add label" }))

    const input = within(contextLine("plain")).getByTestId("cell-label-input")
    expect(document.activeElement).toBe(input)
    // The details panel stays shut: the label is not typed there.
    expect(within(row("plain")).queryByRole("button", { name: "Close cell details" })).toBeNull()

    fireEvent.change(input, { target: { value: "Needs consultant" } })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(onSaveCellLabel).toHaveBeenCalledTimes(1)
    const [cell, label] = onSaveCellLabel.mock.calls[0]
    expect(cell.id).toBe("plain")
    expect(label).toBe("Needs consultant")
    // The field is gone once the edit is over.
    expect(within(row("plain")).queryByTestId("cell-label-input")).toBeNull()
    // …and the corner shows what was typed at once, ahead of the projection.
    expect(within(row("plain")).getByTestId("source-cell-label")).toHaveTextContent("Needs consultant")
  })

  it("'Edit label' opens the field over the existing label, pre-filled", async () => {
    renderTable({ onSaveCellLabel: vi.fn<SaveCellLabel>() })
    openOverflow("labelled")
    fireEvent.click(await screen.findByRole("button", { name: "Edit label" }))
    const line = contextLine("labelled")
    expect(within(line).getByTestId("cell-label-input")).toHaveValue("Pericope")
    expect(within(line).queryByTestId("source-cell-label")).toBeNull()
  })

  it("a click on the label itself opens the field, and Escape puts the label back unsaved", () => {
    const onSaveCellLabel = vi.fn<SaveCellLabel>()
    renderTable({ onSaveCellLabel })
    fireEvent.click(within(row("labelled")).getByRole("button", { name: "Edit label: Pericope" }))
    const input = within(contextLine("labelled")).getByTestId("cell-label-input")
    fireEvent.change(input, { target: { value: "Half-typed" } })
    fireEvent.keyDown(input, { key: "Escape" })
    expect(onSaveCellLabel).not.toHaveBeenCalled()
    expect(within(row("labelled")).queryByTestId("cell-label-input")).toBeNull()
    expect(within(row("labelled")).getByTestId("source-cell-label")).toHaveTextContent("Pericope")
  })

  it("a cast name in the corner is not a label: it is plain text, never a way into the field", () => {
    renderTable({ onSaveCellLabel: vi.fn<SaveCellLabel>() })
    const corner = within(row("cast")).getByTestId("source-cell-label")
    expect(corner).toHaveTextContent("Mary")
    expect(corner.tagName).toBe("SPAN")
  })

  it("opens from the button even with 'Show cell labels' off", async () => {
    renderTable({ onSaveCellLabel: vi.fn<SaveCellLabel>(), cellLabelsEnabled: false })
    openOverflow("labelled")
    fireEvent.click(await screen.findByRole("button", { name: "Edit label" }))
    expect(within(contextLine("labelled")).getByTestId("cell-label-input")).toHaveValue("Pericope")
  })

  it("the details panel has no label field or row any more", () => {
    renderTable({ onSaveCellLabel: vi.fn<SaveCellLabel>() })
    const r = expand("labelled")
    expect(within(r).queryByTestId("cell-label-input")).toBeNull()
    expect(within(r).queryByTestId("cell-label-row")).toBeNull()
  })
})

describe("cell label — who may type it, by tier (AQU-2408)", () => {
  async function overflowButtons(cellId: string): Promise<string[]> {
    fireEvent.click(within(row(cellId)).getByRole("button", { name: /^More actions · / }))
    const popup = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-slot="popover-content"]')
      if (!el) throw new Error("overflow popup not open")
      return el
    })
    const names = within(popup).getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? "")
    expect(names.length).toBeGreaterThan(0)
    return names
  }

  it("a project lead only reads the corner while the tier is maintainer, and may type once the project opens the tier", async () => {
    const onSaveCellLabel = vi.fn<SaveCellLabel>()
    renderTable({ onSaveCellLabel, project: makeProject({ syncRole: role(500) }) })
    expect(within(row("labelled")).getByTestId("source-cell-label").tagName).toBe("SPAN")
    expect(await overflowButtons("labelled")).not.toContain("Edit label")
    cleanup()

    renderTable({
      onSaveCellLabel,
      project: makeProject({ syncRole: role(500), cellLabelFloor: "project_lead" }),
    })
    expect(within(row("labelled")).getByTestId("source-cell-label").tagName).toBe("BUTTON")
    expect(await overflowButtons("labelled")).toContain("Edit label")
  })

  it("a contributor never gets the button or a clickable label, whatever the tier", async () => {
    renderTable({
      onSaveCellLabel: vi.fn<SaveCellLabel>(),
      project: makeProject({ syncRole: role(400), cellLabelFloor: "project_lead" }),
    })
    expect(within(row("labelled")).getByTestId("source-cell-label").tagName).toBe("SPAN")
    const names = await overflowButtons("plain")
    expect(names).not.toContain("Add label")
    expect(names).not.toContain("Edit label")
  })

  it("without a save handler there is no way in, even for a maintainer", async () => {
    renderTable()
    expect(within(row("labelled")).getByTestId("source-cell-label").tagName).toBe("SPAN")
    expect(await overflowButtons("labelled")).not.toContain("Edit label")
  })
})

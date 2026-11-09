/**
 * AQU-2021 — a cell's detail view opens as a pop-up modal on double-click.
 *
 * The expanded view (recording and takes, back-translation, issues, history)
 * used to be reachable only through the small chevron on the hover rail, which
 * testers did not find. Double-clicking the row now opens the same tab shell
 * centred over the table, and previous/next walk the file without closing it.
 *
 * The load-bearing guard is the second test: double-click is also how a person
 * selects a word, so the gesture must do nothing inside the open editor.
 *
 * happy-dom has no layout engine, so this asserts structure, not geometry.
 */

import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup, screen, fireEvent, waitFor, within } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { MemoryRouter } from "react-router-dom"
import { EditorTable } from "./EditorTable"
import { EditorActionsProvider } from "@/context/EditorActionsContext"
import { CellStore } from "@/hooks/useActiveCellStore"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { CellRow } from "@/lib/sync/cells-read-types"

// happy-dom has no layout engine, so the real LegendList may decide no rows are
// visible. Render every row — this suite is about one cell's details.
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
          React.createElement(
            React.Fragment,
            { key: keyExtractor?.(item, index) ?? item },
            renderItem({ item, index }),
          ),
        ),
      )
    }),
  }
})

afterEach(cleanup)

function project(): ProjectRecord {
  return {
    id: "proj-1",
    name: "Test Project",
    sourceLanguage: "en",
    targetLanguage: "es",
    createdAt: "2026-01-01T00:00:00Z",
    files: [],
    members: [],
    syncRole: { level: 600, name: "member", source: "member", fetchedAt: "2026-11-05T00:00:00.000Z" },
  } as ProjectRecord
}

function cellRows(id: string, index: number): CellRow[] {
  return [
    {
      cellId: id, side: "source", value: `source ${id}`, valueHtml: null, type: "text",
      canonicalRef: null, anchorCellId: null, eventId: `${id}-source`,
      sourceEventId: null, lastEditor: null, lastEditAt: index, validated: false, wordCount: 2,
    },
    {
      cellId: id, side: "target", value: `target ${id}`, valueHtml: null, type: "text",
      canonicalRef: null, anchorCellId: null, eventId: `${id}-target`,
      sourceEventId: `${id}-source`, lastEditor: "tester", lastEditAt: index, validated: false, wordCount: 2,
    },
  ]
}

const ROWS: CellRow[] = [
  ...cellRows("first", 1),
  ...cellRows("middle", 2),
  ...cellRows("last", 3),
]

function renderTable() {
  const store = new CellStore()
  const p = project()
  store.setRuntime({
    projectId: p.id, fileId: "file-1", username: "tester",
    requiredValidations: 1, auditStats: new Map(),
  })
  store.replaceRows(ROWS, { full: true, maxServerSeq: 1 })
  const qc = new QueryClient()
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <EditorActionsProvider value={{}}>
          <EditorTable
            project={p}
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
            cellLabelsEnabled
            sourceTextDirection="ltr"
            targetTextDirection="ltr"
          />
        </EditorActionsProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  )
}

/** The row wrapper that carries the double-click handler. */
function row(cellId: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-cell-id="${cellId}"] [data-grid-row]`)
  if (!el) throw new Error(`no row for ${cellId}`)
  return el
}

/** The modal is portalled out of the row, so it is queried from the document. */
function dialog(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-cell-detail-dialog]")
}

function openDetail(cellId: string) {
  fireEvent.doubleClick(row(cellId))
}

describe("cell details as a pop-up modal (AQU-2021)", () => {
  it("opens on double-click, titled with the cell, holding the same tab shell", async () => {
    renderTable()
    expect(dialog()).toBeNull()

    openDetail("middle")

    const panel = await waitFor(() => {
      const d = dialog()
      if (!d) throw new Error("detail modal did not open")
      return d
    })
    // "row 2" is the second cell's own name (no scripture reference in this file).
    expect(within(panel).getByText("row 2 details")).toBeTruthy()
    // The tabs are the expansion's, shown in modal presentation — not the
    // inline panel that drops under the row.
    expect(panel.querySelector('[data-cell-detail-presentation="modal"]')).toBeTruthy()
    expect(row("middle").closest("[data-cell-id]")!.querySelector("[data-cell-detail-presentation]")).toBeNull()
  })

  it("walks the file with previous/next, and disables the control at each end", async () => {
    renderTable()
    openDetail("first")
    let panel = await waitFor(() => dialog() ?? Promise.reject(new Error("no modal")))

    // First cell: nothing before it.
    expect(panel.querySelector("[data-cell-detail-prev]")).toBeDisabled()
    expect(panel.querySelector("[data-cell-detail-next]")).not.toBeDisabled()

    fireEvent.click(panel.querySelector("[data-cell-detail-next]")!)
    await waitFor(() => expect(within(dialog()!).getByText("row 2 details")).toBeTruthy())

    // Middle cell: both ways.
    panel = dialog()!
    expect(panel.querySelector("[data-cell-detail-prev]")).not.toBeDisabled()
    expect(panel.querySelector("[data-cell-detail-next]")).not.toBeDisabled()

    fireEvent.click(panel.querySelector("[data-cell-detail-next]")!)
    await waitFor(() => expect(within(dialog()!).getByText("row 3 details")).toBeTruthy())
    expect(dialog()!.querySelector("[data-cell-detail-next]")).toBeDisabled()

    // And back — the modal never closed on the way.
    fireEvent.click(dialog()!.querySelector("[data-cell-detail-prev]")!)
    await waitFor(() => expect(within(dialog()!).getByText("row 2 details")).toBeTruthy())
  })

  it("only ever has one cell's details open", async () => {
    renderTable()
    openDetail("first")
    await waitFor(() => expect(within(dialog()!).getByText("row 1 details")).toBeTruthy())

    openDetail("last")
    await waitFor(() => expect(within(dialog()!).getByText("row 3 details")).toBeTruthy())
    expect(document.querySelectorAll("[data-cell-detail-dialog]")).toHaveLength(1)
  })

  it("leaves double-click alone inside the editor, so it still selects a word", async () => {
    renderTable()
    // Click the read surface to activate this cell's editor, then wait for
    // TipTap's contenteditable to mount.
    const target = await screen.findByText("target middle")
    const readSurface = target.closest("[data-target-read-view]") as HTMLElement
    fireEvent.click(readSurface)
    const surface = await waitFor(() => {
      const pm = row("middle").querySelector<HTMLElement>(".ProseMirror")
      if (!pm) throw new Error("editor not mounted yet")
      return pm
    })

    fireEvent.doubleClick(surface)

    // No modal: the browser's own word selection is the whole point of a
    // double-click in text, and stealing it would be the regression.
    expect(dialog()).toBeNull()
  })

  it("keeps Cmd/Ctrl-double-click as the multi-select gesture", async () => {
    renderTable()
    fireEvent.doubleClick(row("middle"), { metaKey: true })
    expect(dialog()).toBeNull()
    fireEvent.doubleClick(row("middle"), { ctrlKey: true })
    expect(dialog()).toBeNull()
  })
})

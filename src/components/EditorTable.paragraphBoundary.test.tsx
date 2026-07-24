/**
 * p1-paragraph-ui-wiring (Task 2): paragraph boundaries must become visible
 * in the editor table — but ONLY on cells where `CellData.paragraphStart`
 * is `true`, and NEVER on the first row of a file (the file header already
 * delimits it). A legend/document with no paragraph flags at all (every
 * pre-existing import) must render byte-identical to before this change.
 */

import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { QueryClientProvider, QueryClient } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { EditorTable } from "./EditorTable"
import { EditorActionsProvider } from "@/context/EditorActionsContext"
import { CellStore } from "@/hooks/useActiveCellStore"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { CellRow } from "@/lib/sync/cells-read-types"

// happy-dom has no real layout engine, so the real LegendList may decide no
// rows are visible. Replace it with a trivial "render every row" stand-in,
// following EditorTable.editorActions.test.tsx's pattern.
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

const project: ProjectRecord = {
  id: "proj-1",
  name: "Test Project",
  sourceLanguage: "en",
  targetLanguage: "fr",
  createdAt: "2026-01-01T00:00:00Z",
  files: [],
  members: [],
}

function makeRows(
  cellIds: string[],
  paragraphStartIds: ReadonlySet<string>,
): CellRow[] {
  return cellIds.flatMap((id, i) => [
    {
      cellId: id,
      side: "source",
      value: `source ${i}`,
      valueHtml: null,
      type: "text",
      canonicalRef: `GEN 1:${i + 1}`,
      anchorCellId: null,
      eventId: `${id}-source`,
      sourceEventId: null,
      lastEditor: null,
      lastEditAt: 1,
      validated: false,
      wordCount: 1,
      ...(paragraphStartIds.has(id) ? { metadata: { paragraphStart: true } } : {}),
    },
    {
      cellId: id,
      side: "target",
      value: `target ${i}`,
      valueHtml: null,
      type: "text",
      canonicalRef: `GEN 1:${i + 1}`,
      anchorCellId: null,
      eventId: `${id}-target`,
      sourceEventId: `${id}-source`,
      lastEditor: "tester",
      lastEditAt: 2,
      validated: false,
      wordCount: 1,
    },
  ] satisfies CellRow[])
}

function makeStore(cellIds: string[], paragraphStartIds: ReadonlySet<string>): CellStore {
  const store = new CellStore()
  store.setRuntime({
    projectId: project.id,
    fileId: "file-1",
    username: "tester",
    requiredValidations: 1,
    auditStats: new Map(),
  })
  store.replaceRows(makeRows(cellIds, paragraphStartIds), { full: true, maxServerSeq: 1 })
  return store
}

function renderTable(cellStore: CellStore) {
  const qc = new QueryClient()
  return render(
    <QueryClientProvider client={qc}>
      <EditorActionsProvider value={{}}>
        <EditorTable
          project={project}
          cellStore={cellStore}
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

describe("EditorTable — paragraph boundary visuals (p1-paragraph-ui-wiring)", () => {
  it("shows exactly one pilcrow indicator, on the third row, when only its cell is a paragraph start", async () => {
    const store = makeStore(["cell-1", "cell-2", "cell-3"], new Set(["cell-3"]))
    renderTable(store)

    await screen.findByText("target 0")

    const indicators = screen.getAllByTitle("New paragraph")
    expect(indicators).toHaveLength(1)

    const row = indicators[0].closest("[data-cell-id]")
    expect(row).toHaveAttribute("data-cell-id", "cell-3")
    expect(row).toHaveAttribute("data-paragraph-start", "true")
  })

  it("shows no indicator when the paragraph-start cell is the first row of the file", async () => {
    const store = makeStore(["cell-1", "cell-2"], new Set(["cell-1"]))
    renderTable(store)

    await screen.findByText("target 0")

    expect(screen.queryByTitle("New paragraph")).not.toBeInTheDocument()
    const firstRow = screen.getByText("target 0").closest("[data-cell-id]")
    expect(firstRow).not.toHaveAttribute("data-paragraph-start")
  })

  it("shows zero indicators when no cell has paragraphStart set (legacy import regression guard)", async () => {
    const store = makeStore(["cell-1", "cell-2", "cell-3"], new Set())
    renderTable(store)

    await screen.findByText("target 0")

    expect(screen.queryByTitle("New paragraph")).not.toBeInTheDocument()
    for (const id of ["cell-1", "cell-2", "cell-3"]) {
      const row = document.querySelector(`[data-cell-id="${id}"]`)
      expect(row).not.toHaveAttribute("data-paragraph-start")
    }
  })
})

/**
 * AQU-1285: a Biblica study-Bible file holds two kinds of cell — one verse of
 * the Bible text, and the study notes written about it. A translator has to be
 * able to tell which row is which before they start typing, and the row has to
 * show the verse it is keyed to. Everything else — every file that is not a
 * Biblica study-Bible import — must render exactly as before.
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
  metadataById: ReadonlyMap<string, Record<string, unknown>>,
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
      metadata: {
        ...(paragraphStartIds.has(id) ? { paragraphStart: true } : {}),
        ...(metadataById.get(id) ?? {}),
      },
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

function makeStore(
  cellIds: string[],
  paragraphStartIds: ReadonlySet<string>,
  metadataById: ReadonlyMap<string, Record<string, unknown>>,
): CellStore {
  const store = new CellStore()
  store.setRuntime({
    projectId: project.id,
    fileId: "file-1",
    username: "tester",
    requiredValidations: 1,
    auditStats: new Map(),
  })
  store.replaceRows(makeRows(cellIds, paragraphStartIds, metadataById), {
    full: true,
    maxServerSeq: 1,
  })
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


const SCRIPTURE_METADATA: Record<string, unknown> = {
  biblica: { version: 1, contentType: "scripture", bookCode: "GEN", verseReference: "GEN 1:1" },
}
const NOTE_METADATA: Record<string, unknown> = {
  biblica: { version: 1, contentType: "notes", bookCode: "GEN" },
}

describe("EditorTable — Biblica scripture rows are distinguishable (AQU-1285)", () => {
  it("marks only the verse rows, and leaves the study notes beside them unmarked", async () => {
    const store = makeStore(["verse-1", "note-1", "verse-2"], new Set(), new Map([
      ["verse-1", SCRIPTURE_METADATA],
      ["note-1", NOTE_METADATA],
      ["verse-2", SCRIPTURE_METADATA],
    ]))
    renderTable(store)

    await screen.findByText("target 0")

    expect(document.querySelector('[data-cell-id="verse-1"]'))
      .toHaveAttribute("data-cell-kind", "scripture")
    expect(document.querySelector('[data-cell-id="verse-2"]'))
      .toHaveAttribute("data-cell-kind", "scripture")
    expect(document.querySelector('[data-cell-id="note-1"]'))
      .not.toHaveAttribute("data-cell-kind")
    // One badge per verse row, and none on the note.
    expect(screen.getAllByText("verse")).toHaveLength(2)
  })

  it("shows the verse a scripture row is keyed to as the row's reference", async () => {
    const store = makeStore(["verse-1"], new Set(), new Map([["verse-1", SCRIPTURE_METADATA]]))
    renderTable(store)

    await screen.findByText("target 0")

    // The canonical ref travels with the cell, so a translator reads "GEN 1:1"
    // on the row rather than scrolling past scripture that has no cell.
    expect(screen.getByLabelText("GEN 1:1 cell")).toBeInTheDocument()
  })

  it("marks no row in a file that is not a Biblica study-Bible import", async () => {
    const store = makeStore(["cell-1", "cell-2"], new Set(), new Map())
    renderTable(store)

    await screen.findByText("target 0")

    for (const id of ["cell-1", "cell-2"]) {
      expect(document.querySelector(`[data-cell-id="${id}"]`))
        .not.toHaveAttribute("data-cell-kind")
    }
    expect(screen.queryByText("verse")).not.toBeInTheDocument()
  })
})

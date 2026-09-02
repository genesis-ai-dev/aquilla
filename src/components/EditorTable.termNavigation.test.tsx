/**
 * AQU-1102 — a term lookup opens the matching terminology entry and never
 * writes rendering text into the target cell.
 */
import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { EditorTable } from "./EditorTable"
import { EditorActionsProvider } from "@/context/EditorActionsContext"
import { CellStore } from "@/hooks/useActiveCellStore"
import type { CellData } from "@/hooks/useCells"
import type { CellRow } from "@/lib/sync/cells-read-types"
import type { ProjectRecord } from "@/lib/parsers/types"

vi.mock("@/hooks/useDcsUpstreamCursor", () => ({
  useDcsUpstreamCursor: () => ({ cursor: null, loading: false }),
}))

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
        data.map((item, index) => React.createElement(
          React.Fragment,
          { key: keyExtractor?.(item, index) ?? item.id },
          renderItem({ item, index }),
        )),
      )
    }),
  }
})

const project: ProjectRecord = {
  id: "proj-1",
  name: "Test Project",
  sourceLanguage: "en",
  targetLanguage: "es",
  createdAt: "2026-01-01T00:00:00Z",
  files: [],
  members: [],
  terminology: [{
    id: "concept-1",
    sourceTerm: "sample",
    status: "active",
    createdAt: "2026-01-01T00:00:00Z",
    renderings: [
      { rendering: "muestra", status: "preferred" },
      { rendering: "verboten", status: "forbidden" },
    ],
  }],
}

const cell: CellData = {
  id: "cell-1",
  fileId: "file-1",
  original: "sample",
  translated: "Esto es una prueba.",
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

function makeStore(): CellStore {
  const rows: CellRow[] = [
    {
      cellId: cell.id,
      side: "source",
      value: cell.original,
      valueHtml: null,
      type: cell.type,
      canonicalRef: cell.context,
      anchorCellId: null,
      eventId: "source-event",
      sourceEventId: null,
      lastEditor: null,
      lastEditAt: 1,
      validated: false,
      wordCount: 4,
    },
    {
      cellId: cell.id,
      side: "target",
      value: cell.translated,
      valueHtml: null,
      type: cell.type,
      canonicalRef: cell.context,
      anchorCellId: null,
      eventId: "target-event",
      sourceEventId: "source-event",
      lastEditor: "lead",
      lastEditAt: 2,
      validated: false,
      wordCount: 4,
    },
  ]
  const store = new CellStore()
  store.setRuntime({
    projectId: project.id,
    fileId: "file-1",
    username: "lead",
    requiredValidations: 1,
    auditStats: new Map(),
  })
  store.replaceRows(rows, { full: true, maxServerSeq: 1 })
  return store
}

describe("EditorTable term navigation", () => {
  it("opens the terminology entry without changing the target", async () => {
    const onOpenTerminologyConcept = vi.fn()
    const onOptimisticEdit = vi.fn()
    render(
      <QueryClientProvider client={new QueryClient()}>
        <EditorActionsProvider value={{ onOpenTerminologyConcept }}>
          <EditorTable
            project={project}
            cellStore={makeStore()}
            username="lead"
            isCompletionConfigured={false}
            isCompletionAvailable={false}
            completing={new Map()}
            examples={new Map()}
            errors={new Map()}
            previews={new Map()}
            onCompleteSingle={() => undefined}
            onCompleteBatch={() => undefined}
            onOptimisticEdit={onOptimisticEdit}
            healthMap={new Map()}
            lineNumbersEnabled={false}
            cellLabelsEnabled={false}
            sourceTextDirection="ltr"
            targetTextDirection="ltr"
          />
        </EditorActionsProvider>
      </QueryClientProvider>,
    )

    fireEvent.click(await screen.findByText("sample"))
    fireEvent.click(
      await screen.findByRole("button", {
        name: /Go to Terminology page.*sample/i,
      }),
    )

    expect(onOpenTerminologyConcept).toHaveBeenCalledWith("concept-1")
    expect(onOptimisticEdit).not.toHaveBeenCalled()
    expect(screen.getByText("Esto es una prueba.")).toBeInTheDocument()
  })
})

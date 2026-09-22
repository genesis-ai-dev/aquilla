/**
 * AQU-1369 — a metadata field switched on from one cell's Metadata tab labels
 * every cell in the project that carries that key, and switching it off from
 * any cell clears it everywhere. This pins the row side of that contract: the
 * project-scoped setting drives a label on each carrying row's source context
 * line, and rows without the key stay untouched.
 *
 * happy-dom has no layout engine, so this asserts structure, not geometry.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, screen, cleanup, act, within } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { EditorTable } from "./EditorTable"
import { EditorActionsProvider } from "@/context/EditorActionsContext"
import { CellStore } from "@/hooks/useActiveCellStore"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { CellRow } from "@/lib/sync/cells-read-types"
import {
  __resetCellDisplayFieldsCache,
  setCellDisplayField,
} from "@/lib/store/cell-display-fields"

// happy-dom has no real layout engine, so LegendList may decide no rows are
// visible. Replace it with a trivial "render every row" stand-in.
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

const project: ProjectRecord = {
  id: "proj-1",
  name: "Test Project",
  sourceLanguage: "hbo",
  targetLanguage: "es",
  createdAt: "2026-01-01T00:00:00Z",
  files: [],
  members: [],
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

// The SDBH importer's real shape (AQU-793): `Field` names what the cell is.
const ROWS: CellRow[] = [
  ...cellRows("sdbh-a-glosses", { Field: "glosses", tags: ["Gloss"] }),
  ...cellRows("sdbh-a-definition", { Field: "definition" }),
  ...cellRows("plain-cell", { quote: "λόγος" }),
]

function renderTable() {
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
          cellLabelsEnabled={false}
          sourceTextDirection="ltr"
          targetTextDirection="ltr"
        />
      </EditorActionsProvider>
    </QueryClientProvider>,
  )
}

function labelTexts(): string[] {
  return screen
    .queryAllByTestId("metadata-field-labels")
    .flatMap((el) => Array.from(el.children).map((c) => c.textContent ?? ""))
}

describe("metadata display-field labels (AQU-1369)", () => {
  beforeEach(() => {
    localStorage.clear()
    __resetCellDisplayFieldsCache()
  })

  it("shows no labels until a field is switched on", () => {
    renderTable()
    expect(screen.queryByTestId("metadata-field-labels")).toBeNull()
  })

  it("labels EVERY row carrying the key once it is on, and none that lack it", () => {
    renderTable()
    act(() => setCellDisplayField(project.id, "Field", true))
    expect(labelTexts()).toEqual(["glosses", "definition"])
    // Each label sits in its own row's source context line.
    const lines = screen.getAllByTestId("source-context-line")
    const withLabels = lines.filter((line) => within(line).queryByTestId("metadata-field-labels"))
    expect(withLabels).toHaveLength(2)
  })

  it("clears the labels from every row when the key is switched off", () => {
    renderTable()
    act(() => setCellDisplayField(project.id, "Field", true))
    act(() => setCellDisplayField(project.id, "Field", false))
    expect(screen.queryByTestId("metadata-field-labels")).toBeNull()
  })

  it("is scoped to the project — another project's setting labels nothing here", () => {
    setCellDisplayField("some-other-project", "Field", true)
    renderTable()
    expect(screen.queryByTestId("metadata-field-labels")).toBeNull()
  })
})

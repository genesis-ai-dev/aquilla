/**
 * Split-into-milestones view: the table can page one chapter/section at a
 * time instead of listing every cell in the file. The switch lives in
 * ⋯ → Editor settings; the arrows then turn the page.
 */

import { describe, it, expect, beforeEach, vi } from "vitest"
import { act, render, screen, fireEvent } from "@testing-library/react"
import { QueryClientProvider, QueryClient } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { EditorTable } from "./EditorTable"
import { EditorActionsProvider } from "@/context/EditorActionsContext"
import { CellStore } from "@/hooks/useActiveCellStore"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { CellRow } from "@/lib/sync/cells-read-types"
import {
  resetMilestoneSplitCacheForTests,
  setMilestoneSplit,
} from "@/lib/store/milestone-split-pref"

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

const CELLS = [
  { id: "cell-ch1-a", ref: "GEN 1:1" },
  { id: "cell-ch1-b", ref: "GEN 1:2" },
  { id: "cell-ch2-a", ref: "GEN 2:1" },
  { id: "cell-ch2-b", ref: "GEN 2:2" },
] as const

function makeRows(): CellRow[] {
  return CELLS.flatMap(({ id, ref }, i) => [
    {
      cellId: id,
      side: "source",
      value: `source ${i}`,
      valueHtml: null,
      type: "text",
      canonicalRef: ref,
      anchorCellId: null,
      eventId: `${id}-source`,
      sourceEventId: null,
      lastEditor: null,
      lastEditAt: 1,
      validated: false,
      wordCount: 1,
    },
    {
      cellId: id,
      side: "target",
      value: `target ${i}`,
      valueHtml: null,
      type: "text",
      canonicalRef: ref,
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

function makeStore(): CellStore {
  const store = new CellStore()
  store.setRuntime({
    projectId: project.id,
    fileId: "file-1",
    username: "tester",
    requiredValidations: 1,
    auditStats: new Map(),
  })
  store.replaceRows(makeRows(), { full: true, maxServerSeq: 1 })
  return store
}

function renderTable() {
  const qc = new QueryClient()
  return render(
    <QueryClientProvider client={qc}>
      <EditorActionsProvider value={{}}>
        <EditorTable
          project={project}
          cellStore={makeStore()}
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

function cellRow(id: string) {
  return document.querySelector(`[data-cell-id="${id}"]`)
}

describe("EditorTable — split into milestones", () => {
  beforeEach(() => {
    localStorage.clear()
    resetMilestoneSplitCacheForTests()
    setMilestoneSplit(false)
  })

  it("lists every cell until the settings preference pages one chapter at a time", () => {
    renderTable()

    expect(screen.queryByRole("button", { name: "Split into milestones" })).toBeNull()
    expect(cellRow("cell-ch1-a")).toBeTruthy()
    expect(cellRow("cell-ch1-b")).toBeTruthy()
    expect(cellRow("cell-ch2-a")).toBeTruthy()
    expect(cellRow("cell-ch2-b")).toBeTruthy()

    act(() => {
      setMilestoneSplit(true)
    })

    expect(cellRow("cell-ch1-a")).toBeTruthy()
    expect(cellRow("cell-ch1-b")).toBeTruthy()
    expect(cellRow("cell-ch2-a")).toBeNull()
    expect(cellRow("cell-ch2-b")).toBeNull()
  })

  it("turns the page with the next-chapter arrow while split is on", () => {
    setMilestoneSplit(true)
    renderTable()
    fireEvent.click(screen.getByRole("button", { name: "Next chapter" }))

    expect(cellRow("cell-ch1-a")).toBeNull()
    expect(cellRow("cell-ch1-b")).toBeNull()
    expect(cellRow("cell-ch2-a")).toBeTruthy()
    expect(cellRow("cell-ch2-b")).toBeTruthy()
  })

  it("keeps every cell of a long IDML section on one page", () => {
    const boxes = Array.from({ length: 74 }, (_, index) => ({
      id: `cell-box-${index + 1}`,
      milestone: {
        key: "ebl:boxes:1",
        kind: "section" as const,
        label: "Boxes and tables",
        shortLabel: "B",
      },
    }))
    const intro = [
      {
        id: "cell-intro-1",
        milestone: {
          key: "ebl:section:1:intro",
          kind: "section" as const,
          label: "INTRODUCTION",
          shortLabel: "1",
        },
      },
    ]

    const rows = [...boxes, ...intro].flatMap(({ id, milestone }, i) => [
      {
        cellId: id,
        side: "source" as const,
        value: `source ${i}`,
        valueHtml: null,
        type: "text",
        canonicalRef: null,
        anchorCellId: null,
        eventId: `${id}-source`,
        sourceEventId: null,
        lastEditor: null,
        lastEditAt: 1,
        validated: false,
        wordCount: 1,
        metadata: { aquillaImport: { milestone } },
      },
      {
        cellId: id,
        side: "target" as const,
        value: `target ${i}`,
        valueHtml: null,
        type: "text",
        canonicalRef: null,
        anchorCellId: null,
        eventId: `${id}-target`,
        sourceEventId: `${id}-source`,
        lastEditor: "tester",
        lastEditAt: 2,
        validated: false,
        wordCount: 1,
        metadata: { aquillaImport: { milestone } },
      },
    ])

    const store = new CellStore()
    store.setRuntime({
      projectId: project.id,
      fileId: "file-1",
      username: "tester",
      requiredValidations: 1,
      auditStats: new Map(),
    })
    store.replaceRows(rows, { full: true, maxServerSeq: 1 })

    const qc = new QueryClient()
    render(
      <QueryClientProvider client={qc}>
        <EditorActionsProvider value={{}}>
          <EditorTable
            project={project}
            cellStore={store}
            fileType="idml"
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

    act(() => {
      setMilestoneSplit(true)
    })

    expect(cellRow("cell-box-1")).toBeTruthy()
    expect(cellRow("cell-box-50")).toBeTruthy()
    expect(cellRow("cell-box-51")).toBeTruthy()
    expect(cellRow("cell-box-74")).toBeTruthy()
    expect(cellRow("cell-intro-1")).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Next section" }))

    expect(cellRow("cell-box-1")).toBeNull()
    expect(cellRow("cell-box-74")).toBeNull()
    expect(cellRow("cell-intro-1")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Next section" })).toBeDisabled()
  })

  it("restores the continuous file when the preference is turned off", () => {
    setMilestoneSplit(true)
    renderTable()
    fireEvent.click(screen.getByRole("button", { name: "Next chapter" }))
    act(() => {
      setMilestoneSplit(false)
    })

    expect(cellRow("cell-ch1-a")).toBeTruthy()
    expect(cellRow("cell-ch1-b")).toBeTruthy()
    expect(cellRow("cell-ch2-a")).toBeTruthy()
    expect(cellRow("cell-ch2-b")).toBeTruthy()
  })
})

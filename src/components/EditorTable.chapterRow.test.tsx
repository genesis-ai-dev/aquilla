/**
 * Chapter picker + file options sit in an in-editor row above Source/Target,
 * not in the shell breadcrumb. Import/Settings stay in the header.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { EditorTable } from "./EditorTable"
import { EditorActionsProvider } from "@/context/EditorActionsContext"
import { CellStore } from "@/hooks/useActiveCellStore"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { CellRow } from "@/lib/sync/cells-read-types"
import { toast, Toaster } from "@/components/ui/toast"
import { CHAPTER_COMPLETE_TOAST_ID } from "@/hooks/useChapterCompletionAdvance"
import {
  resetChapterPagePrefCacheForTests,
} from "@/lib/store/chapter-page-pref"

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

afterEach(() => {
  toast.close(CHAPTER_COMPLETE_TOAST_ID)
  localStorage.clear()
  resetChapterPagePrefCacheForTests()
  cleanup()
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

function makeRows(id: string, canonicalRef = "GEN 1:1", target = "bonjour"): CellRow[] {
  return [
    {
      cellId: id, side: "source", value: "hello", valueHtml: null, type: "text",
      canonicalRef, anchorCellId: null, eventId: `${id}-source`,
      sourceEventId: null, lastEditor: null, lastEditAt: 1, validated: false, wordCount: 1,
    },
    {
      cellId: id, side: "target", value: target, valueHtml: null, type: "text",
      canonicalRef, anchorCellId: null, eventId: `${id}-target`,
      sourceEventId: `${id}-source`, lastEditor: target ? "tester" : null, lastEditAt: 2, validated: false, wordCount: 1,
    },
  ]
}

function renderTable(
  trailing?: ReactNode,
  options?: {
    paging?: boolean
    toaster?: boolean
    rows?: CellRow[]
    onPageCellIdsChange?: (cellIds: string[] | null) => void
    onVisibleCellIdsChange?: (cellIds: string[]) => void
  },
) {
  const store = new CellStore()
  store.setRuntime({
    projectId: project.id,
    fileId: "file-1",
    username: "tester",
    requiredValidations: 1,
    auditStats: new Map(),
  })
  store.replaceRows(options?.rows ?? makeRows("cell-1"), { full: true, maxServerSeq: 1 })
  const qc = new QueryClient()
  return render(
    <QueryClientProvider client={qc}>
      {options?.toaster ? <Toaster /> : null}
      <EditorActionsProvider value={{}}>
        <EditorTable
          project={{
            ...project,
            ...(options?.paging ? { chapterPagingEnabled: true } : {}),
          }}
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
          onPageCellIdsChange={options?.onPageCellIdsChange}
          onVisibleCellIdsChange={options?.onVisibleCellIdsChange}
          healthMap={new Map()}
          lineNumbersEnabled={false}
          cellLabelsEnabled={false}
          sourceTextDirection="ltr"
          targetTextDirection="ltr"
          chapterNavTrailing={trailing}
        />
      </EditorActionsProvider>
    </QueryClientProvider>,
  )
}

describe("EditorTable chapter row", () => {
  it("renders the chapter picker and file options above Source/Target, in the editor", () => {
    renderTable(<div data-testid="file-chapter-toolbar">File options</div>)

    const row = screen.getByTestId("editor-chapter-row")
    const targetHeader = screen.getByTestId("table-target-header")
    expect(row).toContainElement(screen.getByTestId("file-chapter-toolbar"))
    expect(row.compareDocumentPosition(targetHeader) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(row.className).toContain("py-2")
    expect(row.className).toContain("ps-4")
    expect(row.className).toContain("pe-2")
    expect(screen.getByRole("navigation", { name: "Milestone navigation" })).toBeVisible()
    expect(screen.getByRole("combobox", { name: /Current chapter/ })).toBeVisible()
  })

  it("keeps every chapter in the table when paging is off", () => {
    renderTable(undefined, {
      rows: [
        ...makeRows("gen1-1", "GEN 1:1"),
        ...makeRows("gen1-2", "GEN 1:2"),
        ...makeRows("gen2-1", "GEN 2:1"),
        ...makeRows("gen3-1", "GEN 3:1"),
      ],
    })

    expect(document.querySelector("[data-cell-id='gen1-1']")).toBeTruthy()
    expect(document.querySelector("[data-cell-id='gen1-2']")).toBeTruthy()
    expect(document.querySelector("[data-cell-id='gen2-1']")).toBeTruthy()
  })

  it("shows only the navigator chapter's rows when paging is on, and Next swaps them", () => {
    renderTable(undefined, {
      paging: true,
      rows: [
        ...makeRows("gen1-1", "GEN 1:1"),
        ...makeRows("gen1-2", "GEN 1:2"),
        ...makeRows("gen2-1", "GEN 2:1"),
        ...makeRows("gen3-1", "GEN 3:1"),
      ],
    })

    expect(screen.getByRole("combobox", { name: /Current chapter: Genesis 1/ })).toBeVisible()
    expect(document.querySelector("[data-cell-id='gen1-1']")).toBeTruthy()
    expect(document.querySelector("[data-cell-id='gen1-2']")).toBeTruthy()
    expect(document.querySelector("[data-cell-id='gen2-1']")).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Next chapter" }))

    expect(screen.getByRole("combobox", { name: /Current chapter: Genesis 2/ })).toBeVisible()
    expect(document.querySelector("[data-cell-id='gen1-1']")).toBeNull()
    expect(document.querySelector("[data-cell-id='gen1-2']")).toBeNull()
    expect(document.querySelector("[data-cell-id='gen2-1']")).toBeTruthy()
  })

  it("reports the open chapter as the work context when paging is on", () => {
    const onPageCellIdsChange = vi.fn()
    const onVisibleCellIdsChange = vi.fn()
    renderTable(undefined, {
      paging: true,
      onPageCellIdsChange,
      onVisibleCellIdsChange,
      rows: [
        ...makeRows("gen1-1", "GEN 1:1"),
        ...makeRows("gen1-2", "GEN 1:2"),
        ...makeRows("gen2-1", "GEN 2:1"),
        ...makeRows("gen3-1", "GEN 3:1"),
      ],
    })

    expect(onPageCellIdsChange).toHaveBeenCalledWith(["gen1-1", "gen1-2"])
    expect(onVisibleCellIdsChange).toHaveBeenCalledWith(["gen1-1", "gen1-2"])
    expect(onPageCellIdsChange.mock.calls.at(-1)?.[0]).not.toContain("gen2-1")

    fireEvent.click(screen.getByRole("button", { name: "Next chapter" }))

    expect(onPageCellIdsChange).toHaveBeenCalledWith(["gen2-1"])
    expect(onVisibleCellIdsChange).toHaveBeenCalledWith(["gen2-1"])
  })

  it("offers Next chapter when the open page is already complete", () => {
    renderTable(undefined, {
      paging: true,
      toaster: true,
      rows: [
        ...makeRows("gen1-1", "GEN 1:1"),
        ...makeRows("gen1-2", "GEN 1:2"),
        ...makeRows("gen2-1", "GEN 2:1"),
        ...makeRows("gen3-1", "GEN 3:1"),
      ],
    })

    expect(screen.getByText("Genesis 1 is complete")).toBeVisible()
    const toastNext = screen.getAllByRole("button", { name: "Next chapter" }).find(
      (button) => button.closest("[data-slot='toast']"),
    )
    expect(toastNext).toBeTruthy()
    fireEvent.click(toastNext!)

    expect(screen.getByRole("combobox", { name: /Current chapter: Genesis 2/ })).toBeVisible()
    expect(document.querySelector("[data-cell-id='gen2-1']")).toBeTruthy()
    expect(screen.queryByText("Genesis 1 is complete")).toBeNull()
    expect(screen.getByText("Genesis 2 is complete")).toBeVisible()
    expect(document.querySelectorAll("[data-slot='toast']")).toHaveLength(1)
    expect(document.querySelector("[data-pulsing]")).toBeNull()
  })

  it("retitles the same toast when the next chapter is also complete", () => {
    renderTable(undefined, {
      paging: true,
      toaster: true,
      rows: [
        ...makeRows("gen1-1", "GEN 1:1"),
        ...makeRows("gen1-2", "GEN 1:2"),
        ...makeRows("gen2-1", "GEN 2:1"),
        ...makeRows("gen3-1", "GEN 3:1"),
      ],
    })

    const navNext = screen.getAllByRole("button", { name: "Next chapter" }).find(
      (button) => !button.closest("[data-slot='toast']"),
    )
    expect(navNext).toBeTruthy()
    fireEvent.click(navNext!)

    expect(screen.getByRole("combobox", { name: /Current chapter: Genesis 2/ })).toBeVisible()
    expect(screen.queryByText("Genesis 1 is complete")).toBeNull()
    expect(screen.getByText("Genesis 2 is complete")).toBeVisible()
    expect(document.querySelectorAll("[data-slot='toast']")).toHaveLength(1)
    expect(document.querySelector("[data-pulsing]")).toBeNull()
  })

  it("dismisses the toast when the next chapter is not complete", () => {
    renderTable(undefined, {
      paging: true,
      toaster: true,
      rows: [
        ...makeRows("gen1-1", "GEN 1:1"),
        ...makeRows("gen1-2", "GEN 1:2"),
        ...makeRows("gen2-1", "GEN 2:1", ""),
      ],
    })

    expect(screen.getByText("Genesis 1 is complete")).toBeVisible()
    const navNext = screen.getAllByRole("button", { name: "Next chapter" }).find(
      (button) => !button.closest("[data-slot='toast']"),
    )
    expect(navNext).toBeTruthy()
    fireEvent.click(navNext!)

    expect(screen.getByRole("combobox", { name: /Current chapter: Genesis 2/ })).toBeVisible()
    expect(screen.queryByText("Genesis 1 is complete")).toBeNull()
    expect(screen.queryByText("Genesis 2 is complete")).toBeNull()
  })

  it("restores the last open chapter after the editor remounts", () => {
    const rows = [
      ...makeRows("gen1-1", "GEN 1:1"),
      ...makeRows("gen1-2", "GEN 1:2"),
      ...makeRows("gen2-1", "GEN 2:1"),
    ]
    const { unmount } = renderTable(undefined, { paging: true, rows })

    fireEvent.click(screen.getByRole("button", { name: "Next chapter" }))
    expect(screen.getByRole("combobox", { name: /Current chapter: Genesis 2/ })).toBeVisible()
    unmount()

    renderTable(undefined, { paging: true, rows })

    expect(screen.getByRole("combobox", { name: /Current chapter: Genesis 2/ })).toBeVisible()
    expect(document.querySelector("[data-cell-id='gen1-1']")).toBeNull()
    expect(document.querySelector("[data-cell-id='gen2-1']")).toBeTruthy()
  })
})

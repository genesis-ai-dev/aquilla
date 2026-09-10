/**
 * AQU-1244: a section scroll request (the Files panel's chapter rows, and the
 * contextual-run pill's range chips) must turn the editor to the milestone that
 * contains the section when "Split into milestones" is on.
 *
 * The handler used to resolve the request to a row index counted over the WHOLE
 * file and call scrollToCellIndex. With the split on, the editor renders only
 * the current milestone's rows, so that index was either out of range (the
 * request was silently dropped — clicking a later chapter did nothing) or
 * pointed at an unrelated row of the page already showing. Neither changed the
 * selected milestone. Resolving to a cell ID and going through scrollToCellId
 * turns the page.
 */

import { describe, it, expect, beforeEach, vi } from "vitest"
import { act, render, screen, fireEvent } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRef, useEffect, type ReactNode } from "react"
import { EditorTable, type EditorTableHandle } from "./EditorTable"
import { ScrollToGroupHandler } from "./ScrollToGroupHandler"
import { EditorActionsProvider } from "@/context/EditorActionsContext"
import { EditorScrollProvider, useEditorScroll } from "@/context/EditorScrollContext"
import { CellStore } from "@/hooks/useActiveCellStore"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { CellRow } from "@/lib/sync/cells-read-types"
import {
  resetMilestoneSplitCacheForTests,
  setMilestoneSplit,
} from "@/lib/store/milestone-split-pref"

// happy-dom has no layout engine — render every row and capture scrollToIndex.
const scrollToIndex = vi.fn(async () => undefined)
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
        scrollToIndex,
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

const FILE_ID = "file-1"

const project: ProjectRecord = {
  id: "proj-1",
  name: "Test Project",
  sourceLanguage: "en",
  targetLanguage: "fr",
  createdAt: "2026-01-01T00:00:00Z",
  files: [],
  members: [],
}

// Three chapters, two verses each — enough to jump forwards (ch1 → ch3) and
// backwards (ch2 → ch1), which are the two failure shapes in the report.
const CELLS = [
  { id: "cell-ch1-a", ref: "GEN 1:1" },
  { id: "cell-ch1-b", ref: "GEN 1:2" },
  { id: "cell-ch2-a", ref: "GEN 2:1" },
  { id: "cell-ch2-b", ref: "GEN 2:2" },
  { id: "cell-ch3-a", ref: "GEN 3:1" },
  { id: "cell-ch3-b", ref: "GEN 3:2" },
] as const

function makeStore(): CellStore {
  const rows: CellRow[] = CELLS.flatMap(({ id, ref }, i) => [
    {
      cellId: id, side: "source", value: `source ${i}`, valueHtml: null, type: "text",
      canonicalRef: ref, anchorCellId: null, eventId: `${id}-source`, sourceEventId: null,
      lastEditor: null, lastEditAt: 1, validated: false, wordCount: 1,
    },
    {
      cellId: id, side: "target", value: `target ${i}`, valueHtml: null, type: "text",
      canonicalRef: ref, anchorCellId: null, eventId: `${id}-target`, sourceEventId: `${id}-source`,
      lastEditor: "tester", lastEditAt: 2, validated: false, wordCount: 1,
    },
  ] satisfies CellRow[])

  const store = new CellStore()
  store.setRuntime({
    projectId: project.id,
    fileId: FILE_ID,
    username: "tester",
    requiredValidations: 1,
    auditStats: new Map(),
  })
  store.replaceRows(rows, { full: true, maxServerSeq: 1 })
  return store
}

type RequestSection = (label: string, fileId: string) => void

function SectionRequestProbe({ captureRef }: { captureRef: { current: RequestSection | null } }) {
  const { requestScrollToSection } = useEditorScroll()
  useEffect(() => {
    captureRef.current = requestScrollToSection
  }, [captureRef, requestScrollToSection])
  return null
}

function renderWorkspace(store: CellStore) {
  const editorRef = createRef<EditorTableHandle>()
  const requestSection: { current: RequestSection | null } = { current: null }
  const qc = new QueryClient()
  render(
    <QueryClientProvider client={qc}>
      <EditorActionsProvider value={{}}>
        <EditorScrollProvider>
          <SectionRequestProbe captureRef={requestSection} />
          <ScrollToGroupHandler cellStore={store} storeVersion={1} editorRef={editorRef} />
          <EditorTable
            ref={editorRef}
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
        </EditorScrollProvider>
      </EditorActionsProvider>
    </QueryClientProvider>,
  )
  return { editorRef, requestSection }
}

function cellRow(id: string) {
  return document.querySelector(`[data-cell-id="${id}"]`)
}

/** The label the Files panel / run pill submit for a chapter, read off the
 *  store's own navigation index so the test does not hard-code the key shape. */
function sectionKey(store: CellStore, chapterIndex: number): string {
  const entry = store.getNavigationIndex()[chapterIndex]
  expect(entry).toBeTruthy()
  return entry.key
}

async function requestSectionScroll(request: RequestSection | null, label: string) {
  expect(request).toBeTruthy()
  act(() => {
    request?.(label, FILE_ID)
  })
  // The handler defers the jump a tick so the list has the latest cell ids.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

describe("ScrollToGroupHandler — section requests (AQU-1244)", () => {
  beforeEach(() => {
    localStorage.clear()
    resetMilestoneSplitCacheForTests()
    setMilestoneSplit(false)
    scrollToIndex.mockClear()
  })

  it("turns to the requested milestone when the split is on and the target is a later page", async () => {
    setMilestoneSplit(true)
    const store = makeStore()
    const { requestSection } = renderWorkspace(store)

    // Page 1 is showing; chapter 3's rows are not rendered.
    expect(cellRow("cell-ch1-a")).toBeTruthy()
    expect(cellRow("cell-ch3-a")).toBeNull()

    await requestSectionScroll(requestSection.current, sectionKey(store, 2))

    expect(cellRow("cell-ch3-a")).toBeTruthy()
    expect(cellRow("cell-ch3-b")).toBeTruthy()
    expect(cellRow("cell-ch1-a")).toBeNull()
    expect(cellRow("cell-ch2-a")).toBeNull()
  })

  it("turns back to an earlier milestone instead of scrolling within the current page", async () => {
    setMilestoneSplit(true)
    const store = makeStore()
    const { requestSection } = renderWorkspace(store)
    fireEvent.click(screen.getByRole("button", { name: "Next chapter" }))
    expect(cellRow("cell-ch2-a")).toBeTruthy()

    // Chapter 1's whole-file index (0) is a valid index on the chapter-2 page —
    // the old index path scrolled to a row of chapter 2 instead of turning back.
    await requestSectionScroll(requestSection.current, sectionKey(store, 0))

    expect(cellRow("cell-ch1-a")).toBeTruthy()
    expect(cellRow("cell-ch1-b")).toBeTruthy()
    expect(cellRow("cell-ch2-a")).toBeNull()
  })

  it("still scrolls the continuous file to the section's first cell when the split is off", async () => {
    const store = makeStore()
    const { requestSection } = renderWorkspace(store)

    // Every cell is rendered — no paging.
    expect(cellRow("cell-ch1-a")).toBeTruthy()
    expect(cellRow("cell-ch3-a")).toBeTruthy()

    scrollToIndex.mockClear()
    await requestSectionScroll(requestSection.current, sectionKey(store, 1))

    // cell-ch2-a is the third row of the continuous file.
    expect(scrollToIndex).toHaveBeenCalledWith(expect.objectContaining({ index: 2 }))
    expect(cellRow("cell-ch1-a")).toBeTruthy()
    expect(cellRow("cell-ch3-a")).toBeTruthy()
  })
})

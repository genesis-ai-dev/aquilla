/**
 * AQU-1245: an "Assigned to me" jump and a recording-modal cell change must
 * turn the editor to the milestone that holds the target when "Split into
 * milestones" is on.
 *
 * Both callers used to resolve their target to a row index counted over the
 * WHOLE file and call `scrollToCellIndex`. With the split on the editor renders
 * only the current milestone's rows, so that index was either out of range (the
 * scroll was silently dropped — the jump did nothing) or pointed at an
 * unrelated row of the page already showing. Neither turned the page.
 *
 * This drives the real lookups from `lib/editor/milestone-jump-targets.ts`
 * through the editor's ID-based scroll, which is the change, and asserts the
 * page turns; with the split off it asserts the continuous file still scrolls
 * to the same row.
 */

import { describe, it, expect, beforeEach, vi } from "vitest"
import { act, render } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRef, type ReactNode, type RefObject } from "react"
import { EditorTable, type EditorTableHandle } from "./EditorTable"
import { EditorActionsProvider } from "@/context/EditorActionsContext"
import { CellStore } from "@/hooks/useActiveCellStore"
import {
  resolveRecordingRowCellId,
  resolveScopeLabelCellId,
} from "@/lib/editor/milestone-jump-targets"
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
        getState: () => ({
          scroll: 0,
          positionAtIndex: (index: number) => index * 140,
          sizeAtIndex: () => 140,
        }),
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

const project: ProjectRecord = {
  id: "proj-1",
  name: "Test Project",
  sourceLanguage: "en",
  targetLanguage: "fr",
  createdAt: "2026-01-01T00:00:00Z",
  files: [],
  members: [],
}

// Three chapters, two verses each: enough to advance off the end of chapter 1
// and to jump forward to a chapter that is two pages away.
const CELLS = [
  { id: "cell-ch1-a", ref: "1TH 1:1" },
  { id: "cell-ch1-b", ref: "1TH 1:2" },
  { id: "cell-ch2-a", ref: "1TH 2:1" },
  { id: "cell-ch2-b", ref: "1TH 2:2" },
  { id: "cell-ch3-a", ref: "1TH 3:1" },
  { id: "cell-ch3-b", ref: "1TH 3:2" },
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
    fileId: "file-1",
    username: "tester",
    requiredValidations: 1,
    auditStats: new Map(),
  })
  store.replaceRows(rows, { full: true, maxServerSeq: 1 })
  return store
}

function renderTable(store: CellStore): RefObject<EditorTableHandle | null> {
  const ref = createRef<EditorTableHandle>()
  const qc = new QueryClient()
  render(
    <QueryClientProvider client={qc}>
      <EditorActionsProvider value={{ myScopes: [] }}>
        <EditorTable
          ref={ref}
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
  return ref
}

function cellRow(id: string) {
  return document.querySelector(`[data-cell-id="${id}"]`)
}

/** The label the store's own navigation index uses for a chapter, so the test
 *  does not hard-code the section key shape. */
function chapterLabel(store: CellStore, chapterIndex: number): string {
  const entry = store.getNavigationIndex()[chapterIndex]
  expect(entry).toBeTruthy()
  return entry.label
}

describe("milestone jump targets reach their page (AQU-1245)", () => {
  beforeEach(() => {
    localStorage.clear()
    resetMilestoneSplitCacheForTests()
    setMilestoneSplit(false)
    scrollToIndex.mockClear()
  })

  it("turns to the assignment's chapter when its scope is off the current page", () => {
    setMilestoneSplit(true)
    const store = makeStore()
    const ref = renderTable(store)

    // Page 1 is showing; chapter 3's rows are not rendered at all.
    expect(cellRow("cell-ch1-a")).toBeTruthy()
    expect(cellRow("cell-ch3-a")).toBeNull()

    const target = resolveScopeLabelCellId(store, `${chapterLabel(store, 2)} in 1TH.usfm`)
    expect(target).toBe("cell-ch3-a")
    act(() => {
      ref.current?.scrollToCellId(target!)
    })

    expect(cellRow("cell-ch3-a")).toBeTruthy()
    expect(cellRow("cell-ch3-b")).toBeTruthy()
    expect(cellRow("cell-ch1-a")).toBeNull()
  })

  it("turns BACK to an earlier chapter instead of scrolling within the page on screen", () => {
    setMilestoneSplit(true)
    const store = makeStore()
    const ref = renderTable(store)

    act(() => {
      ref.current?.scrollToCellId("cell-ch3-a")
    })
    expect(cellRow("cell-ch3-a")).toBeTruthy()

    // Chapter 1's whole-file index (0) is a valid index on the chapter-3 page —
    // the old index path scrolled to a row of chapter 3 instead of turning back.
    const target = resolveScopeLabelCellId(store, chapterLabel(store, 0))
    expect(target).toBe("cell-ch1-a")
    act(() => {
      ref.current?.scrollToCellId(target!)
    })

    expect(cellRow("cell-ch1-a")).toBeTruthy()
    expect(cellRow("cell-ch3-a")).toBeNull()
  })

  it("turns the table behind the recording modal when the take advances into the next chapter", () => {
    setMilestoneSplit(true)
    const store = makeStore()
    const ref = renderTable(store)
    expect(cellRow("cell-ch2-a")).toBeNull()

    // Next / auto-advance off the last verse of chapter 1.
    const target = resolveRecordingRowCellId({ cellId: "cell-ch2-a", isCueArrangement: false })
    act(() => {
      ref.current?.scrollToCellId(target!)
    })

    expect(cellRow("cell-ch2-a")).toBeTruthy()
    expect(cellRow("cell-ch1-a")).toBeNull()
  })

  it("turns to the page holding a cue's linked subtitle row", () => {
    setMilestoneSplit(true)
    const store = makeStore()
    const ref = renderTable(store)

    const target = resolveRecordingRowCellId({
      cellId: "cue-7",
      isCueArrangement: true,
      linkedTextIds: ["cell-ch3-b"],
    })
    expect(target).toBe("cell-ch3-b")
    act(() => {
      ref.current?.scrollToCellId(target!)
    })

    expect(cellRow("cell-ch3-b")).toBeTruthy()
    expect(cellRow("cell-ch1-a")).toBeNull()
  })

  it("still scrolls the continuous file to the same row when the split is off", () => {
    const store = makeStore()
    const ref = renderTable(store)

    // Nothing is paged — every row is rendered.
    expect(cellRow("cell-ch1-a")).toBeTruthy()
    expect(cellRow("cell-ch3-a")).toBeTruthy()

    scrollToIndex.mockClear()
    const target = resolveScopeLabelCellId(store, chapterLabel(store, 1))
    act(() => {
      ref.current?.scrollToCellId(target!)
    })

    // cell-ch2-a is the third row of the continuous file — the row the
    // index-based path reached before.
    expect(scrollToIndex).toHaveBeenCalledWith(expect.objectContaining({ index: 2 }))
    expect(cellRow("cell-ch1-a")).toBeTruthy()
    expect(cellRow("cell-ch3-a")).toBeTruthy()
  })
})

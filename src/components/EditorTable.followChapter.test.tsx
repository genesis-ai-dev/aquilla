/**
 * AQU-1758: during Play all the table follows the line playing, and its
 * chapter picker says that line's chapter. When playback crosses from one
 * chapter into the next (Ruth 1 → Ruth 2), the picker switches the moment the
 * new chapter's first line starts — not once the old chapter's last rows have
 * scrolled off the top. The follow keeps the running row about a third of the
 * way down the table, so for a while after the crossing the row at the top is
 * still the old chapter's.
 *
 * happy-dom has no layout, so the table's top row never moves here: that is
 * exactly the moment just after the crossing, before the old rows scroll away.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { EditorTable } from "./EditorTable"
import { EditorActionsProvider } from "@/context/EditorActionsContext"
import { CellStore } from "@/hooks/useActiveCellStore"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { CellRow } from "@/lib/sync/cells-read-types"
import { setMediaSyncActive } from "@/lib/timeline/media-cursor"
import { resetMilestoneSplitCacheForTests, setMilestoneSplit } from "@/lib/store/milestone-split-pref"

// The line the queue is running, as a store the follow driver subscribes to.
const queueStub = vi.hoisted(() => ({
  runningCellId: null as string | null,
  listeners: new Set<() => void>(),
}))
vi.mock("@/lib/audio/play-queue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/audio/play-queue")>()
  const { useSyncExternalStore } = await import("react")
  return {
    ...actual,
    useQueueCurrentCellId: () =>
      useSyncExternalStore(
        (l: () => void) => {
          queueStub.listeners.add(l)
          return () => queueStub.listeners.delete(l)
        },
        () => queueStub.runningCellId,
        () => null,
      ),
  }
})

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

const project: ProjectRecord = {
  id: "proj-1",
  name: "Test Project",
  sourceLanguage: "en",
  targetLanguage: "fr",
  createdAt: "2026-01-01T00:00:00Z",
  files: [],
  members: [],
}

// Ruth 1 has three verses, Ruth 2 two.
const CELLS = [
  { id: "rut-1-1", ref: "RUT 1:1" },
  { id: "rut-1-2", ref: "RUT 1:2" },
  { id: "rut-1-3", ref: "RUT 1:3" },
  { id: "rut-2-1", ref: "RUT 2:1" },
  { id: "rut-2-2", ref: "RUT 2:2" },
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

function renderTable(store: CellStore, onActiveChapterChange?: (key: string | null) => void) {
  const qc = new QueryClient()
  return render(
    <QueryClientProvider client={qc}>
      <EditorActionsProvider value={{ myScopes: [] }}>
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
          onActiveChapterChange={onActiveChapterChange}
        />
      </EditorActionsProvider>
    </QueryClientProvider>,
  )
}

const setRunning = (cellId: string | null) => {
  act(() => {
    queueStub.runningCellId = cellId
    for (const l of queueStub.listeners) l()
  })
}

/** The picker's own label for a chapter, from the store's navigation index. */
function chapterLabel(store: CellStore, chapterIndex: number): string {
  const entry = store.getNavigationIndex()[chapterIndex]
  expect(entry).toBeTruthy()
  return entry.label
}

const picker = () => screen.getByRole("combobox", { name: /^Current chapter: / })

describe("the chapter picker follows the line playing (AQU-1758)", () => {
  beforeEach(() => {
    localStorage.clear()
    resetMilestoneSplitCacheForTests()
    setMilestoneSplit(false)
    queueStub.runningCellId = null
    queueStub.listeners.clear()
    // The timeline is stacked above the table, so the table follows playback.
    setMediaSyncActive(true)
  })
  afterEach(() => {
    cleanup()
    setMediaSyncActive(false)
  })

  it("switches to the next chapter the moment its first line starts", () => {
    const store = makeStore()
    const ruth1 = chapterLabel(store, 0)
    const ruth2 = chapterLabel(store, 1)
    const reported = vi.fn()
    renderTable(store, reported)
    expect(picker()).toHaveAccessibleName(`Current chapter: ${ruth1}. Choose chapter`)

    setRunning("rut-1-2")
    setRunning("rut-1-3")
    expect(picker()).toHaveAccessibleName(`Current chapter: ${ruth1}. Choose chapter`)

    // Play all crosses into Ruth 2; the top row of the table is still Ruth 1's.
    setRunning("rut-2-1")
    expect(picker()).toHaveAccessibleName(`Current chapter: ${ruth2}. Choose chapter`)
    // …and the workspace hears it, so the timeline shows the same chapter.
    expect(reported).toHaveBeenLastCalledWith(store.getNavigationIndex()[1].key)
  })

  it("a scroll by hand afterwards goes back to naming the chapter on screen", () => {
    const store = makeStore()
    const ruth1 = chapterLabel(store, 0)
    const ruth2 = chapterLabel(store, 1)
    renderTable(store)
    setRunning("rut-2-1")
    expect(picker()).toHaveAccessibleName(`Current chapter: ${ruth2}. Choose chapter`)

    // Playback stops and the person scrolls: the picker names the top row's
    // chapter again (here, with no layout, still Ruth 1's first row).
    setRunning(null)
    fireEvent.wheel(document.querySelector('[data-cell-id="rut-1-1"]')!)
    expect(picker()).toHaveAccessibleName(`Current chapter: ${ruth1}. Choose chapter`)
  })
})

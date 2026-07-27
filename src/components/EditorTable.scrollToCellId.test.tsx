/**
 * AQU-646 round 3: EditorTableHandle.scrollToCellId — id-based scroll in
 * DISPLAY space. The old index path resolved cellStore.findIndexByCellId
 * (STORE order), but time-ordered files re-sort rows by timing for display,
 * so search/presence jumps could land on the wrong row. This locks in the
 * display-space resolution + the optional flash.
 */

import { describe, it, expect, vi } from "vitest"
import { render } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRef } from "react"
import type { ReactNode } from "react"
import { EditorTable, type EditorTableHandle } from "./EditorTable"
import { EditorActionsProvider } from "@/context/EditorActionsContext"
import { CellStore } from "@/hooks/useActiveCellStore"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { CellRow } from "@/lib/sync/cells-read-types"
import { ROLE } from "@/lib/frontier/roles"

vi.mock("@/lib/sync/events-emit", () => ({
  emitCellValidate: vi.fn(() => Promise.resolve("validate-event")),
  emitCellUnvalidate: vi.fn(() => Promise.resolve("unvalidate-event")),
  emitTargetCellCommit: vi.fn(() => Promise.resolve("commit-event")),
  emitSourceCellCommit: vi.fn(() => Promise.resolve("source-event")),
  emitCellWaive: vi.fn(() => Promise.resolve("waive-event")),
  emitCellUnwaive: vi.fn(() => Promise.resolve("unwaive-event")),
}))

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

const project: ProjectRecord = {
  id: "proj-1",
  name: "Test Project",
  sourceLanguage: "en",
  targetLanguage: "fr",
  createdAt: "2026-01-01T00:00:00Z",
  files: [],
  members: [],
  syncRole: { level: ROLE.PROJECT_LEAD, name: "test", source: "server", fetchedAt: "2026-01-01T00:00:00Z" },
}

function mediaRow(cellId: string, startMs: number, endMs: number): CellRow {
  return {
    cellId, side: "source", value: `sec-${cellId}`, valueHtml: null, type: "text",
    canonicalRef: null, anchorCellId: null, eventId: `${cellId}-source`,
    sourceEventId: null, lastEditor: null, lastEditAt: 1, validated: false, wordCount: 1,
    medium: "media", startMs, endMs,
  } as CellRow
}

function makeStore(rows: CellRow[]): CellStore {
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

function renderTable(store: CellStore) {
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
          activeLane=""
          orderedBy="time"
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

describe("EditorTableHandle.scrollToCellId (AQU-646)", () => {
  it("resolves the DISPLAY index on a time-ordered file whose store order ≠ time order", () => {
    // Store order: late, early — display (time) order re-sorts to early, late.
    const ref = renderTable(makeStore([
      mediaRow("late", 10_000, 20_000),
      mediaRow("early", 0, 10_000),
    ]))
    scrollToIndex.mockClear()
    const ok = ref.current?.scrollToCellId("late")
    expect(ok).toBe(true)
    // Display index of "late" is 1 (store index would be 0 — the old bug).
    expect(scrollToIndex).toHaveBeenCalledWith(expect.objectContaining({ index: 1 }))
  })

  it("flash adds the codex-search-flash ring after a frame", async () => {
    const ref = renderTable(makeStore([mediaRow("m1", 0, 5_000)]))
    const ok = ref.current?.scrollToCellId("m1", { flash: true })
    expect(ok).toBe(true)
    await new Promise((r) => requestAnimationFrame(() => r(null)))
    await new Promise((r) => requestAnimationFrame(() => r(null)))
    const el = document.querySelector('[data-cell-id="m1"]')
    expect(el?.classList.contains("codex-search-flash")).toBe(true)
  })

  it("returns false for an unknown id", () => {
    const ref = renderTable(makeStore([mediaRow("m1", 0, 5_000)]))
    expect(ref.current?.scrollToCellId("nope")).toBe(false)
  })
})

/**
 * AQU-1118: a caption row's "Play from this cue" button shows Pause while that
 * row's line is the one playing, and pressing it pauses. "Playing" arrives as
 * the bottom bar's current line (`playingCueCellId`), so the table only has to
 * follow it.
 */

import { describe, it, expect, vi } from "vitest"
import { fireEvent, render, screen, within } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { EditorTable } from "./EditorTable"
import { EditorActionsProvider } from "@/context/EditorActionsContext"
import { CellStore } from "@/hooks/useActiveCellStore"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { CellRow } from "@/lib/sync/cells-read-types"
import { ROLE } from "@/lib/frontier/roles"

vi.mock("@/hooks/useDcsUpstreamCursor", () => ({
  useDcsUpstreamCursor: () => ({ cursor: null, loading: false }),
}))

vi.mock("@/lib/sync/events-emit", () => ({
  emitCellValidate: vi.fn(() => Promise.resolve("validate-event")),
  emitCellUnvalidate: vi.fn(() => Promise.resolve("unvalidate-event")),
  emitTargetCellCommit: vi.fn(() => Promise.resolve("commit-event")),
  emitSourceCellCommit: vi.fn(() => Promise.resolve("source-event")),
  emitCellWaive: vi.fn(() => Promise.resolve("waive-event")),
  emitCellUnwaive: vi.fn(() => Promise.resolve("unwaive-event")),
}))

// happy-dom has no layout engine — render every row (same shim as the other
// EditorTable tests).
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
  syncRole: { level: ROLE.PROJECT_LEAD, name: "test", source: "server", fetchedAt: "2026-01-01T00:00:00Z" },
}

function cueRow(cellId: string, value: string, startMs: number, endMs: number): CellRow {
  return {
    cellId, side: "source", value, valueHtml: null, type: "text",
    canonicalRef: null, anchorCellId: null, eventId: `${cellId}-source`,
    sourceEventId: null, lastEditor: null, lastEditAt: 1, validated: false, wordCount: 2,
    medium: "text", startMs, endMs,
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

function table(store: CellStore, props: {
  playingCueCellId: string | null
  onSeekToCue: (cellId: string) => void
  onPauseCue: () => void
}) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <EditorActionsProvider value={{ myScopes: [] }}>
        <EditorTable
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
          {...props}
        />
      </EditorActionsProvider>
    </QueryClientProvider>
  )
}

/** The row's "⋯" menu, opened: the cue button lives in it. */
async function openRowMenu(rowIndex: number) {
  const triggers = await screen.findAllByRole("button", { name: /^More actions/ })
  fireEvent.click(triggers[rowIndex])
  return screen.findByRole("dialog")
}

const rows = () => makeStore([
  cueRow("c1", "First line", 1_000, 4_000),
  cueRow("c2", "Second line", 5_000, 8_000),
])

describe("EditorTable — the row's Play from this cue button (AQU-1118)", () => {
  it("shows Pause on the row that is playing, and Pause pauses", async () => {
    const onSeekToCue = vi.fn()
    const onPauseCue = vi.fn()
    render(table(rows(), { playingCueCellId: "c2", onSeekToCue, onPauseCue }))
    const menu = await openRowMenu(1)
    expect(within(menu).queryByRole("button", { name: "Play from this cue" })).toBeNull()
    fireEvent.click(within(menu).getByRole("button", { name: "Pause" }))
    expect(onPauseCue).toHaveBeenCalledOnce()
    expect(onSeekToCue).not.toHaveBeenCalled()
  })

  it("shows Play from this cue on every other row, and it plays from that row", async () => {
    const onSeekToCue = vi.fn()
    const onPauseCue = vi.fn()
    render(table(rows(), { playingCueCellId: "c2", onSeekToCue, onPauseCue }))
    const menu = await openRowMenu(0)
    expect(within(menu).queryByRole("button", { name: "Pause" })).toBeNull()
    fireEvent.click(within(menu).getByRole("button", { name: "Play from this cue" }))
    expect(onSeekToCue).toHaveBeenCalledWith("c1")
    expect(onPauseCue).not.toHaveBeenCalled()
  })

  it("follows the playing line as it moves, and goes back to Play when nothing plays", async () => {
    const props = { onSeekToCue: vi.fn(), onPauseCue: vi.fn() }
    const store = rows()
    const { rerender } = render(table(store, { ...props, playingCueCellId: "c1" }))
    let menu = await openRowMenu(0)
    expect(within(menu).getByRole("button", { name: "Pause" })).toBeInTheDocument()
    rerender(table(store, { ...props, playingCueCellId: "c2" }))
    menu = await screen.findByRole("dialog")
    expect(within(menu).getByRole("button", { name: "Play from this cue" })).toBeInTheDocument()
    rerender(table(store, { ...props, playingCueCellId: null }))
    menu = await screen.findByRole("dialog")
    expect(within(menu).getByRole("button", { name: "Play from this cue" })).toBeInTheDocument()
  })
})

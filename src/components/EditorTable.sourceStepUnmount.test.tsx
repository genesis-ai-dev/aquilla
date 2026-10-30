/**
 * Decision 11: an editing session of a line's source text is ONE Undo step,
 * recorded when the source editor closes. The list is virtualized, so a row
 * can also leave the screen (unmount) with its editor still open; the saves it
 * already made must still become that step (review, Oct 29).
 */

import { describe, it, expect, vi } from "vitest"
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import type { Editor } from "@tiptap/react"
import { EditorTable } from "./EditorTable"
import { EditorActionsProvider } from "@/context/EditorActionsContext"
import { CellStore } from "@/hooks/useActiveCellStore"
import type { CellData } from "@/hooks/useCells"
import type { CellRow } from "@/lib/sync/cells-read-types"
import type { ProjectRecord } from "@/lib/parsers/types"
import { ROLE } from "@/lib/frontier/roles"
import { emitSourceCellCommit } from "@/lib/sync/events-emit"
import { settleSourceStep } from "@/lib/history/source-steps"

const openCellMenu = async () => {
  const trigger = (await screen.findAllByRole("button", { name: "Cell actions" }))[0]
  fireEvent.click(trigger)
  return screen.findByTestId("cell-menu-edit-source")
}
vi.mock("@/hooks/useDcsUpstreamCursor", () => ({
  useDcsUpstreamCursor: () => ({ cursor: null, loading: false }),
}))

vi.mock("@/lib/sync/events-emit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sync/events-emit")>()),
  emitSourceCellCommit: vi.fn(async () => "E-source-1"),
}))

vi.mock("@/lib/history/source-steps", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/history/source-steps")>()
  return { ...actual, settleSourceStep: vi.fn(actual.settleSourceStep) }
})

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
            { key: keyExtractor?.(item, index) ?? item.id },
            renderItem({ item, index }),
          ),
        ),
      )
    }),
  }
})

function makeProject(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: "proj-1",
    name: "Test Project",
    sourceLanguage: "en",
    targetLanguage: "fr",
    createdAt: "2026-01-01T00:00:00Z",
    files: [],
    members: [],
    ...overrides,
  }
}

function withRole(level: number, overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return makeProject({
    syncRole: { level, name: "test", source: "server", fetchedAt: "2026-01-01T00:00:00Z" },
    ...overrides,
  })
}

function makeCell(id: string): CellData {
  return {
    id,
    fileId: "file-1",
    original: "hello",
    translated: "bonjour",
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
}

// Build a CellStore from CellData[] the way EditorTable now expects it
// (the component moved from a `cells` prop to a `cellStore`). Same shape as
// EditorTable.selectionTargeting.test's helper.
function makeRows(cells: CellData[]): CellRow[] {
  return cells.flatMap((cell, index) => {
    const canonicalRef = cell.context || cell.group || null
    const anchorCellId = index > 0 ? cells[index - 1].id : null
    return [
      {
        cellId: cell.id,
        side: "source",
        value: cell.original,
        valueHtml: cell.originalHtml ?? null,
        type: cell.type,
        canonicalRef,
        anchorCellId,
        eventId: `${cell.id}-source`,
        sourceEventId: null,
        lastEditor: null,
        lastEditAt: 1,
        validated: false,
        wordCount: cell.original.trim().split(/\s+/).filter(Boolean).length,
      },
      {
        cellId: cell.id,
        side: "target",
        value: cell.translated,
        valueHtml: cell.translatedHtml ?? null,
        type: cell.type,
        canonicalRef,
        anchorCellId,
        eventId: `${cell.id}-target`,
        sourceEventId: `${cell.id}-source`,
        lastEditor: "lead",
        lastEditAt: 2,
        validated: false,
        wordCount: cell.translated.trim().split(/\s+/).filter(Boolean).length,
      },
    ]
  })
}

function makeStore(cells: CellData[], projectId: string): CellStore {
  const store = new CellStore()
  store.setRuntime({
    projectId,
    fileId: "file-1",
    username: "lead",
    requiredValidations: 1,
    auditStats: new Map(),
  })
  store.replaceRows(makeRows(cells), { full: true, maxServerSeq: 1 })
  return store
}

function renderTable(project: ProjectRecord) {
  const qc = new QueryClient()
  return render(
    <QueryClientProvider client={qc}>
      <EditorActionsProvider value={{}}>
        <EditorTable
          project={project}
          cellStore={makeStore([makeCell("cell-1")], project.id)}
          username="lead"
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

describe("EditorTable — a source edit's Undo step", () => {
  it("is still recorded when the row unmounts with its source editor open", async () => {
    const view = renderTable(withRole(ROLE.PROJECT_LEAD))
    fireEvent.click(await openCellMenu())
    const box = await screen.findByRole("textbox", { name: "Edit source text" })
    const pm = box as HTMLElement & { editor?: Editor }
    await waitFor(() => expect(pm.editor).toBeTruthy())
    act(() => {
      pm.editor!.commands.insertContent(" there")
    })
    // The editor saves when the typing pauses, and stays open.
    await waitFor(() => expect(emitSourceCellCommit).toHaveBeenCalledTimes(1), { timeout: 4000 })
    expect(screen.getByRole("textbox", { name: "Edit source text" })).toBeInTheDocument()
    expect(settleSourceStep).not.toHaveBeenCalled()

    view.unmount()
    expect(settleSourceStep).toHaveBeenCalledTimes(1)
    expect(vi.mocked(settleSourceStep).mock.calls[0][1]).toEqual({ cellId: "cell-1", fileId: "file-1" })
  })
})

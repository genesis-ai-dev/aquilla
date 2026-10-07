/**
 * AQU-1578: a translator fills an EMPTY target cell, Tabs on, Shift+Tabs
 * straight back and edits again. The first commit's outbox write is still in
 * flight, so the workspace had not yet learned its id; the second commit fell
 * back to the cell's projected head — for a just-filled cell, the optimistic
 * placeholder `targetEventId: ""` — and went out with `parentId: ""`. The
 * server's head compare-and-swap dropped it as a stale sibling: the re-edit
 * vanished and the cell lost its validation.
 *
 * These render the real EditorTable + TranslatedEditor over a real CellStore
 * (so the optimistic placeholder row is the genuine one) and hold the first
 * `emitTargetCellCommit` open while the second commit is made.
 */

import { describe, it, expect, afterEach, vi } from "vitest"
import { render, screen, cleanup, act, fireEvent, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createElement, Fragment, forwardRef, useImperativeHandle, type ReactNode } from "react"
import type { Editor } from "@tiptap/core"
import { EditorTable } from "./EditorTable"
import { EditorActionsProvider } from "@/context/EditorActionsContext"
import { CellStore } from "@/hooks/useActiveCellStore"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { CellRow } from "@/lib/sync/cells-read-types"
import { ROLE } from "@/lib/frontier/roles"
import { emitCellValidate, emitTargetCellCommit, type CellCommitInput } from "@/lib/sync/events-emit"

vi.mock("@/lib/sync/events-emit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sync/events-emit")>()
  return {
    ...actual,
    // Like the real emit: the enqueued event carries the caller's id when one
    // is supplied. Without one (the pre-fix editor) it mints its own.
    emitTargetCellCommit: vi.fn(async (input: CellCommitInput) => input.id ?? `E-minted-${input.value}`),
    emitCellValidate: vi.fn(async () => "E-validate"),
  }
})

// happy-dom has no layout engine — render every row (same shim as the other
// EditorTable RTL suites).
vi.mock("@legendapp/list/react", () => ({
  LegendList: forwardRef(function MockLegendList({
    data,
    renderItem,
    keyExtractor,
  }: {
    data: string[]
    renderItem: (props: { item: string; index: number }) => ReactNode
    keyExtractor?: (item: string, index: number) => string
  }, ref) {
    useImperativeHandle(ref, () => ({
      getState: () => ({ scroll: 0, positionAtIndex: (i: number) => i * 140, sizeAtIndex: () => 140 }),
      scrollToIndex: async () => undefined,
      scrollToOffset: async () => undefined,
    }))
    return createElement(
      "div",
      null,
      data.map((item, index) =>
        createElement(Fragment, { key: keyExtractor?.(item, index) ?? item }, renderItem({ item, index })),
      ),
    )
  }),
}))

afterEach(() => {
  cleanup()
  vi.mocked(emitTargetCellCommit).mockClear()
  vi.mocked(emitCellValidate).mockClear()
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

/** An untranslated verse: a source row and no target row at all. */
const EMPTY_CELL_ROWS: CellRow[] = [{
  cellId: "cell-1", side: "source", value: "hello", valueHtml: null, type: "text",
  canonicalRef: "GEN 1:1", anchorCellId: null, eventId: "cell-1-source",
  sourceEventId: null, lastEditor: null, lastEditAt: 1, validated: false, wordCount: 1,
}]

/** The workspace's pending-head bookkeeping, reduced to its contract. */
function makeWorkspaceHost() {
  const pending = new Map<string, { eventId: string; parentId: string | null }>()
  return {
    pending,
    getPendingTargetEventId: (cellId: string) => pending.get(cellId)?.eventId ?? null,
    reservePendingTargetCommit: (cellId: string, eventId: string, parentId: string | null) => {
      pending.set(cellId, { eventId, parentId })
      return () => {
        if (pending.get(cellId)?.eventId === eventId) pending.delete(cellId)
      }
    },
  }
}

function renderTable(host: ReturnType<typeof makeWorkspaceHost> | null) {
  const store = new CellStore()
  store.setRuntime({ projectId: project.id, fileId: "file-1", username: "tester", requiredValidations: 1, auditStats: new Map() })
  store.replaceRows(EMPTY_CELL_ROWS, { full: true, maxServerSeq: 1 })
  render(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(EditorActionsProvider, {
        value: {},
        children: createElement(EditorTable, {
          project,
          cellStore: store,
          username: "tester",
          isCompletionConfigured: false,
          isCompletionAvailable: false,
          completing: new Map(),
          examples: new Map(),
          errors: new Map(),
          previews: new Map(),
          onCompleteSingle: () => {},
          onCompleteBatch: () => {},
          healthMap: new Map(),
          lineNumbersEnabled: false,
          cellLabelsEnabled: true,
          sourceTextDirection: "ltr",
          targetTextDirection: "ltr",
          // The workspace wires the store's optimistic patch here — that is
          // what gives a just-filled cell its `targetEventId: ""` placeholder.
          onOptimisticEdit: (cellId: string, patch: { value: string; valueHtml?: string }) =>
            store.applyOptimisticTargetEdit(cellId, patch),
          onCellCommitted: () => {},
          ...(host ? {
            getPendingTargetEventId: host.getPendingTargetEventId,
            reservePendingTargetCommit: host.reservePendingTargetCommit,
          } : {}),
        }),
      }),
    ),
  )
  return store
}

type MountedEditor = HTMLElement & { editor?: Editor }

/** Click the row's target into edit mode and hand back the focused editor. */
async function openEditor(): Promise<MountedEditor> {
  await screen.findByText("hello")
  const readSurface = await waitFor(() => {
    const el = document.querySelector('[data-editor-cell-surface="target-read"]')
    if (!el) throw new Error("target read surface not rendered")
    return el
  })
  fireEvent.click(readSurface)
  const pm = await waitFor(() => {
    const el = document.querySelector(".ProseMirror") as MountedEditor | null
    if (!el?.editor) throw new Error("editor not mounted yet")
    return el
  })
  act(() => {
    fireEvent.focus(pm)
  })
  return pm
}

/** Type into the open editor and leave the cell (the blur commit). */
async function typeAndLeave(text: string) {
  const pm = await openEditor()
  act(() => {
    pm.editor!.commands.setContent(text)
  })
  act(() => {
    fireEvent.blur(pm)
  })
  await waitFor(() => expect(document.querySelector('[data-editor-cell-surface="target-read"]')).not.toBeNull())
}

/** Hold the next emitTargetCellCommit open until `release()`. */
function holdNextCommit() {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  vi.mocked(emitTargetCellCommit).mockImplementationOnce(async (input) => {
    await gate
    return input.id ?? `E-minted-${input.value}`
  })
  return () => act(async () => { release() })
}

const commitCall = (n: number) => vi.mocked(emitTargetCellCommit).mock.calls[n][0]

describe("EditorTable — AQU-1578 a quick re-edit of a just-filled cell chains on the first commit", () => {
  it("chains the second commit on the first while the first is still being enqueued", async () => {
    const host = makeWorkspaceHost()
    const store = renderTable(host)
    const releaseFirst = holdNextCommit()

    await typeAndLeave("first draft")
    await waitFor(() => expect(emitTargetCellCommit).toHaveBeenCalledTimes(1))
    // The optimistic placeholder the old fallback chained on.
    expect(store.getCellSummary("cell-1")?.targetEventId).toBe("")

    await typeAndLeave("first draft, revised")
    await waitFor(() => expect(emitTargetCellCommit).toHaveBeenCalledTimes(2))

    await releaseFirst()
    const firstId = await vi.mocked(emitTargetCellCommit).mock.results[0].value
    expect(commitCall(0).parentId).toBe("cell-1-source")
    expect(commitCall(1).value).toBe("first draft, revised")
    expect(commitCall(1).parentId).not.toBe("")
    expect(commitCall(1).parentId).toBe(firstId)
    // The re-edit is the pending head, and its auto-validation pins to it.
    expect(host.pending.get("cell-1")).toEqual({ eventId: commitCall(1).id, parentId: firstId })
    await waitFor(() => expect(emitCellValidate).toHaveBeenCalledTimes(2))
    expect(vi.mocked(emitCellValidate).mock.calls.map(([v]) => v.editEventId))
      .toEqual(expect.arrayContaining([firstId, commitCall(1).id]))
  })

  it("chains on the row-local head too when no workspace getter is wired", async () => {
    renderTable(null)
    const releaseFirst = holdNextCommit()

    await typeAndLeave("alpha")
    await waitFor(() => expect(emitTargetCellCommit).toHaveBeenCalledTimes(1))
    await typeAndLeave("alpha beta")
    await waitFor(() => expect(emitTargetCellCommit).toHaveBeenCalledTimes(2))

    await releaseFirst()
    const firstId = await vi.mocked(emitTargetCellCommit).mock.results[0].value
    expect(commitCall(1).parentId).toBe(firstId)
  })

  it("drops the reservation when the enqueue fails, so the next commit chains on the real head", async () => {
    const host = makeWorkspaceHost()
    renderTable(host)
    vi.mocked(emitTargetCellCommit).mockRejectedValueOnce(new Error("Outbox unavailable"))

    await typeAndLeave("lost")
    await waitFor(() => expect(screen.getByText("Outbox unavailable")).toBeInTheDocument())
    expect(host.pending.has("cell-1")).toBe(false)

    await typeAndLeave("retry")
    await waitFor(() => expect(emitTargetCellCommit).toHaveBeenCalledTimes(2))
    expect(commitCall(1).parentId).toBe("cell-1-source")
  })
})

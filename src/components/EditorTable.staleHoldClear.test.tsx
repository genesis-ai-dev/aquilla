/**
 * AQU-1154 (I2/I4): a row's local hold of its just-committed text must not
 * outlive a server head that moved to someone ELSE's commit.
 *
 * `localTargetDraft` paints the committed text until the projection carries
 * it back. It used to clear only on exact value match (or an AI draft), so a
 * writer whose commit LOST the server's head compare-and-swap kept seeing
 * their own losing text forever while the store held the winner's. The row
 * now drops the hold whenever `cell.targetEventId` moves to an id other than
 * the one this row's own commit was assigned.
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
import { emitTargetCellCommit } from "@/lib/sync/events-emit"

const MY_EVENT_ID = "E-mine"

vi.mock("@/lib/sync/events-emit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sync/events-emit")>()
  return { ...actual, emitTargetCellCommit: vi.fn(async () => "E-mine") }
})

// happy-dom has no layout engine, so LegendList may render no rows. Replace it
// with a trivial "render every row" stand-in (same as the other EditorTable
// RTL suites).
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

function makeRows(target: { value: string; eventId: string }): CellRow[] {
  return [
    {
      cellId: "cell-1", side: "source", value: "hello", valueHtml: null, type: "text",
      canonicalRef: "GEN 1:1", anchorCellId: null, eventId: "cell-1-source",
      sourceEventId: null, lastEditor: null, lastEditAt: 1, validated: false, wordCount: 1,
    },
    {
      cellId: "cell-1", side: "target", value: target.value, valueHtml: null, type: "text",
      canonicalRef: "GEN 1:1", anchorCellId: null, eventId: target.eventId,
      sourceEventId: "cell-1-source", lastEditor: "tester", lastEditAt: 2, validated: false,
      wordCount: 1,
    },
  ]
}

function makeStore(): CellStore {
  const store = new CellStore()
  store.setRuntime({ projectId: project.id, fileId: "file-1", username: "tester", requiredValidations: 1, auditStats: new Map() })
  store.replaceRows(makeRows({ value: "old", eventId: "H" }), { full: true, maxServerSeq: 1 })
  return store
}

function renderTable(store: CellStore) {
  return render(
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
        }),
      }),
    ),
  )
}

const readSurfaceText = () =>
  document.querySelector("[data-target-read-view]")?.textContent?.trim() ?? null

/** The server projection for cell-1 lands with `value` at head `eventId`. */
function landProjection(store: CellStore, value: string, eventId: string) {
  act(() => {
    store.replaceRows(makeRows({ value, eventId }), { full: true, maxServerSeq: 2 })
  })
}

/**
 * Open cell-1's editor, replace its text with "mine", blur to commit. Leaves
 * the row painting "mine" from its local hold while the store still says
 * "old" at head "H".
 */
async function commitMine(store: CellStore) {
  renderTable(store)
  await screen.findByText("hello")
  const readSurface = document.querySelector('[data-editor-cell-surface="target-read"]')
  expect(readSurface).not.toBeNull()
  fireEvent.click(readSurface!)
  const pm = await waitFor(() => {
    const el = document.querySelector(".ProseMirror") as (HTMLElement & { editor?: Editor }) | null
    if (!el?.editor) throw new Error("editor not mounted yet")
    return el
  })
  act(() => {
    pm.editor!.commands.setContent("mine")
  })
  act(() => {
    fireEvent.blur(pm)
  })
  await waitFor(() => expect(emitTargetCellCommit).toHaveBeenCalledTimes(1))
  expect(vi.mocked(emitTargetCellCommit).mock.calls[0][0]).toMatchObject({ cellId: "cell-1", value: "mine" })

  // The hold: the read surface shows our text while the store still holds
  // the pre-commit projection.
  await waitFor(() => expect(readSurfaceText()).toBe("mine"))
  expect(store.getCellView("cell-1")?.translated).toBe("old")
  expect(store.getCellView("cell-1")?.targetEventId).toBe("H")
}

describe("EditorTable — AQU-1154 stale local hold clears when the head moves past us", () => {
  it("shows the winner's text once the head lands on an event this row did not commit", async () => {
    const store = makeStore()
    await commitMine(store)

    // Our commit lost the server's head compare-and-swap: the projection
    // arrives carrying someone else's commit. The hold must step aside —
    // previously the row kept painting "mine" forever.
    landProjection(store, "theirs", "E-theirs")
    await waitFor(() => expect(readSurfaceText()).toBe("theirs"))
    expect(screen.queryByText("mine")).toBeNull()
  })

  it("control: keeps showing our text when our own commit wins the head", async () => {
    const store = makeStore()
    await commitMine(store)

    landProjection(store, "mine", MY_EVENT_ID)
    await waitFor(() => expect(readSurfaceText()).toBe("mine"))
    expect(screen.queryByText("old")).toBeNull()
  })
})

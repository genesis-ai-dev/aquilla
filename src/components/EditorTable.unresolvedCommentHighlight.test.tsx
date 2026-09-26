/**
 * AQU-1259 (B) — "Highlight open comments", the reviewer's opt-in scanning view.
 *
 * The rule under test is narrow and easy to get wrong in either direction:
 * the accent lands on exactly the rows with an unresolved thread, only while
 * the preference is on, and turning it off leaves AQU-599's always-on marker
 * alone. That last part is why the assertions read the dedicated data attribute
 * rather than a class: a row can already carry a blue inset ring from AQU-599,
 * so a colour check could not tell "this file has comments" from "this reviewer
 * asked to see them".
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
  resetUnresolvedCommentHighlightCacheForTests,
  setUnresolvedCommentHighlight,
} from "@/lib/store/unresolved-comment-highlight-pref"

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
  { id: "cell-a", ref: "GEN 1:1" },
  { id: "cell-b", ref: "GEN 1:2" },
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

/** cell-a carries one unresolved thread; cell-b carries none. */
function renderTable(openComments = new Map([["cell-a", 1]])) {
  const onOpenComments = vi.fn()
  const qc = new QueryClient()
  render(
    <QueryClientProvider client={qc}>
      <EditorActionsProvider value={{ onOpenComments }}>
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
          cellOpenCommentCount={openComments}
        />
      </EditorActionsProvider>
    </QueryClientProvider>,
  )
  return { onOpenComments }
}

function accentedRow(id: string) {
  return document.querySelector(`[data-cell-id="${id}"] [data-unresolved-comments="true"]`)
}

function row(id: string) {
  return document.querySelector(`[data-cell-id="${id}"]`)
}

describe("EditorTable — highlight open comments (AQU-1259)", () => {
  beforeEach(() => {
    localStorage.clear()
    resetUnresolvedCommentHighlightCacheForTests()
    setUnresolvedCommentHighlight(false)
  })

  it("marks no row until the preference is switched on", () => {
    renderTable()

    // Both rows render; neither is accented, including the one with a thread.
    expect(row("cell-a")).toBeTruthy()
    expect(row("cell-b")).toBeTruthy()
    expect(accentedRow("cell-a")).toBeNull()
    expect(accentedRow("cell-b")).toBeNull()
  })

  it("accents only the rows with an unresolved thread, live, and clears on off", () => {
    renderTable()

    act(() => {
      setUnresolvedCommentHighlight(true)
    })

    // Live, with no reload and no remount — the AC's "enable the toggle →
    // rows are visibly marked" is a same-session promise.
    expect(accentedRow("cell-a")).toBeTruthy()
    expect(accentedRow("cell-b")).toBeNull()

    act(() => {
      setUnresolvedCommentHighlight(false)
    })

    expect(accentedRow("cell-a")).toBeNull()
  })

  it("renders already-accented from a stored preference", () => {
    setUnresolvedCommentHighlight(true)
    renderTable()

    expect(accentedRow("cell-a")).toBeTruthy()
    expect(accentedRow("cell-b")).toBeNull()
  })

  it("accents nothing in a file whose threads are all resolved", () => {
    // The count fed in is open threads only, so "all resolved" arrives as an
    // empty map. A file with no outstanding work must look untouched even with
    // the preference on — the regression AC.
    setUnresolvedCommentHighlight(true)
    renderTable(new Map())

    expect(accentedRow("cell-a")).toBeNull()
    expect(accentedRow("cell-b")).toBeNull()
  })

  it("leaves AQU-599's always-on comment marker in place when off", () => {
    // The opt-in view adds a signal; it must not have replaced the badge that
    // shipped in AQU-599, which is what a reviewer clicks to open the thread.
    renderTable()

    const badge = screen.getByRole("button", { name: /comment/i })
    expect(badge).toBeTruthy()
    fireEvent.click(badge)
  })
})

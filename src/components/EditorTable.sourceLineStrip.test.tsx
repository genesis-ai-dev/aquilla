/**
 * AQU-646 round 8: adding and removing lines from the TEXT TABLE, alongside the
 * gestures the timeline already offers (Sam, 2026-08-11).
 *
 * The load-bearing rules, and why each is pinned here:
 *   - A row with no room after it gets NO insert control, rather than a
 *     disabled one. One rule with the timeline's pencil, so the two surfaces
 *     can never disagree about where a line will fit.
 *   - Insert-above exists once per file, on the first row, for the silence
 *     before the first cue.
 *   - Remove appears only on a line someone added that is still empty — the
 *     workspace owns that predicate and hands it in, exactly as it does to the
 *     timeline lane.
 *   - With the prop absent NOTHING renders. That is how every other workflow
 *     (audio-first, text-first) stays untouched, so it is asserted, not assumed.
 */

import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent, within } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { EditorTable } from "./EditorTable"
import { EditorActionsProvider } from "@/context/EditorActionsContext"
import { CellStore } from "@/hooks/useActiveCellStore"
import { isLineEmpty, isUserAddedLine } from "@/lib/timeline/user-lines"
import type { CellData } from "@/hooks/useCells"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { CellRow } from "@/lib/sync/cells-read-types"

vi.mock("@/hooks/useMicPermission", () => ({
  useMicPermission: () => ({ micDenied: true }),
}))

// happy-dom has no layout engine — render every row (same stand-in the
// castGutter suite uses).
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
          React.createElement(React.Fragment, { key: keyExtractor?.(item, index) ?? item }, renderItem({ item, index })),
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

function row(
  cellId: string,
  side: "source" | "target",
  value: string,
  over: Partial<CellRow> = {},
): CellRow {
  return {
    cellId,
    side,
    value,
    valueHtml: null,
    type: "text",
    canonicalRef: null,
    anchorCellId: null,
    eventId: `${cellId}-${side}`,
    sourceEventId: side === "target" ? `${cellId}-source` : null,
    lastEditor: null,
    lastEditAt: 1,
    validated: false,
    wordCount: 1,
    ...over,
  } as CellRow
}

// Two imported cues and one line someone added between them, still blank.
function makeStore(): CellStore {
  const store = new CellStore()
  store.setRuntime({
    projectId: project.id,
    fileId: "file-1",
    username: "tester",
    requiredValidations: 1,
    auditStats: new Map(),
  })
  store.replaceRows(
    [
      row("cue-a", "source", "First cue", { startMs: 10_000, endMs: 20_000 }),
      row("cue-a", "target", "premiere"),
      row("added", "source", "", {
        anchorCellId: "cue-a",
        startMs: 25_000,
        endMs: 28_000,
        metadata: { aquillaOrigin: { kind: "user-insert" } },
      }),
      row("added", "target", ""),
      row("cue-b", "source", "Second cue", { anchorCellId: "added", startMs: 40_000, endMs: 50_000 }),
      row("cue-b", "target", "deuxieme"),
    ],
    { full: true, maxServerSeq: 1 },
  )
  return store
}

const rowEl = (cellId: string) => document.querySelector(`[data-cell-id="${cellId}"]`) as HTMLElement

/** The gaps a real derivation would produce for the store above, minus the ones
 *  under the 0.2s floor. `cue-a`→`added` is a 5s silence; `added`→`cue-b` is a
 *  12s one; and `cue-b` is given a rounding breath, so it offers nothing. */
const SLOTS = {
  head: { startSec: 0, endSec: 10 },
  afterCell: new Map([
    ["cue-a", { startSec: 20, endSec: 25 }],
    ["added", { startSec: 28, endSec: 40 }],
  ]),
}

function renderTable(over: Partial<Parameters<typeof EditorTable>[0]> = {}) {
  const qc = new QueryClient()
  return render(
    <QueryClientProvider client={qc}>
      <EditorActionsProvider value={{}}>
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
          {...over}
        />
      </EditorActionsProvider>
    </QueryClientProvider>,
  )
}

const editing = (over: Record<string, unknown> = {}) => ({
  head: SLOTS.head,
  afterCell: SLOTS.afterCell,
  onAddLine: vi.fn(),
  canRemove: (c: CellData) => isUserAddedLine(c) && isLineEmpty(c),
  onRemoveLine: vi.fn(),
  ...over,
}) as NonNullable<Parameters<typeof EditorTable>[0]["sourceLineEditing"]>

describe("EditorTable — the row's structural controls", () => {
  it("renders nothing at all when the workflow is off", async () => {
    renderTable()
    await screen.findByText("First cue")
    expect(screen.queryByTestId("row-insert-above")).toBeNull()
    expect(screen.queryByTestId("row-structure-cue-a")).toBeNull()
    expect(screen.queryByTestId("row-remove-added")).toBeNull()
  })

  it("offers an insert on a row with room after it", async () => {
    renderTable({ sourceLineEditing: editing() })
    await screen.findByText("First cue")
    expect(within(rowEl("cue-a")).getByTestId("row-structure-cue-a-add")).toBeInTheDocument()
  })

  it("offers NO insert on a row with no room after it", async () => {
    // cue-b is absent from the map — the trailing breath is under the floor.
    renderTable({ sourceLineEditing: editing() })
    await screen.findByText("Second cue")
    expect(within(rowEl("cue-b")).queryByTestId("row-structure-cue-b-add")).toBeNull()
  })

  it("insert-above appears once, on the first row only", async () => {
    renderTable({ sourceLineEditing: editing() })
    await screen.findByText("First cue")
    expect(screen.getAllByTestId("row-insert-above")).toHaveLength(1)
    expect(within(rowEl("cue-a")).getByTestId("row-insert-above")).toBeInTheDocument()
  })

  it("no insert-above when the file has no leading silence", async () => {
    renderTable({ sourceLineEditing: editing({ head: null }) })
    await screen.findByText("First cue")
    expect(screen.queryByTestId("row-insert-above")).toBeNull()
  })

  it("hands the exact silence to the workspace, not the row's own times", async () => {
    const onAddLine = vi.fn()
    renderTable({ sourceLineEditing: editing({ onAddLine }) })
    await screen.findByText("First cue")
    fireEvent.click(within(rowEl("cue-a")).getByTestId("row-structure-cue-a-add"))
    expect(onAddLine).toHaveBeenCalledWith(20, 25)
  })

  it("Remove appears on an empty added line and nowhere else", async () => {
    renderTable({ sourceLineEditing: editing() })
    await screen.findByText("First cue")
    expect(within(rowEl("added")).getByTestId("row-remove-added")).toBeInTheDocument()
    expect(within(rowEl("cue-a")).queryByTestId("row-remove-cue-a")).toBeNull()
    expect(within(rowEl("cue-b")).queryByTestId("row-remove-cue-b")).toBeNull()
  })

  it("Remove reaches the workspace with the row's id", async () => {
    const onRemoveLine = vi.fn()
    renderTable({ sourceLineEditing: editing({ onRemoveLine }) })
    await screen.findByText("First cue")
    fireEvent.click(within(rowEl("added")).getByTestId("row-remove-added"))
    expect(onRemoveLine).toHaveBeenCalledWith("added")
  })
})

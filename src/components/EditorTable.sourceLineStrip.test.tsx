/**
 * AQU-646: adding and removing lines from the TEXT TABLE, alongside the
 * gestures the timeline already offers (Sam, 2026-08-11).
 *
 * The load-bearing rules, and why each is pinned here:
 *   - A row with no room after it gets NO insert control, rather than a
 *     disabled one. One rule with the timeline's pencil, so the two surfaces
 *     can never disagree about where a line will fit.
 *   - The FIRST row is the only one that can insert in two directions, because
 *     it is the only row with a silence in front of it. Its + asks which; every
 *     other + acts immediately. A one-item menu would be a click for nothing.
 *   - Remove appears only on a line someone added that is still empty — the
 *     workspace owns that predicate and hands it in, exactly as it does to the
 *     timeline lane.
 *   - With the prop absent NOTHING renders. That is how every other workflow
 *     (audio-first, text-first) stays untouched, so it is asserted, not assumed.
 *
 * One test asserts CLASSES, which is normally a smell. It is here because the
 * bug this round fixed was purely positional — the control was correct in every
 * behavioural sense and invisible on screen — and happy-dom has no layout
 * engine to catch that. The real guard is the geometric leg in
 * browser-verify-source-band; this is the cheap sentinel beside it.
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

const NO_ROOM = "There’s no room here to fit a line."
const MAINTAINER_ONLY = "Only a maintainer can remove an imported line."
// Round 4: the media cause answers the ACTION, not the row — a dead insert
// is a question about a NEW cell, so it no longer describes the row it sits on.
const MEDIA_ADD = "Cells can’t be added to imported audio."
const MEDIA_REMOVE = "This row is a piece of the original recording, so it can’t be removed."

/** Mirrors the workspace's real resolver: a reason means "render it disabled
 *  and say this", null means available. */
const rowActions = (cell: CellData, gaps: { gapAbove: boolean; gapBelow: boolean }) => ({
  above: gaps.gapAbove ? null : NO_ROOM,
  below: gaps.gapBelow ? null : NO_ROOM,
  remove: isUserAddedLine(cell) && isLineEmpty(cell) ? null : MAINTAINER_ONLY,
})

const editing = (over: Record<string, unknown> = {}) => ({
  head: SLOTS.head,
  afterCell: SLOTS.afterCell,
  onAddLine: vi.fn(),
  rowActions,
  onRemoveLine: vi.fn(),
  ...over,
}) as NonNullable<Parameters<typeof EditorTable>[0]["sourceLineEditing"]>

const addBtn = (cellId: string) =>
  within(rowEl(cellId)).getByTestId(`row-structure-${cellId}-add`)

/**
 * AQU-1068 round 3: THE CONTROL IS ALWAYS THERE, and says why it cannot be
 * used.
 *
 * This reverses the older "no room, no button — never a disabled one" rule, and
 * deliberately: Sam switched the setting on for an MP3 import, nothing
 * appeared, and there was no way to tell an inapplicable file from a broken
 * feature. An absent control teaches nothing. What is still withheld entirely
 * is PROJECT-level (no access at all) — a permanently dead button is furniture,
 * not an explanation.
 */
describe("EditorTable — the row's structural controls", () => {
  it("renders nothing at all when the workflow is off", async () => {
    // The one case that still hides: no access.
    renderTable()
    await screen.findByText("First cue")
    expect(screen.queryByTestId("row-structure-cue-a")).toBeNull()
    expect(screen.queryByTestId("row-remove-added")).toBeNull()
  })

  it("sits in the row's bottom-right corner, half-visible at rest", async () => {
    // The placement IS the fix: two earlier cuts put this control outside the
    // row (clipped away by the list's paint containment) and then floating in
    // the middle of it. Bottom-right is the row's only free corner — the action
    // rail owns the top-right.
    renderTable({ sourceLineEditing: editing() })
    await screen.findByText("First cue")
    const corner = within(rowEl("cue-a")).getByTestId("row-structure-cue-a")
    expect(corner.className).toContain("right-2")
    expect(corner.className).toContain("bottom-1")
    expect(corner.className).toContain("opacity-50")
    expect(corner.className).toContain("group-hover/rowstrip:opacity-100")
  })

  it("gives EVERY row a corner, including one with no room after it", async () => {
    // cue-b is absent from the afterCell map — the trailing breath is under the
    // floor. It used to get no `+` at all.
    renderTable({ sourceLineEditing: editing() })
    await screen.findByText("Second cue")
    for (const id of ["cue-a", "added", "cue-b"]) {
      expect(within(rowEl(id)).getByTestId(`row-structure-${id}`)).toBeInTheDocument()
      expect(addBtn(id)).toBeInTheDocument()
    }
  })

  it("offers BOTH directions on a middle row when both silences exist", async () => {
    // "added" sits between the 20-25 gap and the 28-40 one. Round 2 offered
    // only "below" here, on the reasoning that "above me" duplicates the
    // previous row's "below". The duplication is now deliberate: pointing at
    // the row you want to push down is how people describe the act.
    const onAddLine = vi.fn()
    renderTable({ sourceLineEditing: editing({ onAddLine }) })
    await screen.findByText("First cue")

    fireEvent.click(addBtn("added"))
    fireEvent.click(await screen.findByTestId("row-insert-above"))
    expect(onAddLine).toHaveBeenCalledWith(20, 25)

    fireEvent.click(addBtn("added"))
    fireEvent.click(await screen.findByTestId("row-insert-below"))
    expect(onAddLine).toHaveBeenLastCalledWith(28, 40)
  })

  it("the same silence is reachable from either side of it", async () => {
    // 20-25 is "below cue-a" and "above added". Both doors, one room.
    const onAddLine = vi.fn()
    renderTable({ sourceLineEditing: editing({ onAddLine }) })
    await screen.findByText("First cue")
    fireEvent.click(addBtn("cue-a"))
    fireEvent.click(await screen.findByTestId("row-insert-below"))
    expect(onAddLine).toHaveBeenCalledWith(20, 25)
  })

  it("shows the unavailable direction DISABLED, with its reason, not missing", async () => {
    renderTable({ sourceLineEditing: editing() })
    await screen.findByText("Second cue")
    fireEvent.click(addBtn("cue-b"))
    const below = await screen.findByTestId("row-insert-below")
    expect(below).toHaveAttribute("data-disabled")
    expect(within(below).getByTestId("row-insert-below-reason")).toHaveTextContent(NO_ROOM)
    // ...while the direction that IS available stays live.
    expect(screen.getByTestId("row-insert-above")).not.toHaveAttribute("data-disabled")
  })

  it("a disabled direction does nothing when clicked", async () => {
    const onAddLine = vi.fn()
    renderTable({ sourceLineEditing: editing({ onAddLine }) })
    await screen.findByText("Second cue")
    fireEvent.click(addBtn("cue-b"))
    fireEvent.click(await screen.findByTestId("row-insert-below"))
    expect(onAddLine).not.toHaveBeenCalled()
  })

  it("hands the exact silence to the workspace, not the row's own times", async () => {
    // The row spans 25-28s; the silence after it is 28-40s, and it is the
    // SILENCE that must travel.
    const onAddLine = vi.fn()
    renderTable({ sourceLineEditing: editing({ onAddLine }) })
    await screen.findByText("First cue")
    fireEvent.click(addBtn("added"))
    fireEvent.click(await screen.findByTestId("row-insert-below"))
    expect(onAddLine).toHaveBeenCalledWith(28, 40)
  })

  it("disables the + ITSELF when neither direction is possible", async () => {
    // A menu of nothing but dead items is worse than one explained button.
    renderTable({
      sourceLineEditing: editing({
        rowActions: () => ({ above: MEDIA_ADD, below: MEDIA_ADD, remove: MEDIA_REMOVE }),
      }),
    })
    await screen.findByText("First cue")
    expect(addBtn("cue-a")).toBeDisabled()
    fireEvent.click(addBtn("cue-a"))
    expect(screen.queryByTestId("row-insert-above")).toBeNull()
  })

  it("Remove is always present, and disabled with a reason where it does not apply", async () => {
    renderTable({ sourceLineEditing: editing() })
    await screen.findByText("First cue")
    // A line somebody added here and left empty: theirs to take back.
    expect(within(rowEl("added")).getByTestId("row-remove-added")).not.toBeDisabled()
    // An imported cue, below maintainer: shown, refused, explained.
    expect(within(rowEl("cue-a")).getByTestId("row-remove-cue-a")).toBeDisabled()
    expect(within(rowEl("cue-b")).getByTestId("row-remove-cue-b")).toBeDisabled()
  })

  it("Remove reaches the workspace with the row's id", async () => {
    const onRemoveLine = vi.fn()
    renderTable({ sourceLineEditing: editing({ onRemoveLine }) })
    await screen.findByText("First cue")
    fireEvent.click(within(rowEl("added")).getByTestId("row-remove-added"))
    expect(onRemoveLine).toHaveBeenCalledWith("added")
  })

  it("a disabled Remove does not reach the workspace", async () => {
    const onRemoveLine = vi.fn()
    renderTable({ sourceLineEditing: editing({ onRemoveLine }) })
    await screen.findByText("First cue")
    fireEvent.click(within(rowEl("cue-a")).getByTestId("row-remove-cue-a"))
    expect(onRemoveLine).not.toHaveBeenCalled()
  })

  it("the first row's above direction is the head silence", async () => {
    const onAddLine = vi.fn()
    renderTable({ sourceLineEditing: editing({ onAddLine }) })
    await screen.findByText("First cue")
    fireEvent.click(addBtn("cue-a"))
    fireEvent.click(await screen.findByTestId("row-insert-above"))
    expect(onAddLine).toHaveBeenCalledWith(0, 10)
  })

  it("with no leading silence the first row's above is disabled, not absent", async () => {
    renderTable({ sourceLineEditing: editing({ head: null }) })
    await screen.findByText("First cue")
    fireEvent.click(addBtn("cue-a"))
    const above = await screen.findByTestId("row-insert-above")
    expect(above).toHaveAttribute("data-disabled")
  })
})

/**
 * AQU-1068: the same corner control, on a file with no clock.
 *
 * An ordinary text file has no silences to measure, so every row can take a
 * cell on either side. That difference is resolved in the workspace and arrives
 * here as plain thunks, which is why RowStructureCorner no longer knows what a
 * second is.
 */
describe("EditorTable — structural controls on an untimed file", () => {
  const untimedEditing = (over: Record<string, unknown> = {}) =>
    editing({
      // Supplied empty: an untimed file has no silences, and the shape is
      // shared with the timed path rather than made optional for one caller.
      head: null,
      afterCell: new Map(),
      untimed: { onInsertAbove: vi.fn(), onInsertBelow: vi.fn(), ...(over.untimed ?? {}) },
      // No clock, so no "no room" — the workspace's resolver ignores the gap
      // flags entirely when placement is "anywhere".
      rowActions: (cell: CellData) => ({
        above: null,
        below: null,
        remove: isUserAddedLine(cell) && isLineEmpty(cell) ? null : MAINTAINER_ONLY,
      }),
      ...over,
    })

  it("offers BOTH directions on every row", async () => {
    renderTable({ sourceLineEditing: untimedEditing() })
    await screen.findByText("Second cue")
    for (const id of ["cue-a", "added", "cue-b"]) {
      fireEvent.click(addBtn(id))
      const above = await screen.findByTestId("row-insert-above")
      expect(above).not.toHaveAttribute("data-disabled")
      expect(screen.getByTestId("row-insert-below")).not.toHaveAttribute("data-disabled")
      fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" })
    }
  })

  it("passes the row's own id to the insert, not a time span", async () => {
    const onInsertBelow = vi.fn()
    renderTable({ sourceLineEditing: untimedEditing({ untimed: { onInsertAbove: vi.fn(), onInsertBelow } }) })
    await screen.findByText("Second cue")
    fireEvent.click(addBtn("cue-b"))
    fireEvent.click(await screen.findByTestId("row-insert-below"))
    expect(onInsertBelow).toHaveBeenCalledWith("cue-b")
  })

  it("insert above passes the row's id too", async () => {
    const onInsertAbove = vi.fn()
    renderTable({ sourceLineEditing: untimedEditing({ untimed: { onInsertAbove, onInsertBelow: vi.fn() } }) })
    await screen.findByText("First cue")
    fireEvent.click(addBtn("cue-a"))
    fireEvent.click(await screen.findByTestId("row-insert-above"))
    expect(onInsertAbove).toHaveBeenCalledWith("cue-a")
  })

  it("still asks the workspace what is removable", async () => {
    renderTable({
      sourceLineEditing: untimedEditing({
        rowActions: () => ({ above: null, below: null, remove: null }),
      }),
    })
    await screen.findByText("First cue")
    expect(within(rowEl("cue-a")).getByTestId("row-remove-cue-a")).not.toBeDisabled()
  })

  it("a media row refuses everything, answering each action in its own words", async () => {
    // An MP3 import: every row IS audio. It used to render nothing at all,
    // which is the case that started this round.
    renderTable({
      sourceLineEditing: untimedEditing({
        rowActions: () => ({ above: MEDIA_ADD, below: MEDIA_ADD, remove: MEDIA_REMOVE }),
      }),
    })
    await screen.findByText("First cue")
    expect(addBtn("cue-a")).toBeDisabled()
    expect(within(rowEl("cue-a")).getByTestId("row-remove-cue-a")).toBeDisabled()
  })
})

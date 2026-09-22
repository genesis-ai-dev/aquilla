/**
 * AQU-646, then AQU-1068 item 5: adding and removing lines from the TEXT
 * TABLE, alongside the gestures the timeline already offers (Sam, 2026-08-11).
 *
 * These controls used to be a `[×][+]` corner that appeared on row hover.
 * They now live in the source cell's ONE menu, in the place the pencil used to
 * sit — Ryder, relaying the Biblica debrief (2026-09-05): the pencil "should
 * be more like a three-dot menu so it can offer more than 'edit text'". Every
 * rule below survived that move unchanged; only the way you reach them did.
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
import { timestampNeighbours } from "@/lib/timeline/timestamp-neighbours"
import type { CellData } from "@/hooks/useCells"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { CellRow } from "@/lib/sync/cells-read-types"

vi.mock("@/lib/timeline/timestamp-neighbours", { spy: true })

vi.mock("@/hooks/useMicPermission", () => ({
  useMicPermission: () => ({ micDenied: true }),
}))

// The table asks this to decide whether the source lane is pinned upstream,
// and it reports `loading: true` on its first render — which the capabilities
// hook treats as LOCKED (default-locked, so a doomed edit is never offered).
// Left real, every assertion about the source entry would depend on how far a
// fetch happened to have got.
const dcsCursor = vi.hoisted(() => ({ value: { cursor: null as string | null, loading: false } }))
vi.mock("@/hooks/useDcsUpstreamCursor", () => ({
  useDcsUpstreamCursor: () => dcsCursor.value,
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

/** A cloud project at a stated rank. `canEditSource` is PROJECT_LEAD (500) and
 *  up, so the rank is what decides whether the source entry is offered. */
const projectAt = (level: number): ProjectRecord =>
  ({ ...project, syncRole: { level } }) as ProjectRecord

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

function renderTable(
  over: Partial<Parameters<typeof EditorTable>[0]> = {},
  actions: Parameters<typeof EditorActionsProvider>[0]["value"] = {},
) {
  const qc = new QueryClient()
  return render(
    <QueryClientProvider client={qc}>
      <EditorActionsProvider value={actions}>
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
  rowActions,
  ...over,
}) as NonNullable<Parameters<typeof EditorTable>[0]["sourceLineEditing"]>

/** The cell's one menu button, and opening it. */
const menuBtn = (cellId: string) =>
  within(rowEl(cellId)).getByTestId(`cell-menu-${cellId}`)
const openMenu = (cellId: string) => { fireEvent.click(menuBtn(cellId)) }
/** Menus are a popup layer, so entries are found on `screen`, not in the row. */
const entry = (name: "insert-above" | "insert-below" | "remove" | "edit-source" | "edit-timestamps") =>
  screen.findByTestId(`cell-menu-${name}`)
const closeMenu = () => {
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" })
}

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
  it("renders nothing at all when there is nothing to offer", async () => {
    // The one case that still hides: no access. A contributor on an untimed
    // file with the workflow off can edit no source text, restructure nothing
    // and retime nothing, so the trigger itself does not render — a
    // permanently empty menu would be furniture.
    renderTable({ project: projectAt(400) })
    await screen.findByText("First cue")
    expect(screen.queryByTestId("cell-menu-cue-a")).toBeNull()
  })

  it("sits where the pencil did, quiet until the row is reached for", async () => {
    // The placement IS a fix in its own right: two earlier cuts put this
    // control outside the row (clipped away by the list's paint containment)
    // and then floating in the middle of it. It now shares the pencil's corner,
    // which is the one place a source-cell action has always lived.
    //
    // AQU-1134 rides on the z-index: the term action rail pops up over this
    // corner at z-20 and used to render BEHIND the pencil, so the trigger
    // stays below it.
    renderTable({ sourceLineEditing: editing() })
    await screen.findByText("First cue")
    const trigger = menuBtn("cue-a")
    expect(trigger.className).toContain("end-1")
    expect(trigger.className).toContain("top-1")
    expect(trigger.className).toContain("z-10")
    expect(trigger.className).toContain("opacity-0")
  })

  it("gives EVERY row a menu, including one with no room after it", async () => {
    // cue-b is absent from the afterCell map — the trailing breath is under the
    // floor. It used to get no `+` at all.
    renderTable({ sourceLineEditing: editing() })
    await screen.findByText("Second cue")
    for (const id of ["cue-a", "added", "cue-b"]) {
      expect(menuBtn(id)).toBeInTheDocument()
    }
  })

  it("offers BOTH directions on a middle row when both silences exist", async () => {
    // "added" sits between the 20-25 gap and the 28-40 one. Round 2 offered
    // only "below" here, on the reasoning that "above me" duplicates the
    // previous row's "below". The duplication is now deliberate: pointing at
    // the row you want to push down is how people describe the act.
    const onAddLineAt = vi.fn()
    renderTable({ sourceLineEditing: editing() }, { onAddLineAt })
    await screen.findByText("First cue")

    openMenu("added")
    fireEvent.click(await entry("insert-above"))
    expect(onAddLineAt).toHaveBeenCalledWith(20, 25)

    openMenu("added")
    fireEvent.click(await entry("insert-below"))
    expect(onAddLineAt).toHaveBeenLastCalledWith(28, 40)
  })

  it("the same silence is reachable from either side of it", async () => {
    // 20-25 is "below cue-a" and "above added". Both doors, one room.
    const onAddLineAt = vi.fn()
    renderTable({ sourceLineEditing: editing() }, { onAddLineAt })
    await screen.findByText("First cue")
    openMenu("cue-a")
    fireEvent.click(await entry("insert-below"))
    expect(onAddLineAt).toHaveBeenCalledWith(20, 25)
  })

  it("shows the unavailable direction DISABLED, with its reason, not missing", async () => {
    renderTable({ sourceLineEditing: editing() })
    await screen.findByText("Second cue")
    openMenu("cue-b")
    const below = await entry("insert-below")
    expect(below).toHaveAttribute("data-disabled")
    expect(within(below).getByTestId("cell-menu-insert-below-reason")).toHaveTextContent(NO_ROOM)
    // ...while the direction that IS available stays live.
    expect(screen.getByTestId("cell-menu-insert-above")).not.toHaveAttribute("data-disabled")
  })

  it("a disabled direction does nothing when clicked", async () => {
    const onAddLineAt = vi.fn()
    renderTable({ sourceLineEditing: editing() }, { onAddLineAt })
    await screen.findByText("Second cue")
    openMenu("cue-b")
    fireEvent.click(await entry("insert-below"))
    expect(onAddLineAt).not.toHaveBeenCalled()
  })

  it("hands the exact silence to the workspace, not the row's own times", async () => {
    // The row spans 25-28s; the silence after it is 28-40s, and it is the
    // SILENCE that must travel.
    const onAddLineAt = vi.fn()
    renderTable({ sourceLineEditing: editing() }, { onAddLineAt })
    await screen.findByText("First cue")
    openMenu("added")
    fireEvent.click(await entry("insert-below"))
    expect(onAddLineAt).toHaveBeenCalledWith(28, 40)
  })

  it("keeps every entry present when a row can do nothing, each explaining itself", async () => {
    // The corner used to disable the `+` ITSELF here, because a menu of
    // nothing but dead items was worse than one explained button. That trade
    // is gone now the menu holds more than inserts: the entries are the
    // explanation, and there is always something else in the list.
    renderTable({
      sourceLineEditing: editing({
        rowActions: () => ({ above: MEDIA_ADD, below: MEDIA_ADD, remove: MEDIA_REMOVE }),
      }),
    })
    await screen.findByText("First cue")
    openMenu("cue-a")
    for (const [name, reason] of [
      ["insert-above", MEDIA_ADD],
      ["insert-below", MEDIA_ADD],
      ["remove", MEDIA_REMOVE],
    ] as const) {
      const item = await entry(name)
      expect(item).toHaveAttribute("data-disabled")
      expect(within(item).getByTestId(`cell-menu-${name}-reason`)).toHaveTextContent(reason)
    }
  })

  it("Remove is always present, and disabled with a reason where it does not apply", async () => {
    renderTable({ sourceLineEditing: editing() })
    await screen.findByText("First cue")
    // A line somebody added here: theirs to take back.
    openMenu("added")
    expect(await entry("remove")).not.toHaveAttribute("data-disabled")
    closeMenu()
    // An imported cue, below maintainer: shown, refused, explained.
    openMenu("cue-a")
    const refused = await entry("remove")
    expect(refused).toHaveAttribute("data-disabled")
    expect(within(refused).getByTestId("cell-menu-remove-reason")).toHaveTextContent(MAINTAINER_ONLY)
  })

  it("Remove reaches the workspace with the row's id", async () => {
    const onRemoveCell = vi.fn()
    renderTable({ sourceLineEditing: editing() }, { onRemoveCell })
    await screen.findByText("First cue")
    openMenu("added")
    fireEvent.click(await entry("remove"))
    expect(onRemoveCell).toHaveBeenCalledWith("added")
  })

  it("a disabled Remove does not reach the workspace", async () => {
    const onRemoveCell = vi.fn()
    renderTable({ sourceLineEditing: editing() }, { onRemoveCell })
    await screen.findByText("First cue")
    openMenu("cue-a")
    fireEvent.click(await entry("remove"))
    expect(onRemoveCell).not.toHaveBeenCalled()
  })

  it("the first row's above direction is the head silence", async () => {
    const onAddLineAt = vi.fn()
    renderTable({ sourceLineEditing: editing() }, { onAddLineAt })
    await screen.findByText("First cue")
    openMenu("cue-a")
    fireEvent.click(await entry("insert-above"))
    expect(onAddLineAt).toHaveBeenCalledWith(0, 10)
  })

  it("with no leading silence the first row's above is disabled, not absent", async () => {
    renderTable({ sourceLineEditing: editing({ head: null }) })
    await screen.findByText("First cue")
    openMenu("cue-a")
    expect(await entry("insert-above")).toHaveAttribute("data-disabled")
  })
})

/**
 * AQU-1068 item 5: the entries that are NOT structural.
 *
 * The menu replaced the source pencil, so editing the source text is one of
 * its entries now — including the DCS-pinned case, where the pencil used to be
 * swapped for a padlock so the affordance never silently vanished (AQU-615).
 * That is the same idea, as the entry's own reason.
 */
describe("EditorTable — the source-text entry", () => {
  it("opens the menu on its own when there is nothing structural to offer", async () => {
    // No `sourceLineEditing` at all, but a project lead may edit source text.
    renderTable({ project: projectAt(500) })
    await screen.findByText("First cue")
    openMenu("cue-a")
    expect(await entry("edit-source")).not.toHaveAttribute("data-disabled")
    expect(screen.queryByTestId("cell-menu-insert-above")).toBeNull()
    expect(screen.queryByTestId("cell-menu-remove")).toBeNull()
  })

  it("renders disabled with the lock's reason where the pencil became a padlock", async () => {
    // A DCS-pinned source: the rank is high enough, the repository is not.
    dcsCursor.value = { cursor: "abc123", loading: false }
    try {
      renderTable({ project: projectAt(500) })
      await screen.findByText("First cue")
      openMenu("cue-a")
      const item = await entry("edit-source")
      expect(item).toHaveAttribute("data-disabled")
      expect(within(item).getByTestId("cell-menu-edit-source-reason")).toHaveTextContent(/./)
    } finally {
      dcsCursor.value = { cursor: null, loading: false }
    }
  })

  it("is absent when this person simply may not edit source text", async () => {
    // No permission and no reason to give: the entry does not exist, and the
    // menu is carried by the structural entries alone.
    renderTable({ project: projectAt(400), sourceLineEditing: editing() })
    await screen.findByText("First cue")
    openMenu("cue-a")
    await entry("insert-above")
    expect(screen.queryByTestId("cell-menu-edit-source")).toBeNull()
  })
})

/**
 * AQU-1068: the same menu, on a file with no clock.
 *
 * An ordinary text file has no silences to measure, so every row can take a
 * cell on either side. That difference is resolved in the workspace and
 * arrives as one flag, which is why the menu never has to know what a second
 * is — it just asks the context to insert beside a cell id.
 */
describe("EditorTable — structural controls on an untimed file", () => {
  const untimedEditing = (over: Record<string, unknown> = {}) =>
    editing({
      // Supplied empty: an untimed file has no silences, and the shape is
      // shared with the timed path rather than made optional for one caller.
      head: null,
      afterCell: new Map(),
      untimed: true,
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
      openMenu(id)
      expect(await entry("insert-above")).not.toHaveAttribute("data-disabled")
      expect(screen.getByTestId("cell-menu-insert-below")).not.toHaveAttribute("data-disabled")
      closeMenu()
    }
  })

  it("passes the row's own id to the insert, not a time span", async () => {
    const onInsertCellBeside = vi.fn()
    renderTable({ sourceLineEditing: untimedEditing() }, { onInsertCellBeside })
    await screen.findByText("Second cue")
    openMenu("cue-b")
    fireEvent.click(await entry("insert-below"))
    expect(onInsertCellBeside).toHaveBeenCalledWith("cue-b", "below")
  })

  it("insert above passes the row's id too", async () => {
    const onInsertCellBeside = vi.fn()
    renderTable({ sourceLineEditing: untimedEditing() }, { onInsertCellBeside })
    await screen.findByText("First cue")
    openMenu("cue-a")
    fireEvent.click(await entry("insert-above"))
    expect(onInsertCellBeside).toHaveBeenCalledWith("cue-a", "above")
  })

  it("never reaches for the timed path on a file with no clock", async () => {
    // The spans are empty here, so an untimed insert that went looking for one
    // would silently do nothing — the failure this flag exists to prevent.
    const onAddLineAt = vi.fn()
    const onInsertCellBeside = vi.fn()
    renderTable({ sourceLineEditing: untimedEditing() }, { onAddLineAt, onInsertCellBeside })
    await screen.findByText("First cue")
    openMenu("added")
    fireEvent.click(await entry("insert-below"))
    expect(onAddLineAt).not.toHaveBeenCalled()
    expect(onInsertCellBeside).toHaveBeenCalledWith("added", "below")
  })

  it("still asks the workspace what is removable", async () => {
    renderTable({
      sourceLineEditing: untimedEditing({
        rowActions: () => ({ above: null, below: null, remove: null }),
      }),
    })
    await screen.findByText("First cue")
    openMenu("cue-a")
    expect(await entry("remove")).not.toHaveAttribute("data-disabled")
  })

  it("a media row refuses everything, answering each action in its own words", async () => {
    // An MP3 import: every row IS audio. It used to render nothing at all,
    // which is the case that started round 3.
    renderTable({
      sourceLineEditing: untimedEditing({
        rowActions: () => ({ above: MEDIA_ADD, below: MEDIA_ADD, remove: MEDIA_REMOVE }),
      }),
    })
    await screen.findByText("First cue")
    openMenu("cue-a")
    expect(await entry("insert-above")).toHaveAttribute("data-disabled")
    expect(screen.getByTestId("cell-menu-remove")).toHaveAttribute("data-disabled")
    expect(screen.getByTestId("cell-menu-remove-reason")).toHaveTextContent(MEDIA_REMOVE)
  })

  it("offers no timestamps entry — an untimed file has none to edit", async () => {
    // Sam, 2026-09-09: hidden rather than disabled. Not a permission, just a
    // fact about the file, and a dead entry on every text project is furniture.
    vi.mocked(timestampNeighbours).mockClear()
    renderTable({ sourceLineEditing: untimedEditing() })
    await screen.findByText("First cue")
    openMenu("cue-a")
    await entry("insert-above")
    expect(screen.queryByTestId("cell-menu-edit-timestamps")).toBeNull()
    expect(timestampNeighbours).toHaveBeenCalled()
    expect(vi.mocked(timestampNeighbours).mock.calls.every((call) => call[3] === false)).toBe(true)
  })
})

/**
 * AQU-1068 item 5: typing a line's start and end.
 *
 * Greenlit by Sam (2026-09-09) off Ryder's menu note. Dragging a chip is the
 * right tool for "about here" and the wrong one for "exactly 1:02.500", which
 * is what a subtitle conformed against a script needs.
 *
 * The permission here is the project's TIMING LOCK, not the cell-editing tier:
 * moving a line in time is not restructuring the file, and the timeline's drag
 * has always answered to the lock alone.
 */
describe("EditorTable — the timestamps entry", () => {
  /** The store's rows are timed, so a time-ordered file offers the entry. */
  const timed = { orderedBy: "time" as const }

  it("is offered on a timed file", async () => {
    renderTable(timed)
    await screen.findByText("First cue")
    openMenu("cue-a")
    expect(await entry("edit-timestamps")).not.toHaveAttribute("data-disabled")
  })

  it("is HIDDEN on a file with no clock, not disabled", async () => {
    // Sam, 2026-09-09: not a permission, just a fact about the file — and a
    // dead entry on every text project is furniture rather than an
    // explanation.
    renderTable({ project: projectAt(500) })
    await screen.findByText("First cue")
    openMenu("cue-a")
    await entry("edit-source")
    expect(screen.queryByTestId("cell-menu-edit-timestamps")).toBeNull()
  })

  it("seeds the fields from the row, in the timeline's own precise format", async () => {
    // `fmtDragTime` — MM:SS.mmm, what the drag readout shows. The idle chip's
    // tenths would silently drop precision the moment somebody saved.
    renderTable(timed)
    await screen.findByText("First cue")
    openMenu("cue-a")
    fireEvent.click(await entry("edit-timestamps"))
    expect(await screen.findByTestId("cell-times-start")).toHaveValue("00:10.000")
    expect(screen.getByTestId("cell-times-end")).toHaveValue("00:20.000")
  })

  it("saves what was typed, through the workspace's retime handler", async () => {
    const onRetimeCell = vi.fn()
    renderTable(timed, { onRetimeCell })
    await screen.findByText("First cue")
    openMenu("cue-a")
    fireEvent.click(await entry("edit-timestamps"))
    fireEvent.change(await screen.findByTestId("cell-times-start"), { target: { value: "0:12.5" } })
    fireEvent.click(screen.getByTestId("cell-times-save"))
    expect(onRetimeCell).toHaveBeenCalledWith("cue-a", 12.5, 20)
  })

  it("refuses a value it cannot read, and saves nothing", async () => {
    const onRetimeCell = vi.fn()
    renderTable(timed, { onRetimeCell })
    await screen.findByText("First cue")
    openMenu("cue-a")
    fireEvent.click(await entry("edit-timestamps"))
    fireEvent.change(await screen.findByTestId("cell-times-start"), { target: { value: "half past" } })
    fireEvent.click(screen.getByTestId("cell-times-save"))
    expect(onRetimeCell).not.toHaveBeenCalled()
    expect(screen.getByTestId("cell-times-error")).toBeInTheDocument()
  })

  it("ALLOWS a span that runs far past the line after it", async () => {
    // Sam, 2026-09-09: overlap is allowed in full. Two speakers talking over
    // each other is a real thing a subtitle says, and the timed exporters
    // already sort by start time. The END never decides order, so nothing
    // bounds it.
    //
    // `added` runs 25-28s; the cue after it starts at 40s.
    const onRetimeCell = vi.fn()
    renderTable(timed, { onRetimeCell })
    await screen.findByText("First cue")
    openMenu("added")
    fireEvent.click(await entry("edit-timestamps"))
    fireEvent.change(await screen.findByTestId("cell-times-end"), { target: { value: "0:55" } })
    fireEvent.click(screen.getByTestId("cell-times-save"))
    expect(onRetimeCell).toHaveBeenCalledWith("added", 25, 55)
  })

  it("ALLOWS a start under the tail of the line before it", async () => {
    // `cue-a` runs 10-20s and `added` starts at 25s. Moving `added` back to
    // 15s puts it inside `cue-a` — an overlap, not a reorder, because its
    // start is still after `cue-a`'s.
    const onRetimeCell = vi.fn()
    renderTable(timed, { onRetimeCell })
    await screen.findByText("First cue")
    openMenu("added")
    fireEvent.click(await entry("edit-timestamps"))
    fireEvent.change(await screen.findByTestId("cell-times-start"), { target: { value: "0:15" } })
    fireEvent.click(screen.getByTestId("cell-times-save"))
    expect(onRetimeCell).toHaveBeenCalledWith("added", 15, 28)
  })

  it("refuses a start pushed past the NEXT line's start", async () => {
    // The one limit. Order in the media lens and in every timed export is by
    // start time, while the text table reads the anchor chain — so a start
    // crossing its neighbour's is what would part the two.
    const onRetimeCell = vi.fn()
    renderTable(timed, { onRetimeCell })
    await screen.findByText("First cue")
    openMenu("added")
    fireEvent.click(await entry("edit-timestamps"))
    // Both fields, or the span would be inverted as well — and the span's own
    // incoherence is the more actionable answer, so it is reported first.
    fireEvent.change(await screen.findByTestId("cell-times-start"), { target: { value: "0:45" } })
    fireEvent.change(screen.getByTestId("cell-times-end"), { target: { value: "0:50" } })
    fireEvent.click(screen.getByTestId("cell-times-save"))
    expect(onRetimeCell).not.toHaveBeenCalled()
    // Names the line it would pass and where that line starts.
    expect(screen.getByTestId("cell-times-error")).toHaveTextContent(/00:40\.000/)
  })

  it("refuses a start pulled above the PREVIOUS line's start", async () => {
    // The half a rule naming only the following line would miss.
    const onRetimeCell = vi.fn()
    renderTable(timed, { onRetimeCell })
    await screen.findByText("First cue")
    openMenu("added")
    fireEvent.click(await entry("edit-timestamps"))
    fireEvent.change(await screen.findByTestId("cell-times-start"), { target: { value: "0:05" } })
    fireEvent.click(screen.getByTestId("cell-times-save"))
    expect(onRetimeCell).not.toHaveBeenCalled()
    expect(screen.getByTestId("cell-times-error")).toHaveTextContent(/00:10\.000/)
  })

  it("refuses an end at or before its start, and keeps what was typed", async () => {
    // Refused rather than repaired — silently swapping two fields somebody
    // just typed is the worse surprise, and it guesses which they meant.
    const onRetimeCell = vi.fn()
    renderTable(timed, { onRetimeCell })
    await screen.findByText("First cue")
    openMenu("cue-a")
    fireEvent.click(await entry("edit-timestamps"))
    fireEvent.change(await screen.findByTestId("cell-times-end"), { target: { value: "0:05" } })
    fireEvent.click(screen.getByTestId("cell-times-save"))
    expect(onRetimeCell).not.toHaveBeenCalled()
    expect(screen.getByTestId("cell-times-error")).toBeInTheDocument()
    expect(screen.getByTestId("cell-times-end")).toHaveValue("0:05")
  })

  it("refuses a zero-length span too", async () => {
    const onRetimeCell = vi.fn()
    renderTable(timed, { onRetimeCell })
    await screen.findByText("First cue")
    openMenu("cue-a")
    fireEvent.click(await entry("edit-timestamps"))
    fireEvent.change(await screen.findByTestId("cell-times-end"), { target: { value: "00:10.000" } })
    fireEvent.click(screen.getByTestId("cell-times-save"))
    expect(onRetimeCell).not.toHaveBeenCalled()
    expect(screen.getByTestId("cell-times-error")).toBeInTheDocument()
  })

  it("refuses an imported audio row in its own words", async () => {
    renderTable({
      ...timed,
      sourceLineEditing: editing({
        rowActions: () => ({ above: MEDIA_ADD, below: MEDIA_ADD, remove: MEDIA_REMOVE }),
      }),
      cellStore: (() => {
        const store = makeStore()
        store.replaceRowsForCell("cue-a", [
          row("cue-a", "source", "First cue", { startMs: 10_000, endMs: 20_000, medium: "media" }),
        ])
        return store
      })(),
    })
    await screen.findByText("First cue")
    openMenu("cue-a")
    const item = await entry("edit-timestamps")
    expect(item).toHaveAttribute("data-disabled")
    expect(within(item).getByTestId("cell-menu-edit-timestamps-reason")).toHaveTextContent(MEDIA_REMOVE)
  })
})

/**
 * The project-wide timing lock (AQU-646). Sam, 2026-09-09: it must never work
 * while locked — and a maintainer should be sent to the SETTING rather than
 * having it flipped from under a row, because the lock covers every file and
 * they should see that scope before changing it.
 */
describe("EditorTable — timestamps while the project's timings are locked", () => {
  const timed = { orderedBy: "time" as const }
  const LOCKED = "Timing is locked for this project."

  it("greys the entry for someone who cannot lift the lock", async () => {
    renderTable(timed, { timingLocked: true, canUnlockTiming: false })
    await screen.findByText("First cue")
    openMenu("cue-a")
    const item = await entry("edit-timestamps")
    expect(item).toHaveAttribute("data-disabled")
    expect(within(item).getByTestId("cell-menu-edit-timestamps-reason")).toHaveTextContent(LOCKED)
  })

  it("still lets a line somebody ADDED here be retimed", async () => {
    // AQU-646's exemption: a line added here carries no imported timing to
    // corrupt, so the lock leaves it movable — the same rule the drag follows.
    renderTable(timed, { timingLocked: true, canUnlockTiming: false })
    await screen.findByText("First cue")
    openMenu("added")
    expect(await entry("edit-timestamps")).not.toHaveAttribute("data-disabled")
  })

  it("opens INERT for a maintainer, pointing at the setting rather than flipping it", async () => {
    const onOpenTimingSettings = vi.fn()
    const onRetimeCell = vi.fn()
    renderTable(timed, {
      timingLocked: true,
      canUnlockTiming: true,
      onOpenTimingSettings,
      onRetimeCell,
    })
    await screen.findByText("First cue")
    openMenu("cue-a")
    fireEvent.click(await entry("edit-timestamps"))

    // The fields are there but dead, and the reason is stated.
    expect(await screen.findByTestId("cell-times-locked")).toHaveTextContent(LOCKED)
    expect(screen.getByTestId("cell-times-start")).toBeDisabled()
    // No save at all while locked — there is nothing to save.
    expect(screen.queryByTestId("cell-times-save")).toBeNull()

    fireEvent.click(screen.getByTestId("cell-times-unlock"))
    expect(onOpenTimingSettings).toHaveBeenCalled()
    // It navigates; it does NOT quietly unlock the whole project.
    expect(onRetimeCell).not.toHaveBeenCalled()
  })

  it("offers no way in at all to someone who cannot lift it", async () => {
    renderTable(timed, { timingLocked: true, canUnlockTiming: false })
    await screen.findByText("First cue")
    openMenu("cue-a")
    fireEvent.click(await entry("edit-timestamps"))
    expect(screen.queryByTestId("cell-times-unlock")).toBeNull()
  })
})

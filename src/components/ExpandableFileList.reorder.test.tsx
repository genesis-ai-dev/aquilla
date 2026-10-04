// AQU-1569 — hand-placed file order in the editor sidebar: the drag, the
// Move up/down menu items, the cross-group refusal, Reset order, and the role
// gate. UI-only journey, so RTL rather than a smoke spec (AGENTS.md rule 4).
// AQU-1647 drives the drag with dnd-kit pointer events; the writes are unchanged.
//
// What these tests pin is the WIRING, not the arithmetic: every assertion is
// about which writes the component asks for. The numbers in those writes are
// src/lib/sidebar/file-sort-index.test.ts's job, and keeping the two apart is
// what lets the drag and the menu provably agree.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, within, fireEvent } from "@testing-library/react"
import { ExpandableFileList } from "./ExpandableFileList"
import { FILE_DRAG_ACTIVATION_DISTANCE } from "./file-list-dnd-model"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import { EditorScrollProvider } from "@/context/EditorScrollContext"
import type { FileReference } from "@/lib/parsers/types"
import { planFileInsert, SORT_INDEX_STEP, type SortIndexWrite } from "@/lib/sidebar/file-sort-index"

const PROJECT_ID = "p1"

function file(name: string, extra: Partial<FileReference> = {}): FileReference {
  return {
    id: name.toLowerCase().replace(/\s+/g, "-"),
    name,
    type: "usfm",
    createdAt: "2026-01-01T00:00:00.000Z",
    cellCount: 0,
    ...extra,
  }
}

/** A season whose files a lead has already placed: 1, 2, 3, 10. */
const PLACED_SEASON = [
  file("Episode 1", { corpusMarker: "Season 1", sortIndex: 0 }),
  file("Episode 2", { corpusMarker: "Season 1", sortIndex: SORT_INDEX_STEP }),
  file("Episode 3", { corpusMarker: "Season 1", sortIndex: SORT_INDEX_STEP * 2 }),
  file("Episode 10", { corpusMarker: "Season 1", sortIndex: SORT_INDEX_STEP * 3 }),
]

/** The same season before anyone touched it — alphabetical, so 10 lands second. */
const UNPLACED_SEASON = [
  file("Episode 1", { corpusMarker: "Season 1" }),
  file("Episode 10", { corpusMarker: "Season 1" }),
  file("Episode 2", { corpusMarker: "Season 1" }),
  file("Episode 3", { corpusMarker: "Season 1" }),
]

let onReorderFiles: ReturnType<typeof vi.fn<(writes: SortIndexWrite[]) => void>>
let onTransferFile: ReturnType<typeof vi.fn<(fileId: string, corpus: string, writes: SortIndexWrite[]) => void>>

function renderList(
  files: FileReference[],
  props: Partial<React.ComponentProps<typeof ExpandableFileList>> = {},
) {
  return render(
    <I18nProvider>
      <EditorScrollProvider>
        <ExpandableFileList
          projectId={PROJECT_ID}
          files={files}
          activeFileId={null}
          fileProgress={new Map()}
          suggestionFileIds={new Set()}
          validationCount={0}
          getTokenForFile={async () => null}
          onSelectFile={vi.fn()}
          onRename={vi.fn()}
          onMove={vi.fn()}
          canReorderFiles
          onReorderFiles={onReorderFiles}
          onTransferFile={onTransferFile}
          {...props}
        />
      </EditorScrollProvider>
    </I18nProvider>,
  )
}

/** The dnd-kit slot around a file's row. */
function slot(name: string): HTMLElement {
  const row = screen.getByRole("button", { name })
  const found = row.closest('[data-reorderable="true"]')
  if (!found) throw new Error(`no reorderable slot around "${name}"`)
  return found as HTMLElement
}

function box(top: number, height: number, left = 0, width = 200): DOMRect {
  return {
    x: left,
    y: top,
    top,
    left,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON() { return {} },
  } as DOMRect
}

/** happy-dom reports every rect as empty, and dnd-kit decides the drop from those rects. */
function layoutReorderTargets() {
  const groups = [...document.querySelectorAll<HTMLElement>("[data-reorder-group]")]
  let top = 200
  for (const group of groups) {
    const slots = [...group.querySelectorAll<HTMLElement>('[data-reorderable="true"]')]
    const start = top
    for (const slotEl of slots) {
      const slotTop = top
      slotEl.getBoundingClientRect = () => box(slotTop, 40)
      top += 40
    }
    const groupTop = start - 28
    group.getBoundingClientRect = () => box(groupTop, top - groupTop)
    top += 16
  }
}

function pointerInit(x: number, y: number, buttons = 1) {
  return {
    clientX: x,
    clientY: y,
    button: 0,
    buttons,
    isPrimary: true,
    pointerId: 1,
    pointerType: "mouse" as const,
  }
}

function center(element: HTMLElement) {
  const rect = element.getBoundingClientRect()
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
}

/** The grip. The row around it is a click, not a drag. */
function reorderHandle(name: string): HTMLElement {
  const found = slot(name).querySelector("[data-reorder-handle]")
  if (!(found instanceof HTMLElement)) throw new Error(`no reorder handle for "${name}"`)
  return found
}

function beginDrag(name: string) {
  layoutReorderTargets()
  const element = reorderHandle(name)
  const host = slot(name).getBoundingClientRect()
  element.getBoundingClientRect = () => box(host.top, host.height, host.left, 16)
  const point = center(element)
  fireEvent.pointerDown(element, pointerInit(point.x, point.y))
  // The move that crosses the activation distance only starts the drag.
  // A second move is what publishes the pointer position.
  const nudged = pointerInit(point.x, point.y + FILE_DRAG_ACTIVATION_DISTANCE + 8)
  fireEvent.pointerMove(document, nudged)
  fireEvent.pointerMove(document, nudged)
}

function hoverDrag(name: string) {
  const point = center(slot(name))
  fireEvent.pointerMove(document, pointerInit(point.x, point.y))
}

function releaseDrag(name: string) {
  const point = center(slot(name))
  fireEvent.pointerUp(document, pointerInit(point.x, point.y, 0))
}

/** Drag `from` onto `to`, the way a pointer does. */
function dragOnto(from: string, to: string) {
  beginDrag(from)
  hoverDrag(to)
  releaseDrag(to)
}

// role="status" does not take its accessible name from its text, and dnd-kit
// mounts a second (empty) status live region, so the message is found by text.
const refusalText = /only be reordered inside its own group/i
const refusal = () => screen.queryByText(refusalText)

// Every row's ⋯ trigger has the same accessible name, so it has to be found
// within that row. The popup itself portals out, hence screen-level queries
// for the items.
function openRowMenu(name: string) {
  const row = screen.getByRole("button", { name }).closest('[data-showcase="sidebar.file"]')
  if (!row) throw new Error(`no row element for "${name}"`)
  fireEvent.click(within(row as HTMLElement).getByRole("button", { name: "File actions" }))
}

const clickCaptures: Array<{
  fn: EventListenerOrEventListenerObject
  options?: boolean | AddEventListenerOptions
}> = []
let restoreAddEventListener: (() => void) | null = null

beforeEach(() => {
  localStorage.clear()
  onReorderFiles = vi.fn<(writes: SortIndexWrite[]) => void>()
  onTransferFile = vi.fn<(fileId: string, corpus: string, writes: SortIndexWrite[]) => void>()
  HTMLElement.prototype.scrollIntoView = vi.fn()
  // dnd-kit swallows the click that ends a drag, and only removes that
  // document listener after 50ms. Later tests click menus in this same
  // document, so the capture is recorded and dropped when the test ends.
  const original = document.addEventListener.bind(document)
  document.addEventListener = (
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ) => {
    if (type === "click") clickCaptures.push({ fn: listener, options })
    original(type, listener, options)
  }
  restoreAddEventListener = () => {
    document.addEventListener = original
  }
})

afterEach(() => {
  for (const capture of clickCaptures) {
    document.removeEventListener("click", capture.fn, capture.options)
  }
  clickCaptures.length = 0
  restoreAddEventListener?.()
  restoreAddEventListener = null
})

describe("dragging a file within its group", () => {
  it("asks for the writes that put the dragged file in the target's slot", () => {
    renderList(PLACED_SEASON)
    // Episode 10 is last; drop it on Episode 2's slot.
    dragOnto("Episode 10", "Episode 2")
    expect(onReorderFiles).toHaveBeenCalledTimes(1)
    // A fully-placed group is the steady state: one midpoint, one write.
    expect(onReorderFiles.mock.calls[0][0]).toEqual([
      { fileId: "episode-10", sortIndex: SORT_INDEX_STEP / 2 },
    ])
  })

  it("stamps the whole group on the first reorder it has ever had", () => {
    renderList(UNPLACED_SEASON)
    // The AQU-1569 worked example: drag Episode 10 below Episode 3.
    dragOnto("Episode 10", "Episode 3")
    expect(onReorderFiles.mock.calls[0][0]).toEqual([
      { fileId: "episode-1", sortIndex: 0 },
      { fileId: "episode-2", sortIndex: SORT_INDEX_STEP },
      { fileId: "episode-3", sortIndex: SORT_INDEX_STEP * 2 },
      { fileId: "episode-10", sortIndex: SORT_INDEX_STEP * 3 },
    ])
  })

  it("asks for nothing when a file is dropped back on itself", () => {
    renderList(PLACED_SEASON)
    dragOnto("Episode 2", "Episode 2")
    expect(onReorderFiles).not.toHaveBeenCalled()
  })

  it("still opens the file on click, and the slot is not a native drag source", () => {
    const onSelectFile = vi.fn()
    renderList(PLACED_SEASON, { onSelectFile })
    const episode = slot("Episode 2")
    expect(episode.getAttribute("draggable")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Episode 2" }))
    expect(onSelectFile).toHaveBeenCalledWith("episode-2")
    expect(onReorderFiles).not.toHaveBeenCalled()
  })

  it("does not reorder when the pointer slides across the file name", () => {
    renderList(PLACED_SEASON)
    layoutReorderTargets()
    const name = screen.getByRole("button", { name: "Episode 10" })
    const host = slot("Episode 10").getBoundingClientRect()
    name.getBoundingClientRect = () => box(host.top, host.height, host.left + 24, host.width - 24)
    const point = center(name)
    fireEvent.pointerDown(name, pointerInit(point.x, point.y))
    const nudged = pointerInit(point.x, point.y + FILE_DRAG_ACTIVATION_DISTANCE + 24)
    fireEvent.pointerMove(document, nudged)
    fireEvent.pointerMove(document, pointerInit(point.x, host.top + 120))
    fireEvent.pointerUp(document, pointerInit(point.x, host.top + 120, 0))
    expect(onReorderFiles).not.toHaveBeenCalled()
  })
})

describe("a drop into another custom corpus", () => {
  const TWO_SEASONS = [
    ...PLACED_SEASON,
    file("Pilot", { corpusMarker: "Season 2", sortIndex: 0 }),
    file("Finale", { corpusMarker: "Season 2", sortIndex: SORT_INDEX_STEP }),
  ]

  it("asks to move the file into that corpus at the hovered slot", () => {
    renderList(TWO_SEASONS)
    beginDrag("Episode 2")
    hoverDrag("Pilot")
    expect(screen.queryByText(/drop to move into/i)).toBeNull()
    const season2 = document.querySelector('[data-reorder-group="Season 2"]')
    expect(season2).not.toBeNull()
    expect(within(season2 as HTMLElement).getByRole("button", { name: "Episode 2" })).toBeInTheDocument()
    releaseDrag("Pilot")
    expect(onReorderFiles).not.toHaveBeenCalled()
    expect(onTransferFile).toHaveBeenCalledWith(
      "episode-2",
      "Season 2",
      planFileInsert(
        [
          { id: "pilot", sortIndex: 0 },
          { id: "finale", sortIndex: SORT_INDEX_STEP },
        ],
        "episode-2",
        0,
      ),
    )
  })

  it("lets the only file in a custom corpus be dragged into another one", () => {
    renderList([
      file("Only", { corpusMarker: "Season 1", sortIndex: 0 }),
      file("Pilot", { corpusMarker: "Season 2", sortIndex: 0 }),
      file("Finale", { corpusMarker: "Season 2", sortIndex: SORT_INDEX_STEP }),
    ])
    dragOnto("Only", "Finale")
    expect(onTransferFile).toHaveBeenCalledWith(
      "only",
      "Season 2",
      expect.any(Array),
    )
    expect(onReorderFiles).not.toHaveBeenCalled()
  })
})

describe("a drop onto a testament folder is refused", () => {
  const OT_AND_SEASON = [
    file("Genesis", { corpusMarker: "OT", sortIndex: 0 }),
    file("Exodus", { corpusMarker: "OT", sortIndex: SORT_INDEX_STEP }),
    file("Pilot", { corpusMarker: "Season 1", sortIndex: 0 }),
    file("Finale", { corpusMarker: "Season 1", sortIndex: SORT_INDEX_STEP }),
  ]

  it("says so visibly and changes nothing — no move, no corpus change", () => {
    renderList(OT_AND_SEASON)
    beginDrag("Pilot")
    hoverDrag("Genesis")

    // Visible, not just a cursor shape: a silent no-op is indistinguishable
    // from a drop that failed. role="status" is what a screen reader hears.
    expect(screen.getByText(refusalText)).toHaveAttribute("role", "status")

    releaseDrag("Genesis")
    expect(onReorderFiles).not.toHaveBeenCalled()
    expect(onTransferFile).not.toHaveBeenCalled()
  })

  it("also refuses dragging a testament file into a custom corpus", () => {
    renderList(OT_AND_SEASON)
    dragOnto("Genesis", "Pilot")
    expect(onTransferFile).not.toHaveBeenCalled()
    expect(onReorderFiles).not.toHaveBeenCalled()
  })

  it("clears the refusal once the drag ends", () => {
    renderList(OT_AND_SEASON)
    beginDrag("Pilot")
    hoverDrag("Genesis")
    expect(refusal()).not.toBeNull()
    releaseDrag("Pilot")
    expect(refusal()).toBeNull()
  })

  it("ignores the native HTML drag events this list used to listen for", () => {
    renderList(OT_AND_SEASON)
    fireEvent.dragStart(slot("Pilot"))
    fireEvent.dragOver(slot("Genesis"))
    fireEvent.drop(slot("Genesis"))
    expect(onReorderFiles).not.toHaveBeenCalled()
    expect(onTransferFile).not.toHaveBeenCalled()
    expect(refusal()).toBeNull()
  })
})

describe("Move up / Move down", () => {
  it("moves a file one slot and asks for the same kind of write a drag does", () => {
    renderList(PLACED_SEASON)
    openRowMenu("Episode 3")
    fireEvent.click(screen.getByRole("menuitem", { name: "Move up" }))
    expect(onReorderFiles.mock.calls[0][0]).toEqual([
      // Between Episode 1 (0) and Episode 2 (STEP).
      { fileId: "episode-3", sortIndex: SORT_INDEX_STEP / 2 },
    ])
  })

  // Base UI renders a menu item as a div, so the disabled state is carried by
  // aria-disabled rather than the native attribute jest-dom's toBeDisabled
  // looks for.
  const moveItem = (label: "Move up" | "Move down") =>
    screen.getByRole("menuitem", { name: label })

  it("disables Move up on the first file, and leaves Move down live", () => {
    renderList(PLACED_SEASON)
    openRowMenu("Episode 1")
    expect(moveItem("Move up")).toHaveAttribute("aria-disabled", "true")
    expect(moveItem("Move down")).not.toHaveAttribute("aria-disabled", "true")
  })

  it("disables Move down on the last file, and leaves Move up live", () => {
    renderList(PLACED_SEASON)
    openRowMenu("Episode 10")
    expect(moveItem("Move down")).toHaveAttribute("aria-disabled", "true")
    expect(moveItem("Move up")).not.toHaveAttribute("aria-disabled", "true")
  })

  // The disabled state and the write agree because both ask planFileNudge.
  it("asks for nothing if the disabled end item is activated anyway", () => {
    renderList(PLACED_SEASON)
    openRowMenu("Episode 1")
    fireEvent.click(moveItem("Move up"))
    expect(onReorderFiles).not.toHaveBeenCalled()
  })
})

describe("Reset order", () => {
  const resetButton = () => screen.queryByRole("button", { name: "Reset the order of Season 1" })

  it("is offered only once some file in the group has been placed by hand", () => {
    renderList(UNPLACED_SEASON)
    expect(resetButton()).toBeNull()
  })

  it("confirms before it runs, and clears every placed file on confirm", () => {
    renderList(PLACED_SEASON)
    fireEvent.click(resetButton()!)
    // Nothing has happened yet — the confirmation is the point.
    expect(onReorderFiles).not.toHaveBeenCalled()
    expect(screen.getByRole("alertdialog")).toHaveTextContent(/back in automatic order/i)

    fireEvent.click(screen.getByRole("button", { name: "Reset order" }))
    expect(onReorderFiles.mock.calls[0][0]).toEqual([
      { fileId: "episode-1", sortIndex: null },
      { fileId: "episode-2", sortIndex: null },
      { fileId: "episode-3", sortIndex: null },
      { fileId: "episode-10", sortIndex: null },
    ])
  })

  it("changes nothing when the confirmation is cancelled", () => {
    renderList(PLACED_SEASON)
    fireEvent.click(resetButton()!)
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(onReorderFiles).not.toHaveBeenCalled()
  })
})

describe("the role gate", () => {
  it("withholds every affordance below Project Lead, rather than letting it 403", () => {
    renderList(PLACED_SEASON, { canReorderFiles: false })
    expect(document.querySelector('[data-reorderable="true"]')).toBeNull()
    expect(screen.queryByRole("button", { name: "Reset the order of Season 1" })).toBeNull()
    openRowMenu("Episode 2")
    expect(screen.queryByRole("menuitem", { name: "Move up" })).toBeNull()
    expect(screen.queryByRole("menuitem", { name: "Move down" })).toBeNull()
  })
})

describe("reordering is held back while the list is filtered", () => {
  // A filtered list is a SUBSET of the group. Positions computed against it
  // would stamp indices that push every hidden file in the group to the end —
  // so the affordances go away until the filter is cleared.
  it("drops the drag handle, the menu items and Reset order under a filter", () => {
    renderList(PLACED_SEASON)
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter files" }), {
      target: { value: "Episode" },
    })
    expect(document.querySelector('[data-reorderable="true"]')).toBeNull()
    expect(screen.queryByRole("button", { name: "Reset the order of Season 1" })).toBeNull()
  })
})

describe("a project whose files are all ungrouped", () => {
  // It shows no group header at all, so the Reset control cannot live only
  // inside the header — that project could be given an order and then have
  // no way back to the automatic one.
  const UNGROUPED = [
    file("notes", { sortIndex: 0 }),
    file("readme", { sortIndex: SORT_INDEX_STEP }),
  ]

  it("can still be reordered, and still reset", () => {
    renderList(UNGROUPED)
    expect(document.querySelectorAll('[data-reorderable="true"]')).toHaveLength(2)
    const reset = screen.getByRole("button", { name: "Reset the order of Ungrouped" })
    fireEvent.click(reset)
    fireEvent.click(screen.getByRole("button", { name: "Reset order" }))
    expect(onReorderFiles.mock.calls[0][0]).toEqual([
      { fileId: "notes", sortIndex: null },
      { fileId: "readme", sortIndex: null },
    ])
  })

  it("offers no reset before anything has been placed", () => {
    renderList([file("notes"), file("readme")])
    expect(screen.queryByRole("button", { name: "Reset the order of Ungrouped" })).toBeNull()
  })
})

describe("a group of one", () => {
  it("offers no reorder — there is nowhere to move the file to", () => {
    renderList([file("Only", { corpusMarker: "Season 1", sortIndex: 0 })])
    expect(document.querySelector('[data-reorderable="true"]')).toBeNull()
    openRowMenu("Only")
    expect(screen.queryByRole("menuitem", { name: "Move up" })).toBeNull()
  })
})

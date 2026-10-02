// AQU-1569 — hand-placed file order in the editor sidebar: the drag, the
// Move up/down menu items, the cross-group refusal, Reset order, and the role
// gate. UI-only journey, so RTL rather than a smoke spec (AGENTS.md rule 4).
//
// What these tests pin is the WIRING, not the arithmetic: every assertion is
// about which writes the component asks for. The numbers in those writes are
// src/lib/sidebar/file-sort-index.test.ts's job, and keeping the two apart is
// what lets the drag and the menu provably agree.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, within, fireEvent } from "@testing-library/react"
import { ExpandableFileList } from "./ExpandableFileList"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import { EditorScrollProvider } from "@/context/EditorScrollContext"
import type { FileReference } from "@/lib/parsers/types"
import { SORT_INDEX_STEP, type SortIndexWrite } from "@/lib/sidebar/file-sort-index"

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
          {...props}
        />
      </EditorScrollProvider>
    </I18nProvider>,
  )
}

/** The draggable wrapper around a file's row. */
function slot(name: string): HTMLElement {
  const row = screen.getByRole("button", { name })
  const found = row.closest('[data-reorderable="true"]')
  if (!found) throw new Error(`no reorderable slot around "${name}"`)
  return found as HTMLElement
}

/** A DataTransfer stand-in: happy-dom's drag events carry none. */
function dataTransfer() {
  const store = new Map<string, string>()
  return {
    effectAllowed: "",
    dropEffect: "",
    setData: (k: string, v: string) => { store.set(k, v) },
    getData: (k: string) => store.get(k) ?? "",
  }
}

/** Drag `from` onto `to`, as a browser would. */
function dragOnto(from: string, to: string) {
  const dt = dataTransfer()
  fireEvent.dragStart(slot(from), { dataTransfer: dt })
  fireEvent.dragOver(slot(to), { dataTransfer: dt })
  fireEvent.drop(slot(to), { dataTransfer: dt })
}

// Every row's ⋯ trigger has the same accessible name, so it has to be found
// within that row. The popup itself portals out, hence screen-level queries
// for the items.
function openRowMenu(name: string) {
  const row = screen.getByRole("button", { name }).closest('[data-showcase="sidebar.file"]')
  if (!row) throw new Error(`no row element for "${name}"`)
  fireEvent.click(within(row as HTMLElement).getByRole("button", { name: "File actions" }))
}

beforeEach(() => {
  localStorage.clear()
  onReorderFiles = vi.fn<(writes: SortIndexWrite[]) => void>()
  HTMLElement.prototype.scrollIntoView = vi.fn()
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
})

describe("a drop into another group is refused", () => {
  const TWO_GROUPS = [
    ...PLACED_SEASON,
    file("Pilot", { corpusMarker: "Season 2", sortIndex: 0 }),
    file("Finale", { corpusMarker: "Season 2", sortIndex: SORT_INDEX_STEP }),
  ]

  it("says so visibly and changes nothing — no move, no corpus change", () => {
    renderList(TWO_GROUPS)
    const dt = dataTransfer()
    fireEvent.dragStart(slot("Episode 2"), { dataTransfer: dt })
    fireEvent.dragOver(slot("Pilot"), { dataTransfer: dt })

    // Visible, not just a cursor shape: a silent no-op is indistinguishable
    // from a drop that failed.
    expect(screen.getByRole("status")).toHaveTextContent(/only be reordered inside its own group/i)

    fireEvent.drop(slot("Pilot"), { dataTransfer: dt })
    expect(onReorderFiles).not.toHaveBeenCalled()
  })

  it("clears the refusal once the drag ends", () => {
    renderList(TWO_GROUPS)
    const dt = dataTransfer()
    fireEvent.dragStart(slot("Episode 2"), { dataTransfer: dt })
    fireEvent.dragOver(slot("Pilot"), { dataTransfer: dt })
    expect(screen.queryByRole("status")).not.toBeNull()
    fireEvent.dragEnd(slot("Episode 2"))
    expect(screen.queryByRole("status")).toBeNull()
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

describe("a group of one", () => {
  it("offers no reorder — there is nowhere to move the file to", () => {
    renderList([file("Only", { corpusMarker: "Season 1", sortIndex: 0 })])
    expect(document.querySelector('[data-reorderable="true"]')).toBeNull()
    openRowMenu("Only")
    expect(screen.queryByRole("menuitem", { name: "Move up" })).toBeNull()
  })
})

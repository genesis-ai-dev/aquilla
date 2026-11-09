/**
 * AQU-2310: correcting milestones from the chapter navigator.
 *
 * What is pinned here:
 *
 *   - WHICH ROWS CAN BE EDITED, AND HOW. A hand-set milestone offers Rename…,
 *     Edit range… and Remove; an app-made "Part N" offers Rename… only; a
 *     chapter the file supplied offers nothing — and neither does a 50-cell
 *     jump range.
 *   - THE CONTROL NEVER NAVIGATES. Clicking it opens the menu; it must not also
 *     select the row it sits on.
 *   - BELOW THE FLOOR THERE IS NOTHING: no control on any row, and no
 *     "New milestone…" entry. The navigator draws them only when handed
 *     `editing`, which the table passes only at or above the floor.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import {
  MilestoneNavigator,
  type MilestoneNavigationItem,
  type MilestoneNavigatorEditing,
} from "./ChapterNavigator"

afterEach(cleanup)

const progress = { translated: 0, validated: 0, total: 10 }

/** A plain-text file: Part 1 · The storm · Part 2. */
const plainText: MilestoneNavigationItem[] = [
  { key: "part:c0", kind: "part", label: "Part 1", shortLabel: "1", description: "49 lines", ...progress },
  { key: "user:m-storm", kind: "user", label: "The storm", shortLabel: "◆", description: "21 lines", ...progress },
  { key: "part:c0#2", kind: "part", label: "Part 2", shortLabel: "2", description: "30 lines", ...progress },
]

/** Mark 3 · Mark 4 (with "The calming of the storm" nested) — the file's own chapters. */
const scripture: MilestoneNavigationItem[] = [
  {
    key: "scripture:MRK:3", kind: "chapter", label: "Mark 3", shortLabel: "3", description: "Verses 1–35", ...progress,
    subsections: [
      { key: "scripture:MRK:3:range:a", label: "1–35", firstCellId: "a", ...progress },
    ],
  },
  {
    key: "scripture:MRK:4", kind: "chapter", label: "Mark 4", shortLabel: "4", description: "Verses 1–41", ...progress,
    subsections: [
      { key: "user:m-calm", label: "The calming of the storm", firstCellId: "m4-35", ...progress },
    ],
  },
]

function draw(items: MilestoneNavigationItem[], activeKey: string, editing?: MilestoneNavigatorEditing) {
  const onSelect = vi.fn()
  render(
    <MilestoneNavigator items={items} activeKey={activeKey} onSelect={onSelect} editing={editing} />,
  )
  return { onSelect }
}

function editingSpy() {
  return { onAction: vi.fn(), onNew: vi.fn() } satisfies MilestoneNavigatorEditing
}

function openList() {
  fireEvent.click(screen.getAllByRole("combobox")[0])
}

/** The option row whose title reads `label`. */
function row(label: string): HTMLElement {
  const option = screen.getAllByRole("option").find((el) => el.textContent?.includes(label))
  if (!option) throw new Error(`no row for ${label}`)
  return option
}

function openRowMenu(label: string) {
  const control = within(row(label)).getByTestId("milestone-row-edit")
  fireEvent.pointerDown(control)
  fireEvent.mouseDown(control)
  fireEvent.mouseUp(control)
  fireEvent.click(control)
}

async function menuEntries(): Promise<string[]> {
  const menu = await screen.findByTestId("milestone-row-menu")
  return within(menu).getAllByRole("menuitem").map((item) => item.textContent ?? "")
}

describe("MilestoneNavigator — editing (AQU-2310)", () => {
  it("offers rename, edit range and remove on a hand-set milestone", async () => {
    draw(plainText, "part:c0", editingSpy())
    openList()
    openRowMenu("The storm")
    expect(await menuEntries()).toEqual(["Rename…", "Edit range…", "Remove"])
  })

  it("offers only rename on an app-made part", async () => {
    draw(plainText, "part:c0", editingSpy())
    openList()
    openRowMenu("Part 1")
    expect(await menuEntries()).toEqual(["Rename…"])
  })

  it("names the row the control is on, for a screen reader", () => {
    draw(plainText, "part:c0", editingSpy())
    openList()
    expect(within(row("Part 2")).getByTestId("milestone-row-edit"))
      .toHaveAccessibleName("Edit “Part 2”")
  })

  it("hands back the row's key and the chosen action", async () => {
    const editing = editingSpy()
    const { onSelect } = draw(plainText, "part:c0", editing)
    openList()
    openRowMenu("The storm")
    fireEvent.click(await screen.findByTestId("milestone-row-editRange"))
    expect(editing.onAction).toHaveBeenCalledWith("user:m-storm", "editRange")
    // The control never navigates to the row it sits on.
    expect(onSelect).not.toHaveBeenCalled()
  })

  it("puts no control on a chapter the file supplied", () => {
    draw(scripture, "scripture:MRK:3", editingSpy())
    openList()
    expect(within(row("Mark 3")).queryByTestId("milestone-row-edit")).toBeNull()
    // Nor on its 50-cell jump range, listed under the expanded chapter.
    expect(within(row("1–35")).queryByTestId("milestone-row-edit")).toBeNull()
  })

  it("puts the full control on a hand-set milestone nested under a chapter", async () => {
    const editing = editingSpy()
    draw(scripture, "scripture:MRK:4", editing)
    openList()
    expect(within(row("Mark 4")).queryByTestId("milestone-row-edit")).toBeNull()
    openRowMenu("The calming of the storm")
    expect(await menuEntries()).toEqual(["Rename…", "Edit range…", "Remove"])
    fireEvent.click(await screen.findByTestId("milestone-row-remove"))
    expect(editing.onAction).toHaveBeenCalledWith("user:m-calm", "remove")
  })

  it("opens the empty form from New milestone…", () => {
    const editing = editingSpy()
    draw(plainText, "part:c0", editing)
    openList()
    fireEvent.click(screen.getByTestId("milestone-new"))
    expect(editing.onNew).toHaveBeenCalledTimes(1)
  })

  it("has no control on any row and no New milestone… below the floor", () => {
    draw(plainText, "part:c0")
    openList()
    expect(screen.queryAllByTestId("milestone-row-edit")).toHaveLength(0)
    expect(screen.queryByTestId("milestone-new")).toBeNull()
  })
})

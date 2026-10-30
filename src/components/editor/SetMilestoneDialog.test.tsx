/**
 * AQU-2308: the "Set a new milestone…" dialog.
 *
 * What is pinned here:
 *
 *   - IT OPENS ON THE RANGE IT WAS GIVEN — the clicked row, or a shift-click
 *     selection's two edges — so the gesture is not thrown away.
 *   - THE END PICKER DOES NOT OFFER A CELL BEFORE THE START. Not disabled:
 *     absent. A backwards range is not a choice someone is weighing.
 *   - MOVING THE START PAST THE END CLEARS THE END rather than dragging it
 *     along, because where the range should now finish is the person's call.
 *   - EVERY REFUSAL NAMES WHAT IT CLASHES WITH, and comes from
 *     `refusalForUserMilestone` — the same function the navigator derivation
 *     consults, so the dialog cannot refuse a range the derivation would have
 *     accepted or accept one it would silently skip.
 *   - A BLANK NAME HOLDS THE SAVE BUTTON WITHOUT SCOLDING. Not having typed yet
 *     is the opening state, not a mistake.
 */

import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { SetMilestoneDialog } from "./SetMilestoneDialog"
import { milestoneDraftCells, divisionsForOrder } from "@/lib/editor/milestone-draft"
import type { FileMilestone } from "../../../db/shared/file-milestones"

const ORDER = ["c1", "c2", "c3", "c4", "c5"]

const TEXT: Record<string, string> = {
  c1: "Now it came to pass",
  c2: "that a great storm arose",
  c3: "and he was asleep",
  c4: "and they woke him",
  c5: "and there was a great calm",
}

const CELLS = milestoneDraftCells(ORDER, (id) => ({ text: TEXT[id] }))

/** c1–c2 is a division the APP invented; c3–c5 one the FILE supplied. */
const DIVISIONS = divisionsForOrder(ORDER, [
  { key: "part:1", label: "Part 1", shortLabel: "1", kind: "part", cellIds: ["c1", "c2"] },
  { key: "scripture:MRK:4", label: "Mark 4", shortLabel: "4", kind: "chapter", cellIds: ["c3", "c4", "c5"] },
])

function draw(over: Partial<Parameters<typeof SetMilestoneDialog>[0]> = {}) {
  const onSubmit = vi.fn()
  const onDismiss = vi.fn()
  render(
    <SetMilestoneDialog
      onDismiss={onDismiss}
      cells={CELLS}
      divisions={DIVISIONS}
      existing={[]}
      initialStartCellId="c1"
      initialEndCellId="c1"
      onSubmit={onSubmit}
      {...over}
    />,
  )
  return { onSubmit, onDismiss }
}

const save = () => screen.getByTestId("set-milestone-save")
const refusal = () => screen.queryByTestId("set-milestone-refusal")

const openPicker = async (
  user: ReturnType<typeof userEvent.setup>,
  which: "start" | "end",
) => {
  await user.click(screen.getByTestId(`set-milestone-${which}`))
  // By placeholder, not by role+name: the popup's accessible name is the
  // primitive's own generic one, while the placeholder is this picker's.
  return await screen.findByPlaceholderText("Search this file's lines")
}

const pick = async (
  user: ReturnType<typeof userEvent.setup>,
  which: "start" | "end",
  cellId: string,
) => {
  await openPicker(user, which)
  await user.click(await screen.findByTestId(`set-milestone-${which}-${cellId}`))
}

describe("SetMilestoneDialog", () => {
  it("opens on the range it was handed, both edges filled", () => {
    draw({ initialStartCellId: "c2", initialEndCellId: "c4" })
    expect(screen.getByTestId("set-milestone-start"))
      .toHaveTextContent("2 · that a great storm arose")
    expect(screen.getByTestId("set-milestone-end"))
      .toHaveTextContent("4 · and they woke him")
  })

  it("holds the save button on a blank name, and says nothing about it", async () => {
    const user = userEvent.setup()
    draw({ initialStartCellId: "c1", initialEndCellId: "c2" })
    expect(save()).toBeDisabled()
    expect(refusal()).toBeNull()

    // Whitespace alone is not a name — the SHARED rule, the same one the
    // server's handler applies.
    await user.type(screen.getByTestId("set-milestone-name"), "   ")
    expect(save()).toBeDisabled()
    expect(refusal()).toBeNull()
  })

  it("submits the name and both edges once the draft is legal", async () => {
    const user = userEvent.setup()
    const { onSubmit } = draw({ initialStartCellId: "c1", initialEndCellId: "c2" })
    await user.type(screen.getByTestId("set-milestone-name"), "The storm")
    expect(save()).toBeEnabled()
    await user.click(save())
    expect(onSubmit).toHaveBeenCalledWith({
      name: "The storm",
      startCellId: "c1",
      endCellId: "c2",
    })
  })

  it("does not offer any line before the start in the end picker", async () => {
    const user = userEvent.setup()
    draw({ initialStartCellId: "c3", initialEndCellId: "c3" })
    await openPicker(user, "end")
    expect(await screen.findByTestId("set-milestone-end-c3")).toBeInTheDocument()
    expect(screen.getByTestId("set-milestone-end-c4")).toBeInTheDocument()
    expect(screen.queryByTestId("set-milestone-end-c1")).toBeNull()
    expect(screen.queryByTestId("set-milestone-end-c2")).toBeNull()
  })

  it("clears the end when the start moves past it", async () => {
    const user = userEvent.setup()
    draw({ initialStartCellId: "c1", initialEndCellId: "c2" })
    await user.type(screen.getByTestId("set-milestone-name"), "The storm")
    expect(save()).toBeEnabled()

    await pick(user, "start", "c4")
    expect(screen.getByTestId("set-milestone-end")).toHaveTextContent("Pick the last line")
    // A half-picked range holds the button without a message: the person is
    // mid-choice, not mistaken.
    expect(save()).toBeDisabled()
    expect(refusal()).toBeNull()
  })

  it("leaves the end alone when the start moves but stays before it", async () => {
    const user = userEvent.setup()
    draw({ initialStartCellId: "c1", initialEndCellId: "c4" })
    await pick(user, "start", "c2")
    expect(screen.getByTestId("set-milestone-end"))
      .toHaveTextContent("4 · and they woke him")
  })

  it("refuses a range that crosses a division the file supplied, naming it", async () => {
    const user = userEvent.setup()
    const { onSubmit } = draw({ initialStartCellId: "c2", initialEndCellId: "c3" })
    await user.type(screen.getByTestId("set-milestone-name"), "The storm")

    expect(refusal()).toHaveTextContent("Mark 4")
    expect(save()).toBeDisabled()
    await user.click(save())
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it("accepts a range wholly inside a division the file supplied — it nests", async () => {
    const user = userEvent.setup()
    draw({ initialStartCellId: "c3", initialEndCellId: "c4" })
    await user.type(screen.getByTestId("set-milestone-name"), "The calming of the storm")
    expect(refusal()).toBeNull()
    expect(save()).toBeEnabled()
  })

  it("refuses a range overlapping an existing milestone, naming that one", async () => {
    const user = userEvent.setup()
    const existing: FileMilestone[] = [
      { id: "m-1", name: "The storm", startCellId: "c1", endCellId: "c2" },
    ]
    draw({ existing, initialStartCellId: "c2", initialEndCellId: "c2" })
    await user.type(screen.getByTestId("set-milestone-name"), "Another one")

    expect(refusal()).toHaveTextContent("The storm")
    expect(save()).toBeDisabled()
  })

  it("lets a range start where an existing milestone ended + 1", async () => {
    const user = userEvent.setup()
    const existing: FileMilestone[] = [
      { id: "m-1", name: "The storm", startCellId: "c1", endCellId: "c2" },
    ]
    draw({ existing, initialStartCellId: "c3", initialEndCellId: "c4" })
    await user.type(screen.getByTestId("set-milestone-name"), "The calming")
    expect(refusal()).toBeNull()
    expect(save()).toBeEnabled()
  })

  it("can be dismissed without writing anything", async () => {
    const user = userEvent.setup()
    const { onDismiss, onSubmit } = draw()
    await user.click(screen.getByRole("button", { name: "Cancel" }))
    expect(onDismiss).toHaveBeenCalled()
    expect(onSubmit).not.toHaveBeenCalled()
  })
})

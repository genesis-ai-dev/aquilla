/**
 * AQU-2310: the "Set a new milestone…" dialog, opened from the chapter
 * navigator to correct a milestone rather than make one.
 *
 * What is pinned here:
 *
 *   - RENAME LOCKS THE RANGE. Renaming "Part 1" has to cover exactly the cells
 *     Part 1 covered, so the pickers are shown (the person sees which lines
 *     they are naming) but cannot be changed.
 *   - CLEARING A NAME IS REFUSED, AND SAID. On a new milestone a blank name is
 *     the opening state; on one being renamed it is a mistake, and the old
 *     name is kept.
 *   - AN EDIT THAT CHANGES NOTHING DOES NOT SAVE — it would write an event
 *     that changes nothing, or a hand-set milestone called "Part 1".
 *   - EDIT RANGE DOES NOT REFUSE A MILESTONE FOR OVERLAPPING ITSELF, and still
 *     refuses overlapping a different one, by name.
 *   - "NEW MILESTONE…" OPENS EMPTY: no name, no first line, no last line.
 */

import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { SetMilestoneDialog } from "./SetMilestoneDialog"
import { milestoneDraftCells, divisionsForOrder } from "@/lib/editor/milestone-draft"
import type { FileMilestone } from "../../../db/shared/file-milestones"

const ORDER = ["c1", "c2", "c3", "c4", "c5", "c6"]
const CELLS = milestoneDraftCells(ORDER, (id) => ({ text: `line ${id}` }))

const STORM: FileMilestone = { id: "m-storm", name: "The storm", startCellId: "c3", endCellId: "c4" }
const OPENING: FileMilestone = { id: "m-open", name: "Opening", startCellId: "c1", endCellId: "c1" }

/**
 * The navigator as the dialog receives it: AFTER hand-set milestones, so the
 * cells a milestone holds read as its own `user:` division.
 */
const DIVISIONS = divisionsForOrder(ORDER, [
  { key: "user:m-open", label: "Opening", shortLabel: "◆", kind: "user", cellIds: ["c1"] },
  { key: "part:c2", label: "Part 1", shortLabel: "1", kind: "part", cellIds: ["c2"] },
  { key: "user:m-storm", label: "The storm", shortLabel: "◆", kind: "user", cellIds: ["c3", "c4"] },
  { key: "part:c2#2", label: "Part 2", shortLabel: "2", kind: "part", cellIds: ["c5", "c6"] },
])

function draw(over: Partial<Parameters<typeof SetMilestoneDialog>[0]> = {}) {
  const onSubmit = vi.fn()
  render(
    <SetMilestoneDialog
      onDismiss={vi.fn()}
      cells={CELLS}
      divisions={DIVISIONS}
      existing={[OPENING, STORM]}
      initialStartCellId={STORM.startCellId}
      initialEndCellId={STORM.endCellId}
      onSubmit={onSubmit}
      {...over}
    />,
  )
  return { onSubmit }
}

const save = () => screen.getByTestId("set-milestone-save")
const nameField = () => screen.getByTestId("set-milestone-name")

async function pickEnd(user: ReturnType<typeof userEvent.setup>, cellId: string) {
  await user.click(screen.getByTestId("set-milestone-end"))
  await screen.findByPlaceholderText("Search this file's lines")
  await user.click(await screen.findByTestId(`set-milestone-end-${cellId}`))
}

describe("SetMilestoneDialog — rename", () => {
  const renameStorm = { mode: "rename" as const, milestoneId: STORM.id, initialName: STORM.name }

  it("opens on the name and range it has, with the range locked", () => {
    draw(renameStorm)
    expect(screen.getByRole("heading", { name: "Rename “The storm”" })).toBeInTheDocument()
    expect(nameField()).toHaveValue("The storm")
    expect(screen.getByTestId("set-milestone-start")).toBeDisabled()
    expect(screen.getByTestId("set-milestone-end")).toBeDisabled()
    expect(screen.getByTestId("set-milestone-start")).toHaveTextContent("3 · line c3")
    expect(screen.getByTestId("set-milestone-end")).toHaveTextContent("4 · line c4")
  })

  it("does not save until the name actually changes", async () => {
    const user = userEvent.setup()
    const { onSubmit } = draw(renameStorm)
    expect(save()).toBeDisabled()

    await user.clear(nameField())
    await user.type(nameField(), "Calming the storm")
    expect(save()).toBeEnabled()
    await user.click(save())
    expect(onSubmit).toHaveBeenCalledWith({
      name: "Calming the storm",
      startCellId: "c3",
      endCellId: "c4",
    })
  })

  it.each(["", "   "])("refuses the blank name %o and says so", async (blank) => {
    const user = userEvent.setup()
    const { onSubmit } = draw(renameStorm)
    await user.clear(nameField())
    if (blank) await user.type(nameField(), blank)

    expect(screen.getByTestId("set-milestone-name-refusal")).toHaveTextContent("needs a name")
    expect(save()).toBeDisabled()
    await user.type(nameField(), "{Enter}")
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it("renames an app-made part over exactly its cells, as a NEW record", async () => {
    const user = userEvent.setup()
    const { onSubmit } = draw({
      mode: "rename",
      initialName: "Part 2",
      initialStartCellId: "c5",
      initialEndCellId: "c6",
    })
    // Unchanged, renaming "Part 2" to "Part 2" would mint a hand-set milestone
    // that only looks like the app's.
    expect(save()).toBeDisabled()
    await user.clear(nameField())
    await user.type(nameField(), "The calm")
    await user.click(save())
    expect(onSubmit).toHaveBeenCalledWith({ name: "The calm", startCellId: "c5", endCellId: "c6" })
  })
})

describe("SetMilestoneDialog — edit range", () => {
  const editStorm = { mode: "editRange" as const, milestoneId: STORM.id, initialName: STORM.name }

  it("lets a milestone grow into the app-made part beside it", async () => {
    const user = userEvent.setup()
    const { onSubmit } = draw(editStorm)
    expect(screen.getByRole("heading", { name: "Edit “The storm”" })).toBeInTheDocument()
    expect(save()).toBeDisabled()

    await pickEnd(user, "c5")
    expect(screen.queryByTestId("set-milestone-refusal")).toBeNull()
    expect(save()).toBeEnabled()
    await user.click(save())
    expect(onSubmit).toHaveBeenCalledWith({ name: "The storm", startCellId: "c3", endCellId: "c5" })
  })

  it("still refuses running into a different milestone, naming it", async () => {
    const user = userEvent.setup()
    draw({ ...editStorm, initialStartCellId: "c1", initialEndCellId: "c4" })
    expect(screen.getByTestId("set-milestone-refusal")).toHaveTextContent("Opening")
    expect(save()).toBeDisabled()
    // Pulling the start back off Opening clears the refusal.
    await user.click(screen.getByTestId("set-milestone-start"))
    await screen.findByPlaceholderText("Search this file's lines")
    await user.click(await screen.findByTestId("set-milestone-start-c2"))
    expect(screen.queryByTestId("set-milestone-refusal")).toBeNull()
  })
})

describe("SetMilestoneDialog — New milestone…", () => {
  it("opens with nothing filled in", () => {
    draw({ initialStartCellId: "", initialEndCellId: "" })
    expect(screen.getByRole("heading", { name: "Set a new milestone" })).toBeInTheDocument()
    expect(nameField()).toHaveValue("")
    expect(screen.getByTestId("set-milestone-start")).toHaveTextContent("Pick the first line")
    expect(screen.getByTestId("set-milestone-end")).toHaveTextContent("Pick the last line")
    expect(save()).toBeDisabled()
    // Not having typed yet is not a mistake.
    expect(screen.queryByTestId("set-milestone-name-refusal")).toBeNull()
  })
})
